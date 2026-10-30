'use strict';

/**
 * `openvibe-codes task` — coding tasks on OpenVibe.Codes, as the person, from a terminal: start one from a brief,
 * list yours, follow it live, continue it, stop it. The counterpart of `openvibe-codes run`, which runs an agent on
 * this machine: a task runs on one of your machines through OpenVibe.Run, and this client only talks to
 * https://openvibe.codes/api/v1/tasks (server/http/tasks-api.js).
 *
 *   openvibe-codes task start --repo owner/repo --file brief.md [--agent …] [--name …] [--tier …]
 *   openvibe-codes task list [--state running|needs|done]
 *   openvibe-codes task show <id> [--follow]
 *   openvibe-codes task continue <id> [--note "…"] [--agent …]
 *   openvibe-codes task stop <id>
 *
 * Who you are: a personal Network access token, from OPENVIBE_TOKEN or a file (~/.config/openvibe/token, mode 600),
 * sent as a Bearer. The server takes a person's token for the tasks that person owns; the same routes take a
 * first-party service's token (audience openvibe.codes) for the tasks it started for someone.
 *
 * Exit codes: 0 the task answered (and, when followed, ended done); 1 the API refused it, the task ended unfinished
 * or stopped, or the network failed; 2 the command line or the token is wrong.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const EXIT = { ok: 0, failed: 1, usage: 2 };
const STATES = { running: 'running', needs: 'needs', done: 'done' };
const ALIASES = {
    auto: null,
    cx: 'codex', codex: 'codex',
    cc: 'command-code', 'command-code': 'command-code',
    oc: 'opencode', opencode: 'opencode',
    claude: 'claude-code', cm: 'claude-code', 'claude-code': 'claude-code',
    dsh: 'deepseek', deepseek: 'deepseek',
    aider: 'aider',
};

const USAGE = `openvibe-codes task — coding tasks on OpenVibe.Codes, as you

  openvibe-codes task start --repo <owner/repo | path> --file brief.md
      --agent <auto|cx|mm|cm|cc|oc|claude|an agent id>   auto (default): the router picks
      --machine <auto>           your own machine takes it; a named machine is not selectable yet
      --file <path|->            the brief ("-" reads it from stdin)
      --name <n>                 a name for the task: starting it twice with one name answers the first task
      --tier basic|standard|hard the brief's tier (the engine forces it, as "tier: …" in the brief)
      --permission review|edit|full   review: read-only (research, an audit, a review); edit (default); full
  openvibe-codes task list [--state running|needs|done] [--limit 20]
  openvibe-codes task show <id> [--follow]      --follow streams the task's events until its outcome
  openvibe-codes task continue <id> [--note "…"] [--agent <agent>]
  openvibe-codes task stop <id>

  --json prints the API's answer as JSON instead of a readable log.

Token: OPENVIBE_TOKEN, or ~/.config/openvibe/token (mode 600; OPENVIBE_TOKEN_FILE overrides the path).
Server: OPENVIBE_CODES_URL (default https://openvibe.codes).`;

const out = (s) => process.stdout.write(`${s}\n`);
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const oneLine = (s, n) => String(s == null ? '' : s).split('\n')[0].slice(0, n);

class UsageError extends Error {}

function parse(argv) {
    const o = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') o.json = true;
        else if (a === '--follow') o.follow = true;
        else if (a === '--help' || a === '-h') o.help = true;
        else if (a.startsWith('--')) {
            const k = a.slice(2);
            if (!['repo', 'agent', 'machine', 'file', 'name', 'tier', 'state', 'permission', 'note', 'limit'].includes(k)) throw new UsageError(`unknown option --${k}`);
            const v = argv[++i];
            if (v === undefined || v.startsWith('--')) throw new UsageError(`--${k} needs a value`);
            o[k] = v;
        } else o._.push(a);
    }
    return o;
}

/** The repository a task starts from: owner/repo, an https URL, or a path whose origin remote is one. */
function repoOf(value) {
    if (!value) throw new UsageError('--repo <owner/repo | path | https URL> is required');
    const v = String(value).trim();
    if (/^https:\/\/[^\s@/]+\/[^\s@]+$/.test(v)) return v;
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) return `https://github.com/${v.replace(/\.git$/, '')}`;
    if (fs.existsSync(v)) {
        let remote = '';
        try { remote = execFileSync('git', ['-C', v, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { remote = ''; }
        const ssh = remote.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
        const https = remote.match(/^https:\/\/[^\s@/]+\/[^\s@]+$/);
        if (ssh) return `https://${ssh[1]}/${ssh[2].replace(/\.git$/, '')}`;
        if (https) return remote;
        throw new UsageError(`${v} has no https origin remote: give --repo owner/repo`);
    }
    throw new UsageError(`--repo: ${v} is not owner/repo, an https git URL or a path`);
}

function agentOf(value) {
    if (!value) return null;
    const v = String(value).trim();
    if (Object.prototype.hasOwnProperty.call(ALIASES, v)) return ALIASES[v];
    if (/^[a-z][a-z0-9-]{1,40}$/.test(v)) return v;
    throw new UsageError(`--agent: ${v} is not an agent (auto, cx, cm, cc, oc, claude, or an id from /api/v1/harnesses)`);
}

function tokenOf() {
    const env = String(process.env.OPENVIBE_TOKEN || '').trim();
    if (env) return env;
    const file = process.env.OPENVIBE_TOKEN_FILE || path.join(os.homedir(), '.config', 'openvibe', 'token');
    let st = null;
    try { st = fs.statSync(file); } catch { return null; }
    if (st.mode & 0o077) throw new UsageError(`${file} is readable by others: chmod 600 ${file}`);
    const token = fs.readFileSync(file, 'utf8').trim();
    if (!token) throw new UsageError(`${file} is empty`);
    return token;
}

function auth() {
    const token = tokenOf();
    if (!token) {
        throw new UsageError('no Network token: set OPENVIBE_TOKEN, or write yours to ~/.config/openvibe/token with mode 600\n'
            + '(sign in at https://openvibe.network, then copy the access token from the site)');
    }
    return {
        token,
        base: String(process.env.OPENVIBE_CODES_URL || 'https://openvibe.codes').replace(/\/+$/, ''),
    };
}

async function call(c, method, p, body) {
    let res;
    try {
        res = await fetch(`${c.base}${p}`, {
            method,
            headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
        });
    } catch (e) {
        throw Object.assign(new Error(`OpenVibe.Codes did not answer (${c.base}): ${e.message}`), { exit: EXIT.failed });
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
        const code = json && (json.code || json.error);
        const detail = json && (json.detail || json.title || json.error_description);
        const err = new Error(`${res.status}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}`);
        err.exit = EXIT.failed;
        throw err;
    }
    if (json === null) {
        const err = new Error('OpenVibe.Codes answered something that is not JSON');
        err.exit = EXIT.failed;
        throw err;
    }
    return json;
}

/** running, needs or done, in the words the CLI prints and `task list --state` takes. */
function stateOf(task) {
    if (['queued', 'placed', 'running'].includes(task.state)) return 'running';
    if (task.outcome && task.outcome.state === 'unfinished') return 'needs';
    return 'done';
}

function printTask(task) {
    out(`${task.id} · ${stateOf(task)} · ${task.state}${task.agent ? ` · ${task.agent}` : ''}`);
    out(dim(`  ${task.repo}${task.ref ? ` (${task.ref})` : ''} · ${task.url}`));
    for (const a of task.attempts || []) {
        const when = a.state === 'running' || a.state === 'queued' ? 'now' : (a.end_why || a.state);
        out(`  attempt ${a.n} · ${a.state}${a.agent ? ` · ${a.agent}` : ''}${when ? dim(` — ${oneLine(when, 100)}`) : ''}`);
    }
    const result = task.result;
    if (result) {
        if (result.summary) for (const line of String(result.summary).split('\n').slice(0, 40)) out(`  ${line}`);
        const files = Array.isArray(result.files) ? result.files.length : 0;
        if (files) out(dim(`  ${files} file${files === 1 ? '' : 's'} changed`));
        if (result.push && result.push.pushed) out(dim(`  pushed ${result.push.branch}${result.push.pull_request ? ` · ${result.push.pull_request}` : ''}`));
        if (result.error) out(`  error: ${oneLine(result.error, 300)}`);
    } else if (task.error) out(`  error: ${oneLine(task.error, 300)}`);
    if (task.outcome && task.outcome.state) out(`outcome: ${task.outcome.state}${task.outcome.note ? ` — ${oneLine(task.outcome.note, 300)}` : ''}`);
    else out(dim('outcome: not decided yet'));
}

/** The task's event stream as readable lines; resolves when the server ends it (the outcome is known). */
async function follow(c, id, printable) {
    let res;
    try {
        res = await fetch(`${c.base}/api/v1/tasks/${encodeURIComponent(id)}/events`, {
            headers: { Authorization: `Bearer ${c.token}`, Accept: 'text/event-stream' },
        });
    } catch (e) {
        throw Object.assign(new Error(`the event stream did not open (${c.base}): ${e.message}`), { exit: EXIT.failed });
    }
    if (!res.ok) {
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* a problem is JSON; anything else is kept as text */ }
        const err = new Error(`${res.status}${json && json.code ? ` ${json.code}` : ''}${json && json.detail ? `: ${json.detail}` : ''}`);
        err.exit = EXIT.failed;
        throw err;
    }
    const decoder = new TextDecoder();
    let buf = '';
    let current = 0;
    const handle = (frame) => {
        let event = 'message';
        const data = [];
        for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
        if (!data.length) return;
        let body = null;
        try { body = JSON.parse(data.join('\n')); } catch { return; }
        if (event === 'line') {
            const b = body.body || {};
            const text = typeof b.text === 'string' ? b.text : b.t === 'tool' ? `→ ${b.name || ''} ${oneLine(b.input && (b.input.command || b.input.file_path) || '', 120)}`.trim() : '';
            if (body.attempt_n && body.attempt_n !== current) { current = body.attempt_n; out(dim(`[attempt ${body.attempt_n}]`)); }
            if (text) for (const line of text.split('\n')) out(`  ${line}`);
            return;
        }
        if (event === 'attempt') {
            if (typeof body.attempt_n === 'number') current = body.attempt_n;
            const why = body.why || body.end_why || '';
            if (body.type === 'attempt_started') out(`▶ attempt ${body.attempt_n}${body.agent ? ` · ${body.agent}` : ''}${why ? dim(` — ${oneLine(why, 160)}`) : ''}`);
            if (body.type === 'attempt_ended') out(`${body.state === 'done' ? '✔' : '■'} attempt ${body.attempt_n} ended: ${body.state}${why ? dim(` — ${oneLine(why, 160)}`) : ''}`);
        }
    };
    for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let at;
        while ((at = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, at);
            buf = buf.slice(at + 2);
            if (frame.trim()) handle(frame);
        }
    }
    return printable;
}

