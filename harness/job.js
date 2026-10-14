'use strict';

/**
 * `openvibe-codes job`: one coding task as an OpenVibe Run job on the person's own machine (plan T16; the Node's job
 * worker runs it in its sandbox as artifact `openvibe-codes@1.0.0`, JOB_PROTOCOL below). The job's input is one JSON
 * line on stdin:
 *
 *   { repo, ref?, prompt, agent?, model?, permission?: 'edit'|'full', push?: { branch?, pull_request? } }
 *
 * It clones `repo` (https only) into a scratch directory, runs the harness there with hand-offs, and prints one compact
 * JSON line per event on stdout (what the page shows live). The result goes to fd 3 (the Node's result channel), or as
 * a last `{ t: 'result_doc' }` line when fd 3 is not open: what the agents said, the changed files and the patch, and,
 * when `push` is asked and the machine holds GITHUB_TOKEN, the new branch it pushed (never the base branch) and its
 * pull request. Nothing here ever prints a token.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const JOB_PROTOCOL = '1.0.0';
const MAX_PROMPT = 16_000;
const MAX_PATCH = 180_000;
const MAX_TEXT = 2_000;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;

/** git with no prompt and no credential helper; rejects with the command's stderr (tokens scrubbed). */
function git(args, { cwd, env = {}, timeout = 120_000 } = {}) {
    return new Promise((resolve, reject) => {
        execFile('git', args, {
            cwd, timeout, maxBuffer: 32 * 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', ...env },
        }, (err, stdout, stderr) => {
            if (err) reject(new Error(scrub(String(stderr || err.message)).trim().split('\n').slice(-3).join(' ')));
            else resolve(String(stdout));
        });
    });
}

/** Any credential an URL or a message might carry, replaced. */
function scrub(s) {
    return String(s).replace(/(https?:\/\/)[^@/\s]+@/g, '$1***@').replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '***');
}

/** The job's input checked: a public https repository (file:// only when OPENVIBE_CODES_ALLOW_FILE_REPO=1, for tests). */
function parseArgs(raw, env = process.env) {
    let a;
    try { a = JSON.parse(String(raw || '').trim() || '{}'); } catch { throw new Error('the job input is not JSON'); }
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('the job input must be an object');
    let repo;
    try { repo = new URL(String(a.repo || '')); } catch { throw new Error('repo must be a repository URL'); }
    const fileOk = env.OPENVIBE_CODES_ALLOW_FILE_REPO === '1' && repo.protocol === 'file:';
    if (!fileOk && repo.protocol !== 'https:') throw new Error('repo must be an https URL');
    if (repo.username || repo.password) throw new Error('repo must not carry credentials');
    const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : '';
    if (!prompt || prompt.length > MAX_PROMPT) throw new Error(`prompt must be 1-${MAX_PROMPT} characters`);
    const ref = a.ref == null || a.ref === '' ? null : String(a.ref);
    if (ref && !BRANCH.test(ref)) throw new Error('ref must be a branch or tag name');
    const permission = a.permission === 'full' ? 'full' : 'edit';
    const push = a.push && typeof a.push === 'object' ? {
        branch: a.push.branch == null ? null : String(a.push.branch),
        pull_request: a.push.pull_request === true,
    } : null;
    if (push && push.branch && (!BRANCH.test(push.branch) || push.branch.startsWith('-'))) throw new Error('push.branch must be a branch name');
    return {
        repo: repo.toString(), ref, prompt, permission, push,
        agent: typeof a.agent === 'string' && /^[a-z0-9-]{1,40}$/.test(a.agent) ? a.agent : null,
        model: typeof a.model === 'string' && a.model.length <= 100 ? a.model : null,
    };
}

