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
const { collectProof } = require('../engine/proof');

const JOB_PROTOCOL = '1.0.0';   // the job's contract with the Node (stdin, stdout lines, fd 3): unchanged by 1.1's lines
const LINES = '1.1';            // 1.1: lines carry step ids, inputs, results, progress, helpers; the result keeps `log`
const MAX_PROMPT = 16_000;
const MAX_PATCH = 180_000;
const MAX_TEXT = 2_000;
const MAX_OUTPUT = 4_000;    // a step's output on a line (live)
const MAX_LOG = 240_000;     // the session log kept in the result (its outputs cut shorter when it would not fit)
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

// Branches a task never pushes to, whatever it names (plan §9 gate: Codes never writes a protected branch directly). The
// check that matters is that the branch does not exist yet (pushBranch asks GitHub); these names are refused before
// anything is asked.
const PROTECTED = /^(main|master|trunk|dev|develop|development|staging|stage|production|prod|stable|live|gh-pages|release|releases|hotfix)([/-].*)?$/i;

/**
 * The branch a task may push: a new one. → { branch } or { refused }. `exists` is GitHub's answer for that name (true
 * when it already exists, null when GitHub could not be asked: refused too, never assumed new).
 */
function pushTarget(requested, base, { exists = false, now = Date.now() } = {}) {
    const branch = requested || `openvibe-codes/${now.toString(36)}`;
    if (branch === base) return { refused: 'a task never pushes to the branch it started from' };
    if (PROTECTED.test(branch)) return { refused: `a task pushes only a new branch of its own, never ${branch}` };
    if (exists === null) return { refused: 'GitHub could not say whether the branch exists, so nothing was pushed' };
    if (exists) return { refused: `${branch} already exists: a task pushes only a new branch` };
    return { branch };
}

/** Any credential an URL or a message might carry, replaced. */
function scrub(s) {
    return String(s).replace(/(https?:\/\/)[^@/\s]+@/g, '$1***@').replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '***');
}

/**
 * The environment a job may set for the harness (Codes C3): the model APIs' own names, nothing else. A run token
 * travels this way (the job's input carries it, the harness's process gets it), so only these names are read from
 * the job's input: everything else in it is ignored.
 */
const ENV_NAMES = new Set([
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_MODEL',
    'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_CUSTOM_HEADERS',
    'DEEPSEEK_BASE_URL', 'DEEPSEEK_API_KEY',
    'OPENVIBE_AI_URL', 'OPENVIBE_AI_TOKEN', 'OPENVIBE_CODES_BASE_URL', 'OPENVIBE_CODES_API_KEY',
    'OPENVIBE_CODES_MODEL', 'OPENVIBE_CODES_HEADERS',
]);

/** The environment a job's input asks for: the allowlisted names only, each a short string. */
function jobEnv(input) {
    const out = {};
    const a = input && typeof input === 'object' && !Array.isArray(input) ? input.env : null;
    if (!a || typeof a !== 'object' || Array.isArray(a)) return out;
    for (const [k, v] of Object.entries(a)) {
        if (!ENV_NAMES.has(k)) continue;
        if (typeof v !== 'string' || !v || v.length > 4000) continue;
        out[k] = v;
    }
    return out;
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
    // review is a read-only task (research, an audit, a review): the harness's own `read` level.
    const asked = a.permission === 'review' || a.permission === 'read' ? 'read' : a.permission;
    const permission = asked === 'full' ? 'full' : asked === 'read' ? 'read' : 'edit';
    const push = a.push && typeof a.push === 'object' ? {
        branch: a.push.branch == null ? null : String(a.push.branch),
        pull_request: a.push.pull_request === true,
    } : null;
    if (push && push.branch && (!BRANCH.test(push.branch) || push.branch.startsWith('-'))) throw new Error('push.branch must be a branch name');
    if (push && push.branch && PROTECTED.test(push.branch)) throw new Error(`push.branch must be a new branch of the task's own, never ${push.branch}`);
    // The session a resume continues: the job's own input, or RESUME in the environment (a task carried on in the
    // same conversation). It is a harness's session id, never a path and never a credential.
    const resumeIn = a.resume == null || a.resume === '' ? env.RESUME : a.resume;
    const resume = typeof resumeIn === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(resumeIn) ? resumeIn : null;
    const wanted = jobEnv(a);
    return {
        repo: repo.toString(), ref, prompt, permission, push,
        ...(resume ? { resume } : {}),
        ...(Object.keys(wanted).length ? { env: wanted } : {}),
        agent: typeof a.agent === 'string' && /^[a-z0-9-]{1,40}$/.test(a.agent) ? a.agent : null,
        model: typeof a.model === 'string' && a.model.length <= 100 ? a.model : null,
    };
}

/** A step's input as a reader needs it: what it ran or touched, an edit's change, the plan; every string cut and
 *  scrubbed of credentials, everything else left out. */