async function cmdStart(o, c) {
    const repo = repoOf(o.repo);
    if (!o.file) throw new UsageError('--file <path|-> is required: the brief the agent works from');
    const brief = o.file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(o.file, 'utf8');
    if (!brief.trim()) throw new UsageError(`${o.file} is empty`);
    if (o.tier && !['basic', 'standard', 'hard'].includes(o.tier)) throw new UsageError('--tier is basic, standard or hard');
    if (o.machine && o.machine !== 'auto') throw new UsageError('--machine: Codes places a task on a machine of yours by itself; only --machine auto is supported');
    const prompt = o.tier && !/^\s*tier:\s*\S+/im.test(brief) ? `${brief.trimEnd()}\n\ntier: ${o.tier}\n` : brief;
    const body = { repo, prompt };
    const agent = agentOf(o.agent);
    if (agent) body.agent = agent;
    if (o.permission) {
        if (!['review', 'edit', 'full'].includes(o.permission)) throw new UsageError('--permission is review, edit or full');
        body.permission = o.permission;
    }
    if (o.name) {
        if (!/^[A-Za-z0-9_.:-]{4,120}$/.test(o.name)) throw new UsageError('--name: 4-120 letters, digits, "_", ".", ":" or "-" (it is the task\'s idempotency key)');
        body.idempotency_key = `cli:${o.name}`;
    }
    const answer = await call(c, 'POST', '/api/v1/tasks', body);
    if (o.json) { out(JSON.stringify(answer, null, 2)); return EXIT.ok; }
    const task = answer.task;
    out(`${answer.created === false ? 'already started' : 'started'} ${task.id} · ${stateOf(task)}${task.agent ? ` · ${task.agent}` : ''}`);
    out(dim(`  ${task.repo}${task.ref ? ` (${task.ref})` : ''} · ${task.url}`));
    out(dim('  follow it: openvibe-codes task show ' + task.id + ' --follow'));
    return EXIT.ok;
}