/** One harness event as a short line the page can show (long text cut, tool inputs reduced to what they touch). */
function compact(e) {
    const cut = (s) => { const t = String(s || ''); return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t; };
    if (e.type === 'system' && e.subtype === 'init') return { t: 'agent', agent: e.agent, model: e.model || null };
    if (e.type === 'system' && e.subtype === 'handoff') return { t: 'handoff', from: e.from, reason: cut(e.reason) };
    if (e.type === 'system' && (e.subtype === 'error' || e.subtype === 'warning')) return { t: 'note', text: cut(e.text) };
    if (e.type === 'assistant') {
        const out = [];
        for (const c of (e.message && e.message.content) || []) {
            if (c.type === 'text' && c.text) out.push({ t: 'text', text: cut(c.text) });
            if (c.type === 'tool_use') {
                const i = c.input || {};
                const what = i.command || i.file_path || i.path || i.pattern || i.query || i.description || '';
                out.push({ t: 'tool', name: String(c.name || ''), what: cut(String(what).split('\n')[0]).slice(0, 200) });
            }
        }
        return out;
    }
    if (e.type === 'result') {
        return { t: 'done', ok: !e.is_error, text: cut(e.result), duration_ms: e.duration_ms || 0, cost_usd: e.total_cost_usd || 0 };
    }
    return null;
}

/** What changed: per-file counts and the patch (new files included), cut to fit the result channel. */
async function changes(dir) {
    await git(['add', '-A'], { cwd: dir });
    const numstat = await git(['diff', '--cached', '--numstat'], { cwd: dir });
    const files = numstat.split('\n').filter(Boolean).slice(0, 500).map((line) => {
        const [added, removed, ...p] = line.split('\t');
        return { path: p.join('\t'), added: added === '-' ? null : Number(added), removed: removed === '-' ? null : Number(removed) };
    });
    const patch = files.length ? await git(['diff', '--cached', '--no-color'], { cwd: dir }) : '';
    return { files, patch: patch.length > MAX_PATCH ? patch.slice(0, MAX_PATCH) : patch, patch_truncated: patch.length > MAX_PATCH };
}

/** github.com/<owner>/<name> of an https URL, or null. */
function githubRepo(url) {
    const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url);
    return m ? { owner: m[1], name: m[2] } : null;
}

/** Commit on a new branch and push it with GITHUB_TOKEN (never the base branch); a pull request when asked. */
async function pushBranch(dir, job, { env, fetchImpl, base }) {
    const token = env.GITHUB_TOKEN;
    const gh = githubRepo(job.repo);
    if (!token || !gh) return { pushed: false, reason: !gh ? 'push is for github.com repositories' : 'this machine has no GITHUB_TOKEN' };
    const branch = job.push.branch || `openvibe-codes/${Date.now().toString(36)}`;
    if (branch === base) return { pushed: false, reason: 'a task never pushes to the branch it started from' };
    const who = {
        GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME || 'OpenVibe.Codes', GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL || 'codes@openvibe.codes',
        GIT_COMMITTER_NAME: env.GIT_AUTHOR_NAME || 'OpenVibe.Codes', GIT_COMMITTER_EMAIL: env.GIT_AUTHOR_EMAIL || 'codes@openvibe.codes',
    };
    await git(['checkout', '-b', branch], { cwd: dir });
    await git(['commit', '-m', job.prompt.split('\n')[0].slice(0, 72) || 'OpenVibe.Codes task'], { cwd: dir, env: who });
    const remote = `https://x-access-token:${token}@github.com/${gh.owner}/${gh.name}.git`;
    await git(['push', remote, `HEAD:refs/heads/${branch}`], { cwd: dir, timeout: 180_000 });
    const out = { pushed: true, branch, branch_url: `https://github.com/${gh.owner}/${gh.name}/tree/${encodeURIComponent(branch)}` };
    if (job.push.pull_request) {
        const r = await fetchImpl(`https://api.github.com/repos/${gh.owner}/${gh.name}/pulls`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'openvibe-codes' },
            body: JSON.stringify({ title: job.prompt.split('\n')[0].slice(0, 120), head: branch, base, body: `Made with OpenVibe.Codes on the requester's own machine.\n\n${job.prompt.slice(0, 4000)}` }),
            signal: AbortSignal.timeout(30_000),
        }).catch(() => null);
        const doc = r ? await r.json().catch(() => null) : null;
        if (r && r.ok && doc && doc.html_url) out.pull_request = doc.html_url;
        else out.pull_request_error = r ? `GitHub answered ${r.status}` : 'GitHub did not answer';
    }
    return out;
}