function stepInput(input) {
    const i = input && typeof input === 'object' ? input : {};
    const str = (v, n) => (typeof v === 'string' ? clean(cutTo(v, n)) : undefined);
    const out = {};
    const put = (k, v) => { if (v !== undefined && v !== '') out[k] = v; };
    put('command', str(i.command || i.cmd, 2000));
    put('description', str(i.description, 300));
    put('file_path', str(i.file_path || i.path || i.notebook_path, 300));
    put('pattern', str(i.pattern, 300));
    put('glob', str(i.glob, 200));
    put('query', str(i.query, 300));
    put('url', str(i.url, 500));
    put('old_string', str(i.old_string, MAX_OUTPUT));
    put('new_string', str(i.new_string, MAX_OUTPUT));
    put('content', str(i.content, MAX_OUTPUT));
    put('prompt', str(i.prompt, 1600));
    put('subagent_type', str(i.subagent_type, 60));
    if (Array.isArray(i.edits)) out.edits = i.edits.slice(0, 20).map((e) => ({ old_string: str(e && e.old_string, 2000) || '', new_string: str(e && e.new_string, 2000) || '' }));
    if (Array.isArray(i.todos)) out.todos = i.todos.slice(0, 30).map((t) => ({ content: str(t && t.content, 200) || '', status: str(t && t.status, 20) || 'pending', activeForm: str(t && t.activeForm, 200) }));
    return out;
}
// Every string a line carries goes through both scrubbers: the events one (provider keys, tokens, JWTs, private keys,
// key=… pairs) and this file's (credentials in URLs, GitHub tokens): CLI agents' output reaches here unscrubbed.
const clean = (s) => scrub(require('./events').scrub(s));
const cutTo = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const resultText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n') : c == null ? '' : String(c));

/**
 * One harness event as the lines a reader shows (job protocol 1.1, openvibe-shared/agent-session.js reads them):
 * agent, text, tool (with its id and input), tool_progress, tool_result (with its output), handoff, note, usage, done.
 * A line from a helper agent carries `parent`, the id of the Task step that started it. 1.0 readers keep working: the
 * fields they read are where they were.
 */
function compact(e) {
    const cut = (s) => cutTo(s, MAX_TEXT);
    const parent = e.parent_tool_use_id ? { parent: String(e.parent_tool_use_id) } : {};
    if (e.type === 'system' && e.subtype === 'init') return { t: 'agent', agent: e.agent, model: e.model || null, session: e.session_id || null };
    if (e.type === 'system' && e.subtype === 'handoff') return { t: 'handoff', from: e.from, ...(e.to ? { to: e.to } : {}), reason: cut(e.reason) };
    if (e.type === 'system' && (e.subtype === 'error' || e.subtype === 'warning')) return { t: 'note', level: e.subtype, text: cut(e.text) };
    if (e.type === 'system' && e.subtype === 'tool_progress') return { t: 'tool_progress', id: String(e.tool_use_id || ''), chunk: clean(cutTo(e.text, MAX_OUTPUT)) };
    if (e.type === 'system' && e.subtype === 'usage' && e.usage) return { t: 'usage', input_tokens: e.usage.input_tokens || 0, output_tokens: e.usage.output_tokens || 0 };
    if (e.type === 'assistant') {
        const out = [];
        for (const c of (e.message && e.message.content) || []) {
            if (c.type === 'text' && c.text) out.push({ t: 'text', text: clean(cut(c.text)), ...parent });
            if (c.type === 'tool_use') {
                const i = c.input || {};
                const what = i.command || i.file_path || i.path || i.pattern || i.query || i.description || '';
                out.push({ t: 'tool', id: String(c.id || ''), name: String(c.name || ''), what: clean(cut(String(what).split('\n')[0]).slice(0, 200)), input: stepInput(i), ...parent });
            }
        }
        return out;
    }
    if (e.type === 'user' && e.message && Array.isArray(e.message.content)) {
        return e.message.content.filter((c) => c && c.type === 'tool_result')
            .map((c) => ({ t: 'tool_result', id: String(c.tool_use_id || ''), ok: !c.is_error, output: clean(cutTo(resultText(c.content), MAX_OUTPUT)), ...parent }));
    }
    if (e.type === 'result') {
        return { t: 'done', ok: !e.is_error, text: cut(e.result), duration_ms: e.duration_ms || 0, cost_usd: e.total_cost_usd || 0, turns: e.num_turns || 0 };
    }
    return null;
}

/**
 * The session log a result keeps: every line, in order, up to MAX_LOG bytes. When it would not fit, outputs and
 * progress are cut shorter first (progress is dropped where its step's result has the output), so the steps and what
 * the agents said survive whole.
 */