async function cmdList(o, c) {
    if (o.state && !STATES[o.state]) throw new UsageError('--state is running, needs or done');
    const q = new URLSearchParams();
    if (o.state) q.set('state', o.state);
    if (o.limit) q.set('limit', String(o.limit));
    const answer = await call(c, 'GET', `/api/v1/tasks${q.toString() ? `?${q}` : ''}`);
    if (o.json) { out(JSON.stringify(answer, null, 2)); return EXIT.ok; }
    const tasks = answer.tasks || [];
    if (!tasks.length) { out(dim(o.state ? `no ${o.state} tasks` : 'no tasks yet')); return EXIT.ok; }
    for (const t of tasks) {
        out(`${stateOf(t).padEnd(7)} ${t.id}  ${(t.agent || '—').padEnd(14)} ${oneLine(t.repo.replace(/^https:\/\/[^/]+\//, ''), 34).padEnd(34)} ${dim(oneLine(t.prompt || '', 60))}`);
    }
    return EXIT.ok;
}

async function cmdShow(o, c) {
    const id = o._[0];
    if (!id) throw new UsageError('which task? openvibe-codes task show <id>');
    if (o.follow) {
        out(dim(`following ${id} …`));
        await follow(c, id);
        const task = await call(c, 'GET', `/api/v1/tasks/${encodeURIComponent(id)}`);
        if (!o.json) printTask(task);
        else out(JSON.stringify(task, null, 2));
        return stateOf(task) === 'done' && (!task.outcome || task.outcome.state !== 'stopped') ? EXIT.ok : EXIT.failed;
    }
    const task = await call(c, 'GET', `/api/v1/tasks/${encodeURIComponent(id)}`);
    if (o.json) { out(JSON.stringify(task, null, 2)); return EXIT.ok; }
    printTask(task);
    return EXIT.ok;
}

