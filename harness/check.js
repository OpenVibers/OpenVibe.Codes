'use strict';

/**
 * `openvibe-codes job` with `kind: 'check'`: one workflow job of a repository, run with act in host mode on this
 * machine instead of on a GitHub-hosted runner (one-system-v2 step 4, piece 1).
 *
 *   { kind: 'check', repo, sha, workflow, job, matrix?, event: 'push'|'pull_request', ref?, timeout_ms? }
 *
 * It clones `repo` at `sha` (depth 1, with the same per-host credential as a task), reads the workflow job, and runs
 * act with `-P ubuntu-latest=-self-hosted` (no Docker): each step is a `{ t: 'step', name, state, conclusion?, ms? }`
 * line, other output rides the job's existing `{ t: 'step', text }` lines, and the result is
 * `{ ok, kind: 'check', conclusion, reason?, steps, log_tail, ms }`.
 *
 * A job that needs services, a container, a secret other than `GITHUB_TOKEN`, a Docker action or a runner that is not
 * an ubuntu label is `skipped` with the reason: the scheduler leaves it to Actions. No secret reaches a step: act gets
 * a fixed, small environment, never `GITHUB_TOKEN` nor the Codes runner's own variables.
 *
 * The act release is pinned here and checked against its sha256 before it is started; the binary is fetched into the
 * job's own directory and thrown away with it.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');
const { spawn, execFile } = require('child_process');
const YAML = require('yaml');
const { gitAuthFor, cloneProblem, scrub, JOB_PROTOCOL } = require('./job');

const ACT_VERSION = '0.2.97';
const ACT_URL = `https://github.com/nektos/act/releases/download/v${ACT_VERSION}/act_Linux_x86_64.tar.gz`;
const ACT_SHA256 = '67b4976a56f33ea7870b798912e738ec44eef38e7578ae7b532f2def1c73a5ad';
const MAX_ACT_BYTES = 24 * 1024 * 1024;
const MAX_ACT_UNPACKED = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_WORKFLOW_BYTES = 1024 * 1024;
const MAX_LINE = 4_000;          // one live line (a task's step output is capped the same way)
const MAX_LOG_TAIL = 16 * 1024;  // the result's log tail
const MAX_RAW_LOG = 128 * 1024;
const MAX_STEP_MS = Number.MAX_SAFE_INTEGER;

const SHA = /^[0-9a-f]{40}$/i;
const JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MATRIX_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const REF = /^[A-Za-z0-9._/-]{1,200}$/;
const REPO_HOSTS = new Set(['github.com', 'git.openvibe.codes']);
const UBUNTU = /^ubuntu(-|$)/i;

/** Both scrubbers a line goes through: provider keys/JWTs and URL credentials/GitHub tokens. */
// The URL/token scrubber runs first: it removes a credential from a URL as a whole, before the events scrubber turns
// the token into `[redacted]` and leaves the URL's user part in place.
const clean = (s) => require('./events').scrub(scrub(String(s == null ? '' : s)));
const cutTo = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

function has(object, key) {
    return !!object && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
}

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

/**
 * The input checked. A repository is an https github.com or git.openvibe.codes URL; `file://` is accepted only with
 * OPENVIBE_CODES_ALLOW_FILE_REPO=1, the same test hook the task path uses. Every field the check needs is validated,
 * so nothing in the input is a path, a command or a flag.
 */
function parseCheckArgs(raw, env = process.env) {
    let a;
    try {
        a = typeof raw === 'string' ? JSON.parse(String(raw || '').trim() || '{}') : raw;
    } catch {
        throw new Error('the job input is not JSON');
    }
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('the job input must be an object');
    if (a.kind !== 'check') throw new Error('the job input is not a check');

    const repo = parseRepo(a.repo, env);
    const sha = String(a.sha == null ? '' : a.sha).trim();
    if (sha && !SHA.test(sha)) throw new Error('sha must be a 40-character hex commit');
    // A race checks the branch a side pushed, before Codes has read its commit: the ref names it and the check
    // resolves the commit itself. A job that names a sha is still checked against it exactly.
    let ref = null;
    if (a.ref != null && a.ref !== '') {
        ref = String(a.ref).trim();
        if (!REF.test(ref) || ref.startsWith('-') || ref.startsWith('/') || ref.includes('..') || ref.includes('//')) throw new Error('ref must be a branch or tag name');
    }
    if (!sha && !ref) throw new Error('sha or ref is required');
    const workflow = String(a.workflow == null ? '' : a.workflow).trim();
    if (workflow && !isWorkflowPath(workflow)) throw new Error('workflow must be a path under .github/workflows/ ending in .yml or .yaml');
    const job = String(a.job == null ? '' : a.job).trim();
    if (job && !JOB_ID.test(job)) throw new Error('job must be a workflow job id');
    // Both named, or neither: with neither, the check runs the repository's own first runnable workflow job.
    if (!!workflow !== !!job) throw new Error('workflow and job go together, or neither for the repository’s own check');
    const event = a.event;
    if (event !== 'push' && event !== 'pull_request') throw new Error('event must be push or pull_request');
    const matrix = parseMatrix(a.matrix);
    let timeout_ms = DEFAULT_TIMEOUT_MS;
    if (a.timeout_ms != null) {
        if (!Number.isInteger(a.timeout_ms) || a.timeout_ms <= 0) throw new Error('timeout_ms must be a positive integer');
        timeout_ms = Math.min(a.timeout_ms, MAX_TIMEOUT_MS);
    }
    return {
        kind: 'check', repo: repo.url, repoHost: repo.host, repoOwner: repo.owner, repoName: repo.name,
        sha: sha.toLowerCase(), workflow, job, matrix, event, ref, timeout_ms,
    };
}