function sessionLog(lines) {
    const size = (l) => JSON.stringify(l).length + 1;
    let list = lines.slice();
    let total = list.reduce((n, l) => n + size(l), 0);
    if (total <= MAX_LOG) return list;
    const ended = new Set(list.filter((l) => l.t === 'tool_result').map((l) => l.id));
    list = list.filter((l) => !(l.t === 'tool_progress' && ended.has(l.id)));
    for (const n of [1500, 600, 200]) {
        total = list.reduce((m, l) => m + size(l), 0);
        if (total <= MAX_LOG) return list;
        list = list.map((l) => (l.t === 'tool_result' || l.t === 'tool_progress') ? { ...l, [l.t === 'tool_result' ? 'output' : 'chunk']: cutTo(l.output || l.chunk, n) } : l.t === 'tool' && l.input && (l.input.content || l.input.old_string) ? { ...l, input: { ...l.input, content: l.input.content && cutTo(l.input.content, n), old_string: l.input.old_string && cutTo(l.input.old_string, n), new_string: l.input.new_string && cutTo(l.input.new_string, n) } } : l);
    }
    const kept = [];
    total = 0;
    for (const l of list) { total += size(l); if (total > MAX_LOG) break; kept.push(l); }
    kept.push({ t: 'note', level: 'warning', text: 'The rest of this session was too long to keep.' });
    return kept;
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

/**
 * Commit on a new branch and push it with GITHUB_TOKEN; a pull request when asked. Only ever a branch that does not
 * exist yet: never the base, never a protected name, never someone's existing branch (GitHub is asked first, and a push
 * is never forced, so a branch made meanwhile is not overwritten either).
 */
async function pushBranch(dir, job, { env, fetchImpl, base }) {
    const token = env.GITHUB_TOKEN;
    const gh = githubRepo(job.repo);
    if (!token || !gh) return { pushed: false, reason: !gh ? 'push is for github.com repositories' : 'this machine has no GITHUB_TOKEN' };
    const first = pushTarget(job.push.branch, base);
    if (first.refused) return { pushed: false, reason: first.refused };
    const branch = first.branch;
    const remoteUrl = `https://x-access-token:${token}@github.com/${gh.owner}/${gh.name}.git`;
    let exists = null;
    try { exists = (await git(['ls-remote', '--heads', remoteUrl, `refs/heads/${branch}`], { cwd: dir, timeout: 60_000 })).trim() !== ''; } catch { exists = null; }
    const checked = pushTarget(branch, base, { exists });
    if (checked.refused) return { pushed: false, reason: checked.refused };
    const who = {
        GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME || 'OpenVibe.Codes', GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL || 'codes@openvibe.codes',
        GIT_COMMITTER_NAME: env.GIT_AUTHOR_NAME || 'OpenVibe.Codes', GIT_COMMITTER_EMAIL: env.GIT_AUTHOR_EMAIL || 'codes@openvibe.codes',
    };
    await git(['checkout', '-b', branch], { cwd: dir });
    await git(['commit', '-m', job.prompt.split('\n')[0].slice(0, 72) || 'OpenVibe.Codes task'], { cwd: dir, env: who });
    await git(['push', remoteUrl, `HEAD:refs/heads/${branch}`], { cwd: dir, timeout: 180_000 });
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
async function runJob({ input, harness, emit, writeResult, env = process.env, tmp = os.tmpdir(), fetchImpl = globalThis.fetch, proof = null }) {
    const started = Date.now();
    const log = [];
    const say = (doc) => { if (doc && doc.t && doc.t !== 'result_doc') log.push(doc); emit(JSON.stringify(doc)); };
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
            // A task carried on in the same conversation resumes its session (RESUME in the environment, or the job's
            // own resume field).
            resume: job.resume || null,
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
        // The proof of the change: the tests it reaches, the pages it touched, the diff, and a second model's opinion.
        // It is collected here, in the clone the agent worked in, so the evidence is about this machine's work.
        if (proof) {
            say({ t: 'step', text: 'Collecting the proof' });
            try {
                const collected = await collectProof({
                    cwd: work,
                    files: result.files.map((f) => f.path),
                    adapters: proof,
                    author: { agent: job.agent, model: job.model },
                    emit: (item) => say({ t: 'proof', kind: item.kind, label: item.label, ok: item.ok, skipped: !!item.skipped, summary: item.summary, family: item.family || null }),
                });
                result.proof = { items: collected.items.map((i) => ({ kind: i.kind, label: i.label, ok: i.ok, skipped: !!i.skipped, summary: i.summary, family: i.family || null, detail: i.shots ? { shots: i.shots } : (i.kind === 'diff' ? { files: i.files, stats: i.stats } : null) })), outcome: collected.outcome };
            } catch (e) {
                say({ t: 'note', level: 'warning', text: `The proof could not be collected: ${scrub(e.message)}` });
                result.proof = { items: [], outcome: null };
            }
        }
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
    result.lines = LINES;
    result.log = sessionLog(log);
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

module.exports = { runJob, parseArgs, compact, sessionLog, stepInput, resultWriter, scrub, githubRepo, pushTarget, jobEnv, ENV_NAMES, JOB_PROTOCOL };