async function cmdContinue(o, c) {
    const id = o._[0];
    if (!id) throw new UsageError('which task? openvibe-codes task continue <id> [--note "…"]');
    const body = {};
    if (o.note) body.note = o.note;
    const agent = agentOf(o.agent);
    if (agent) body.agent = agent;
    const task = await call(c, 'POST', `/api/v1/tasks/${encodeURIComponent(id)}/continue`, body);
    if (o.json) { out(JSON.stringify(task, null, 2)); return EXIT.ok; }
    out(`carried on ${task.id} · ${stateOf(task)}`);
    const last = (task.attempts || [])[task.attempts.length - 1];
    if (last) out(dim(`  attempt ${last.n} · ${last.state}${last.agent ? ` · ${last.agent}` : ''}`));
    return EXIT.ok;
}

async function cmdStop(o, c) {
    const id = o._[0];
    if (!id) throw new UsageError('which task? openvibe-codes task stop <id>');
    const task = await call(c, 'POST', `/api/v1/tasks/${encodeURIComponent(id)}/stop`);
    if (o.json) { out(JSON.stringify(task, null, 2)); return EXIT.ok; }
    out(`stopped ${task.id} · ${stateOf(task)}${task.outcome && task.outcome.state ? ` — ${task.outcome.state}` : ''}`);
    return EXIT.ok;
}

const COMMANDS = { start: cmdStart, list: cmdList, show: cmdShow, continue: cmdContinue, stop: cmdStop };

/** `openvibe-codes task …` → the exit code. */
async function task(argv) {
    const [cmd, ...rest] = argv;
    if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { out(USAGE); return cmd ? EXIT.ok : EXIT.usage; }
    const fn = COMMANDS[cmd];
    if (!fn) { out(`unknown task command: ${cmd}\n\n${USAGE}`); return EXIT.usage; }
    let o;
    try {
        o = parse(rest);
        if (o.help) { out(USAGE); return EXIT.ok; }
        return await fn(o, auth());
    } catch (err) {
        const usage = err instanceof UsageError;
        process.stderr.write(`openvibe-codes: ${err.message}\n`);
        if (usage || err.exit === undefined) process.stderr.write(`  (openvibe-codes task --help)\n`);
        return usage ? EXIT.usage : (err.exit || EXIT.failed);
    }
}

module.exports = { task, stateOf, repoOf, agentOf, EXIT };