/**
 * Run one job. `harness` is createHarness(); `emit(line)` prints a line; `writeResult(doc)` hands the result over.
 * → the result document.
 */
async function runJob({ input, harness, emit, writeResult, env = process.env, tmp = os.tmpdir(), fetchImpl = globalThis.fetch }) {
    const started = Date.now();
    const say = (doc) => emit(JSON.stringify(doc));
    let job;
    try {
        job = parseArgs(input, env);
    } catch (e) {
        const doc = { protocol: JOB_PROTOCOL, ok: false, error: e.message };
        say({ t: 'note', text: e.message });
        writeResult(doc);
        return doc;
    }
    const dir = fs.mkdtempSync(path.join(tmp, 'codes-'));
    const work = path.join(dir, 'repo');
    const result = { protocol: JOB_PROTOCOL, ok: false, repo: scrub(job.repo), ref: job.ref, agents: [], summary: '' };
    try {
        say({ t: 'step', text: `Cloning ${scrub(job.repo)}${job.ref ? ` (${job.ref})` : ''}` });
        await git(['clone', '--depth', '50', ...(job.ref ? ['--branch', job.ref] : []), '--', job.repo, work], { timeout: 300_000 });
        const base = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: work })).trim();
        result.base = base;
        say({ t: 'step', text: `Working on ${base}` });
        const run = harness.run({
            prompt: job.prompt, task: 'edit', agent: job.agent, model: job.model, cwd: work,
            permission: job.permission, handoff: !job.agent, maxAttempts: 3,
        });
        let last = null;
        for await (const e of run) {
            last = e;
            const c = compact(e);
            for (const line of Array.isArray(c) ? c : c ? [c] : []) say(line);
            if (e.type === 'system' && e.subtype === 'init' && e.agent && !result.agents.includes(e.agent)) result.agents.push(e.agent);
        }
        result.ok = !!(last && last.type === 'result' && !last.is_error);
        result.summary = last && typeof last.result === 'string' ? last.result.slice(0, 4000) : '';
        result.cost_usd = last && last.total_cost_usd ? last.total_cost_usd : 0;
        Object.assign(result, await changes(work));
        say({ t: 'step', text: result.files.length ? `${result.files.length} file${result.files.length === 1 ? '' : 's'} changed` : 'No files changed' });
        if (job.push && result.ok && result.files.length) {
            say({ t: 'step', text: 'Pushing a new branch' });
            try {
                result.push = await pushBranch(work, job, { env, fetchImpl, base });
            } catch (e) {
                result.push = { pushed: false, reason: scrub(e.message) };
            }
            say({ t: 'step', text: result.push.pushed ? `Pushed ${result.push.branch}` : `Not pushed: ${result.push.reason}` });
        }
    } catch (e) {
        result.error = scrub(e.message);
        say({ t: 'note', text: result.error });
    } finally {
        result.duration_ms = Date.now() - started;
        fs.rmSync(dir, { recursive: true, force: true });
    }
    writeResult(result);
    return result;
}

/** The Node's result channel is fd 3; outside a job the result is the last stdout line. */
function resultWriter(emit) {
    return (doc) => {
        const text = JSON.stringify(doc);
        try {
            fs.writeSync(3, text);
        } catch {
            emit(JSON.stringify({ t: 'result_doc', result: doc }));
        }
    };
}

module.exports = { runJob, parseArgs, compact, resultWriter, scrub, githubRepo, JOB_PROTOCOL };