/** A repository URL: https on one of the two hosts, or file:// for tests. No credentials, query, fragment or port. */
function parseRepo(raw, env) {
    let u;
    try { u = new URL(String(raw == null ? '' : raw).trim()); } catch { throw new Error('repo must be a repository URL'); }
    const fileOk = env.OPENVIBE_CODES_ALLOW_FILE_REPO === '1' && u.protocol === 'file:';
    if (u.protocol !== 'https:' && !fileOk) throw new Error('repo must be an https github.com or git.openvibe.codes URL');
    if (u.username || u.password) throw new Error('repo must not carry credentials');
    if (u.search || u.hash) throw new Error('repo must not carry a query or fragment');
    if (u.port) throw new Error('repo must not name a port');
    if (fileOk) {
        if (!u.pathname || u.pathname === '/') throw new Error('repo must be a repository path');
        return { url: u.toString(), host: 'local', owner: 'local', name: path.basename(u.pathname) || 'repo' };
    }
    const host = u.hostname.toLowerCase();
    if (!REPO_HOSTS.has(host)) throw new Error('repo must be an https github.com or git.openvibe.codes URL');
    const parts = u.pathname.replace(/\/+$/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
    if (parts.length !== 2 || !OWNER_NAME.test(parts[0]) || !OWNER_NAME.test(parts[1]) || parts[0] === '.' || parts[0] === '..' || parts[1] === '.' || parts[1] === '..') {
        throw new Error('repo must name one owner and one repository');
    }
    return { url: `https://${host}/${parts[0]}/${parts[1]}`, host, owner: parts[0], name: parts[1] };
}

/** A workflow file under `.github/workflows/`, no traversal, no absolute path, no control characters. */
function isWorkflowPath(value) {
    if (typeof value !== 'string' || !value || value.length > 300 || /[\0-\x1f\x7f\\]/.test(value)) return false;
    const parts = value.split('/');
    if (parts.length < 3 || parts[0] !== '.github' || parts[1] !== 'workflows') return false;
    if (!parts.every((part) => part && part !== '.' && part !== '..' && /^[A-Za-z0-9._-]+$/.test(part))) return false;
    return /\.ya?ml$/i.test(parts[parts.length - 1]);
}

/** The matrix act receives: scalar keys and values only, a bounded number of them. */
function parseMatrix(raw) {
    if (raw == null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('matrix must be an object of scalar values');
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
        if (!MATRIX_KEY.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('matrix keys must be names');
        let v;
        if (typeof value === 'string') {
            if (!value || value.length > 200 || /[\0\r\n]/.test(value)) throw new Error('matrix values must be short strings, numbers or booleans');
            v = value;
        } else if (typeof value === 'number') {
            if (!Number.isFinite(value)) throw new Error('matrix values must be finite');
            v = String(value);
        } else if (typeof value === 'boolean') {
            v = String(value);
        } else {
            throw new Error('matrix values must be strings, numbers or booleans');
        }
        out[key] = v;
    }
    return out;
}

/** A workflow parsed as plain objects; an unreadable one is an error (a failure), not a skip. */
function parsedWorkflow(source) {
    let doc;
    try {
        doc = YAML.parseDocument(String(source), { uniqueKeys: true, maxAliasCount: 0, strict: true });
    } catch (e) {
        throw new Error(`the workflow could not be read: ${e.message}`);
    }
    if (doc.errors && doc.errors.length) throw new Error(`the workflow could not be read: ${doc.errors[0].message}`);
    let wf;
    try {
        wf = doc.toJS({ maxAliasCount: 0 });
    } catch (e) {
        throw new Error(`the workflow could not be read: ${e.message}`);
    }
    if (!wf || typeof wf !== 'object' || Array.isArray(wf) || !wf.jobs || typeof wf.jobs !== 'object' || Array.isArray(wf.jobs)) {
        throw new Error('the workflow has no jobs');
    }
    return wf;
}

function jobIn(wf, jobId) {
    const job = has(wf.jobs, jobId) ? wf.jobs[jobId] : null;
    if (!job || typeof job !== 'object' || Array.isArray(job)) throw new Error(`the workflow has no job named ${jobId}`);
    return job;
}

/** The events a workflow listens for (`on:` is a string, a list or a map of events). */
function workflowTriggers(wf) {
    const on = wf && (wf.on !== undefined ? wf.on : wf.true);
    if (typeof on === 'string') return [on];
    if (Array.isArray(on)) return on.filter((x) => typeof x === 'string');
    if (on && typeof on === 'object') return Object.keys(on);
    return [];
}

/**
 * The repository's own check, when the job names no workflow: the first workflow job that listens for pull requests
 * (or any event) and that act can run in host mode. Sorted by file name, so the same repository always gets the same
 * check. When nothing is runnable the first job is still named: the check's own skip reason says why it was left out.
 * → { workflow, job } or null when the repository has no workflow.
 */
function discoverWorkflow(work) {
    const dir = path.join(work, '.github', 'workflows');
    let names;
    try { names = fs.readdirSync(dir); } catch { return null; }
    const parsed = [];
    for (const name of names.filter((n) => /\.ya?ml$/i.test(n)).sort()) {
        const file = path.join(dir, name);
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        if (!st.isFile() || st.size > MAX_WORKFLOW_BYTES) continue;
        try {
            const source = fs.readFileSync(file, 'utf8');
            parsed.push({ workflow: `.github/workflows/${name}`, source, wf: parsedWorkflow(source), triggers: [] });
            parsed[parsed.length - 1].triggers = workflowTriggers(parsed[parsed.length - 1].wf);
        } catch { /* a workflow act could not read is not the repository's check */ }
    }
    const forPullRequests = (p) => p.triggers.includes('pull_request');
    const ordered = [...parsed.filter(forPullRequests), ...parsed.filter((p) => !forPullRequests(p))];
    // Within a workflow, a job that sounds like the check (test, lint, build) comes before a deploy or a publish.
    const rank = (id) => (/test/i.test(id) ? 0 : /check|ci|lint|build/i.test(id) ? 1 : 2);
    for (const p of ordered) {
        const jobs = Object.keys(p.wf.jobs || {}).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
        const runnable = jobs.find((id) => {
            try { return skipReason(p.source, id) === null; } catch { return false; }
        });
        if (runnable) return { workflow: p.workflow, job: runnable };
    }
    const first = ordered[0];
    const firstJob = first && Object.keys(first.wf.jobs || {})[0];
    return first && firstJob ? { workflow: first.workflow, job: firstJob } : null;
}

/** The workflow's jobs.<id> as a plain object; an unreadable workflow or a missing job is an error, not a skip. */
function workflowJob(source, jobId) {
    return jobIn(parsedWorkflow(source), jobId);
}

/**
 * Why this job must be left to Actions (`services:`, `container:`, another secret, a non-ubuntu runner, a Docker
 * action), or null when act host mode can run it. The scheduler reads `skipped` and does not retry another node.
 */
function skipReason(source, jobId, matrix = {}) {
    const wf = parsedWorkflow(source);
    const job = jobIn(wf, jobId);
    if (has(job, 'services')) return 'the job uses services:, which act in host mode cannot run';
    if (has(job, 'container')) return 'the job uses container:, which act in host mode cannot run';
    if (has(job, 'secrets')) return 'the job passes secrets to another workflow, which is not run on a node';
    // A workflow-level env applies to every job: a secret there reaches this job's steps too.
    const secret = secretUse(job) || secretUse(wf.env);
    if (secret) return secret.name ? `the job uses the secret ${secret.name}, not only GITHUB_TOKEN` : 'the job uses a secret whose name it computes, not only GITHUB_TOKEN';
    const runner = runnerCheck(job, matrix);
    if (!runner.ok) return runner.reason;
    const docker = dockerUse(job);
    if (docker) return `the job uses the Docker action ${docker}, which act in host mode cannot run`;
    return null;
}

/** Whether a job reads `secrets.*` (or `secrets[...]`) other than GITHUB_TOKEN; walks every string it may evaluate. */
function secretUse(value, depth = 0, seen = new Set()) {
    if (depth > 30 || value == null) return null;
    if (typeof value === 'string') {
        const re = /\bsecrets\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]|\[)/g;
        let m;
        while ((m = re.exec(value))) {
            const name = m[1] || m[2] || null;
            if (name && name.toUpperCase() === 'GITHUB_TOKEN') continue;
            return { name };
        }
        return null;
    }
    if (typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) {
        for (const item of value) { const found = secretUse(item, depth + 1, seen); if (found) return found; }
        return null;
    }
    for (const item of Object.values(value)) { const found = secretUse(item, depth + 1, seen); if (found) return found; }
    return null;
}

/** The runner the job asks for: every label it resolves to must be an ubuntu one, and act must be told so. */
function runnerCheck(job, matrix) {
    const labels = runnerLabels(job, matrix);
    if (!labels || !labels.length) return { ok: false, reason: 'the job runs on a runner act cannot resolve to an ubuntu label' };
    const other = labels.filter((label) => !UBUNTU.test(label));
    if (other.length) return { ok: false, reason: `the job runs on ${other.join(', ')}, not an ubuntu label` };
    // The pinned act binary is linux x64; an ARM ubuntu runner would run here on the wrong architecture.
    const arm = labels.find((label) => /(?:^|[-_.])arm(?:64)?(?:$|[-_.])|aarch64/i.test(label));
    if (arm) return { ok: false, reason: `the job runs on ${arm}, not an x64 ubuntu label` };
    return { ok: true, labels: [...new Set(labels)] };
}

function runnerLabels(job, matrix) {
    const raw = job['runs-on'];
    if (typeof raw === 'string') {
        const expr = /^\s*\$\{\{\s*matrix\.([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}\s*$/.exec(raw);
        if (expr) {
            const key = expr[1];
            if (matrix && has(matrix, key)) return [String(matrix[key])];
            const values = workflowMatrixValues(job, key);
            return values.length ? values : null;
        }
        if (/\$\{\{/.test(raw)) return null;
        return [raw];
    }
    if (Array.isArray(raw)) {
        const out = [];
        for (const item of raw) {
            if (typeof item !== 'string' || /\$\{\{/.test(item)) return null;
            out.push(item);
        }
        return out;
    }
    if (raw && typeof raw === 'object' && Array.isArray(raw.labels)) return runnerLabels({ ...job, 'runs-on': raw.labels }, matrix);
    return null;
}

/** The values a workflow's strategy.matrix gives a key; `include` may add one, an expression cannot be read here. */
function workflowMatrixValues(job, key) {
    const m = job.strategy && typeof job.strategy === 'object' ? job.strategy.matrix : null;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return [];
    const values = [];
    const add = (v) => {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') values.push(String(v));
        else if (v != null) values.push(null);
    };
    if (has(m, key)) {
        if (Array.isArray(m[key])) for (const v of m[key]) add(v);
        else add(m[key]);
    }
    if (Array.isArray(m.include)) {
        for (const inc of m.include) if (inc && typeof inc === 'object' && has(inc, key)) add(inc[key]);
    }
    return values.filter((v) => v !== null);
}

/** A step that needs the Docker daemon (`uses: docker://…`): act host mode would call Docker. */
function dockerUse(job) {
    for (const step of Array.isArray(job.steps) ? job.steps : []) {
        if (step && typeof step === 'object' && typeof step.uses === 'string' && /^docker:\/\//i.test(step.uses.trim())) return step.uses.trim();
    }
    return null;
}

/**
 * The event JSON act reads. It carries the repository, the commit and the branch/PR the job is for; nothing secret.
 * `ref` is the branch the scheduler named (a push) or the PR head (a pull_request).
 */
function eventPayload(job) {
    const branch = (job.ref || 'main').replace(/^refs\/heads\//, '');
    const fullRef = job.ref && job.ref.startsWith('refs/') ? job.ref : `refs/heads/${branch}`;
    const repository = {
        full_name: `${job.repoOwner}/${job.repoName}`,
        name: job.repoName,
        owner: { login: job.repoOwner },
        html_url: job.repo,
        clone_url: `${job.repo}.git`,
    };
    const sender = { login: 'openvibe-codes' };
    if (job.event === 'pull_request') {
        const pr = job.ref ? /refs\/pull\/(\d+)\//.exec(job.ref) : null;
        const number = pr ? Number(pr[1]) : 1;
        return {
            action: 'synchronize', number, repository, sender,
            pull_request: {
                number, state: 'open',
                head: { ref: branch, sha: job.sha, repo: repository },
                base: { ref: 'main', sha: job.sha, repo: repository },
            },
        };
    }
    return {
        ref: fullRef, before: '0'.repeat(40), after: job.sha, repository, sender,
        pusher: { name: 'openvibe-codes' }, head_commit: { id: job.sha },
    };
}

/**
 * A line of act's output, as the step it starts/ends or as plain output. Recorded act output:
 *
 *   [ci/test] ⭐ Run Main say hello
 *   [ci/test]   | hello
 *   [ci/test]   ✅  Success - Main say hello [11.7ms]
 */
function parseActLine(raw) {
    const line = String(raw == null ? '' : raw).replace(/\x1b\[[0-9;]*m/g, '').replace(/\r$/, '');
    let m = /^\[[^\]]+\]\s+⭐\s+Run\s+(?:(Pre|Post|Main)\s+)?(.+?)\s*$/u.exec(line);
    if (m) return { type: 'started', phase: m[1] || null, name: m[2].trim() };
    // Go's duration String(): 11.75651ms, 1.2s, 500µs, and 1m2.3s for anything over a minute.
    m = /^\[[^\]]+\]\s+([^\s|])\ufe0f?\s+(Success|Failure|Skipped|Cancelled)\s+-\s+(?:(Pre|Post|Main)\s+)?(.+?)(?:\s+\[((?:\d+(?:\.\d+)?(?:h|ms|µs|us|ns|m|s))+)\])?\s*$/u.exec(line);
    if (m) {
        const ms = m[5] == null ? null : durationMs(m[5]);
        return { type: 'completed', phase: m[3] || null, name: m[4].trim(), conclusion: m[2].toLowerCase(), ms };
    }
    return { type: 'output', text: line };
}

/** A Go-style duration (`1m2.3s`, `11.7ms`) as whole milliseconds. */
function durationMs(text) {
    let total = 0;
    for (const m of String(text).matchAll(/(\d+(?:\.\d+)?)(h|ms|µs|us|ns|m|s)/g)) {
        total += Number(m[1]) * ({ h: 3_600_000, m: 60_000, s: 1_000, ms: 1, 'µs': 0.001, us: 0.001, ns: 0.000001 }[m[2]] || 1);
    }
    return Math.max(0, Math.round(total));
}

/** The text of an output line: act's `[workflow/job]` prefix and its `| ` output marker removed, not the words. */
function outputText(line) {
    let text = String(line == null ? '' : line);
    const prefix = /^\[[^\]]+\]\s?(.*)$/.exec(text);
    if (prefix) text = prefix[1];
    text = text.replace(/^\s*\| ?/, '').replace(/\s+$/, '');
    return text;
}

function phaseName(phase, name) {
    if (!phase || phase === 'Main') return name;
    return `${phase} ${name}`;
}

/** The pinned act release, verified against its sha256, written into the job's directory. */
async function prepareAct(dir, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
    const stub = env.OPENVIBE_CODES_ACT_BIN;
    if (stub) {
        const real = fs.realpathSync(String(stub));
        const st = fs.statSync(real);
        if (!st.isFile()) throw new Error('OPENVIBE_CODES_ACT_BIN is not a file');
        return real;
    }
    const response = await fetchImpl(ACT_URL, {
        redirect: 'follow',
        headers: { 'User-Agent': 'openvibe-codes' },
        signal: AbortSignal.timeout(120_000),
    });
    if (!response || !response.ok) throw new Error(`the act release could not be fetched (${response ? response.status : 'no answer'})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_ACT_BYTES) throw new Error('the act release is not the expected size');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== ACT_SHA256) throw new Error(`the act release did not match its sha256 (got ${digest})`);
    let unpacked;
    try {
        unpacked = zlib.gunzipSync(bytes, { maxOutputLength: MAX_ACT_UNPACKED });
    } catch (e) {
        throw new Error(`the act release could not be unpacked: ${e.message}`);
    }
    const binary = tarEntry(unpacked, 'act');
    const dest = path.join(dir, 'act');
    fs.writeFileSync(dest, binary, { mode: 0o755 });
    return dest;
}

/** The bytes of one regular file in an in-memory tar; `act` is the only entry this needs. */
function tarEntry(tar, wanted) {
    let offset = 0;
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every((b) => b === 0)) break;
        const read = (from, to) => header.subarray(from, to).toString('utf8').replace(/\0.*$/s, '');
        const name = read(0, 100);
        const prefix = read(345, 500);
        const full = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, '');
        const sizeText = read(124, 136).trim();
        const size = sizeText ? parseInt(sizeText, 8) : 0;
        if (!Number.isFinite(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('the act release has a broken tar entry');
        const type = String.fromCharCode(header[156] || 48);
        if ((type === '0' || type === '\0' || type === '7') && full === wanted) return Buffer.from(tar.subarray(offset + 512, offset + 512 + size));
        offset += 512 + Math.ceil(size / 512) * 512;
    }
    throw new Error('the act release does not hold the act binary');
}

/**
 * The environment act and the steps get: only safe system values, a writable HOME/cache/tmp inside the job's own
 * directory, and never a token. `GITHUB_TOKEN` and every other variable of the Codes runner's environment are left
 * out (a job's workflow env is act's own business and is read from the workflow, not from this process).
 */
function actEnvironment(env, dir) {
    const out = {};
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_NUMERIC', 'LC_TIME', 'LC_COLLATE', 'LC_MONETARY', 'LC_MESSAGES', 'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION', 'TZ', 'TERM', 'COLORTERM', 'SHELL']) {
        if (typeof env[key] === 'string' && env[key] && !/[\0\r\n]/.test(env[key])) out[key] = env[key];
    }
    const home = path.join(dir, 'home');
    const cache = path.join(dir, 'cache');
    const tmp = path.join(dir, 'tmp');
    for (const d of [home, cache, tmp]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    out.HOME = home;
    out.XDG_CACHE_HOME = cache;
    out.TMPDIR = tmp;
    out.GIT_TERMINAL_PROMPT = '0';
    out.GIT_ASKPASS = 'echo';
    out.CI = 'true';
    return out;
}

/** Kill act's whole process group: a step that ignores SIGTERM must not outlive its check. */
function stopGroup(child, signal) {
    if (!child || !child.pid) return;
    try { process.kill(-child.pid, signal); } catch {
        try { child.kill(signal); } catch { /* already gone */ }
    }
}

/**
 * Run act and stream its output line by line. Resolves with the exit code/signal, whether this call timed it out, or
 * the error that kept it from starting. The timeout starts when act starts, not while the clone/download runs.
 */
function runAct(binary, args, { cwd, env, timeout_ms, onLine }) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        } catch (e) {
            resolve({ error: e });
            return;
        }
        let settled = false;
        let timedOut = false;
        let timer = null;
        let killTimer = null;
        // A line can arrive in pieces (or a UTF-8 character can straddle two chunks): keep both streams' remains.
        const decoder = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };
        const remains = { out: '', err: '' };
        const finish = (value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (killTimer) clearTimeout(killTimer);
            resolve(value);
        };
        const emitLine = (line) => onLine(line.length > 64 * 1024 ? `${line.slice(0, 64 * 1024)}…` : line);
        const consume = (stream, chunk) => {
            const text = remains[stream] + decoder[stream].write(chunk);
            const parts = text.split('\n');
            remains[stream] = parts.pop();
            for (const line of parts) emitLine(line);
        };
        const flush = () => {
            for (const stream of ['out', 'err']) {
                const last = remains[stream] + decoder[stream].end();
                remains[stream] = '';
                if (last) emitLine(last);
            }
        };
        child.stdout.on('data', (chunk) => consume('out', chunk));
        child.stderr.on('data', (chunk) => consume('err', chunk));
        child.on('error', (e) => finish({ error: e, timedOut }));
        child.on('close', (code, signal) => {
            flush();
            finish({ code, signal, timedOut });
        });
        timer = setTimeout(() => {
            timedOut = true;
            stopGroup(child, 'SIGTERM');
            killTimer = setTimeout(() => stopGroup(child, 'SIGKILL'), 2_000);
            if (killTimer.unref) killTimer.unref();
        }, timeout_ms);
        if (timer.unref) timer.unref();
    });
}

/**
 * A check job. `emit(line)` prints a line, `writeResult(doc)` hands the result over (once); it never throws for a bad
 * input or a failed run: the result document says what happened so Run can report it and retry or skip.
 */
async function runCheck({ input, emit = () => {}, writeResult = () => {}, env = process.env, tmp = os.tmpdir(), fetchImpl = globalThis.fetch } = {}) {
    const started = Date.now();
    const say = (doc) => emit(JSON.stringify(doc));
    const steps = [];
    let rawLog = '';
    let job = null;
    let dir = null;
    let conclusion = 'failure';
    let reason = null;

    const onLine = (line) => {
        if (line == null) return;
        rawLog += `${line}\n`;
        if (rawLog.length > MAX_RAW_LOG) rawLog = rawLog.slice(-MAX_RAW_LOG);
        const parsed = parseActLine(line);
        if (parsed.type === 'started') {
            const name = clean(cutTo(phaseName(parsed.phase, parsed.name), 200));
            const step = { name, startedAt: Date.now(), conclusion: null, ms: null };
            steps.push(step);
            say({ t: 'step', name, state: 'started' });
            return;
        }
        if (parsed.type === 'completed') {
            const name = clean(cutTo(phaseName(parsed.phase, parsed.name), 200));
            let step = null;
            for (let i = steps.length - 1; i >= 0; i--) {
                if (steps[i].name === name && steps[i].conclusion == null) { step = steps[i]; break; }
            }
            if (!step) {
                step = { name, startedAt: Date.now(), conclusion: null, ms: null };
                steps.push(step);
            }
            step.conclusion = parsed.conclusion;
            step.ms = parsed.ms == null ? Math.max(0, Date.now() - step.startedAt) : parsed.ms;
            say({ t: 'step', name, state: 'completed', conclusion: step.conclusion, ms: step.ms });
            return;
        }
        const text = clean(cutTo(outputText(parsed.text), MAX_LINE));
        if (text) say({ t: 'step', text });
    };

    const finish = () => {
        const result = {
            protocol: JOB_PROTOCOL,
            ok: conclusion === 'success' || conclusion === 'skipped',
            kind: 'check',
            conclusion,
            ...(reason ? { reason: clean(reason) } : {}),
            ...(job && job.workflow ? { workflow: job.workflow, job: job.job, sha: job.sha } : {}),
            steps: steps.map((step) => ({
                name: step.name,
                conclusion: step.conclusion || 'cancelled',
                ms: step.ms == null ? Math.max(0, Date.now() - step.startedAt) : Math.min(step.ms, MAX_STEP_MS),
            })),
            log_tail: tail(rawLog),
            ms: Date.now() - started,
        };
        writeResult(result);
        return result;
    };

    try {
        job = parseCheckArgs(input, env);
        dir = fs.mkdtempSync(path.join(tmp, 'codes-check-'));
        const work = path.join(dir, 'repo');
        say({ t: 'step', text: `Cloning ${scrub(job.repo)} at ${job.sha ? job.sha.slice(0, 12) : job.ref}` });

        await git(['init', '-q', work], { timeout: 60_000 });
        await git(['remote', 'add', 'origin', job.repo], { cwd: work });
        const auth = gitAuthFor(job.repo, env);
        if (job.sha) {
            try {
                await git(['fetch', '--depth', '1', '--no-tags', 'origin', job.sha], { cwd: work, timeout: 300_000, ...(auth.env ? { env: auth.env } : {}) });
            } catch (first) {
                // Some servers do not serve an arbitrary commit by sha; the branch the scheduler names can still hold it.
                if (!job.ref) throw new Error(cloneProblem(first.message, job.repo));
                await git(['fetch', '--no-tags', 'origin', job.ref], { cwd: work, timeout: 300_000, ...(auth.env ? { env: auth.env } : {}) }).catch((e) => { throw new Error(cloneProblem(e.message, job.repo)); });
                try { await git(['cat-file', '-e', `${job.sha}^{commit}`], { cwd: work }); } catch { throw new Error(`commit ${job.sha} is not in ${job.repo}`); }
            }
            await git(['checkout', '-q', '--detach', job.sha], { cwd: work });
        } else {
            // A race names the branch its side pushed: fetch it, and let the commit it points at be the one checked.
            await git(['fetch', '--no-tags', 'origin', job.ref], { cwd: work, timeout: 300_000, ...(auth.env ? { env: auth.env } : {}) })
                .catch((e) => { throw new Error(cloneProblem(e.message, job.repo)); });
            await git(['checkout', '-q', '--detach', 'FETCH_HEAD'], { cwd: work });
        }
        const head = (await git(['rev-parse', 'HEAD'], { cwd: work })).trim().toLowerCase();
        if (job.sha && head !== job.sha) throw new Error('the cloned commit is not the one asked for');
        job.sha = head;
        if (auth.env) say({ t: 'step', text: 'Cloned with this machine\'s token for a private repository' });

        if (!job.workflow) {
            const found = discoverWorkflow(work);
            if (!found) throw new Error('the repository has no workflow under .github/workflows/');
            job.workflow = found.workflow;
            job.job = found.job;
            say({ t: 'step', text: `Using ${found.workflow} job ${found.job}` });
        }
        const workflowFile = path.join(work, job.workflow);
        let realWorkflow;
        try { realWorkflow = fs.realpathSync(workflowFile); } catch { throw new Error(`the workflow ${job.workflow} is not in the repository at ${job.sha}`); }
        if (!realWorkflow.startsWith(`${fs.realpathSync(work)}${path.sep}`)) throw new Error('the workflow must be inside the repository');
        const st = fs.statSync(realWorkflow);
        if (!st.isFile()) throw new Error(`the workflow ${job.workflow} is not a file`);
        if (st.size > MAX_WORKFLOW_BYTES) throw new Error(`the workflow ${job.workflow} is over 1 MiB`);
        const source = fs.readFileSync(realWorkflow, 'utf8');
        const skip = skipReason(source, job.job, job.matrix);
        if (skip) {
            conclusion = 'skipped';
            reason = skip;
            say({ t: 'step', text: `Skipped: ${skip}` });
            return finish();
        }

        // act reads ./.actrc, ./.secrets, ./.vars and ./.env when it runs from the checkout. They are local act
        // configuration, not actions the workflow takes on GitHub: move them out of the clone, outside the sandbox's
        // HOME, so a repository cannot point act at another file or feed the steps a repo-defined environment.
        for (const name of ['.actrc', '.secrets', '.vars', '.env']) {
            const file = path.join(work, name);
            try { fs.renameSync(file, path.join(dir, `repo${name}`)); } catch { /* absent: nothing to read */ }
        }
        say({ t: 'step', text: 'Preparing act' });
        const binary = await prepareAct(dir, { env, fetchImpl });
        const eventPath = path.join(dir, 'event.json');
        fs.writeFileSync(eventPath, JSON.stringify(eventPayload(job)), { mode: 0o600 });

        const platform = runnerCheck(workflowJob(source, job.job), job.matrix);
        const labels = platform.ok ? platform.labels : ['ubuntu-latest'];
        const args = [
            job.event, '-W', job.workflow, '-j', job.job,
            '-P', 'ubuntu-latest=-self-hosted',
            ...labels.filter((label) => label.toLowerCase() !== 'ubuntu-latest').flatMap((label) => ['-P', `${label}=-self-hosted`]),
            '--eventpath', eventPath,
            // act's cache server (actions/cache, setup-node's `cache: npm`) binds to the outbound address by default.
            // In Link's job sandbox that is a link-local address the egress filter drops, so a step that restores a
            // cache waits on a connection that never opens. On loopback, inside the job's own network, it answers;
            // its files stay in the job's directory.
            '--cache-server-addr', '127.0.0.1', '--cache-server-path', path.join(dir, 'actcache'),
            ...Object.entries(job.matrix).flatMap(([key, value]) => ['--matrix', `${key}:${value}`]),
        ];
        say({ t: 'step', text: `Running ${job.workflow} job ${job.job} with act ${ACT_VERSION}` });
        const child = await runAct(binary, args, { cwd: work, env: actEnvironment(env, dir), timeout_ms: job.timeout_ms, onLine });
        if (child.error) throw new Error(`act could not start: ${child.error.message}`);
        if (child.timedOut) {
            conclusion = 'timed_out';
            reason = `the check did not finish within ${job.timeout_ms} ms`;
        } else if (child.signal) {
            conclusion = 'cancelled';
            reason = `act was stopped by ${child.signal}`;
        } else if (child.code === 0) {
            // act exits 0 without a line when the job's if: is false or the matrix value is not in the workflow.
            // Do not call that a green check: it is a skip, and Actions still runs the job.
            if (!steps.length) {
                conclusion = 'skipped';
                reason = 'act ran no step: the job was skipped, or the matrix value is not one of its configurations';
            } else {
                conclusion = 'success';
            }
        } else {
            conclusion = 'failure';
            reason = `act ended with ${child.signal || `exit code ${child.code}`}`;
        }
    } catch (e) {
        conclusion = 'failure';
        reason = e && e.message ? e.message : String(e);
        say({ t: 'note', level: 'error', text: clean(cutTo(reason, MAX_LINE)) });
    } finally {
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
    return finish();
}

/** The result's log tail: the last 16 KB, scrubbed, and never a token. */
function tail(raw) {
    const text = clean(raw || '');
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length <= MAX_LOG_TAIL) return text;
    return bytes.subarray(bytes.length - MAX_LOG_TAIL).toString('utf8');
}

module.exports = {
    ACT_VERSION, ACT_URL, ACT_SHA256, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS,
    parseCheckArgs, parseArgs: parseCheckArgs, skipReason, workflowJob, discoverWorkflow, eventPayload, parseActLine, outputText, prepareAct,
    runCheck, tail,
};
