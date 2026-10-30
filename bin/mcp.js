'use strict';

/**
 * `openvibe-codes mcp` — the Codes MCP server: the conductor's tools (Codes C9b). A stdio JSON-RPC server, started by
 * the Claude Code session a conductor's turn runs, and usable from any Claude Code session with a Codes login.
 *
 *   codes_task_start    { prompt, repo, agent?, model? }   a sub-task on one of the person's machines
 *   codes_task_list     { state? }                          running | needs | done
 *   codes_task_show     { id }                              state, attempts, outcome, the last lines
 *   codes_task_continue { id, message }                     carry a task on in the same conversation
 *   codes_task_stop     { id }                              stop it; nothing carries it on
 *   codes_fleet         {}                                  each coding CLI here: installed, signed in, limit windows
 *   codes_ship_status   { repo, pr }                        a pull request's CI and merge state, from GitHub
 *   codes_approve       { tool_name, input?, summary? }     what Claude Code asks when the owner's safety level is ask
 *
 * Who it acts as: the person whose Codes token is on the machine — OPENVIBE_TOKEN, or ~/.config/openvibe/token. The
 * server address is OPENVIBE_CODES_URL. The conductor's task is OPENVIBE_CONDUCTOR_TASK: sub-tasks run in its project,
 * and approvals are asked on its page.
 *
 * The rule the server enforces for the conductor (and for this client): a sub-task never runs on an Anthropic model.
 * The conductor is the only Anthropic session; the server refuses claude-code, claude-other and any Anthropic model,
 * and this client answers with that refusal rather than working around it.
 *
 * JSON-RPC over stdin/stdout, one message per line (the portal's approve-mcp.js shape).
 */
const os = require('os');
const { auth, call } = require('./task');
const { probe: probeLogins } = require('../engine/logins');

const APPROVAL_TIMEOUT_MS = Math.max(10_000, Number(process.env.APPROVAL_TIMEOUT_MS) || 15 * 60_000);
const POLL_MS = 2500;
const TASK = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const REPO = /^https:\/\/[^\s@]+\/[^\s@]+$/;

/** A repository as an https URL: owner/name, a URL, or a path whose origin is one. */
function repoUrl(value) {
    const v = String(value || '').trim();
    if (!v) return null;
    if (REPO.test(v)) return v.replace(/\.git$/, '');
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) return `https://github.com/${v.replace(/\.git$/, '')}`;
    return null;
}

function githubRepo(value) {
    const v = repoUrl(value) || String(value || '').trim();
    const m = /^https?:\/\/(?:[^@/\s]+@)?(?:github\.com|api\.github\.com)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(v);
    return m ? { owner: m[1], name: m[2] } : null;
}

/** The task the conductor is running as, when this server is inside one. */
function conductorTask() {
    const id = String(process.env.OPENVIBE_CONDUCTOR_TASK || '').trim();
    return TASK.test(id) ? id : null;
}

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const failed = (message) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(message).slice(0, 800) }) }], isError: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOOLS = [
    {
        name: 'codes_task_start',
        description: 'Start a coding task on one of the owner\'s machines, in a repository. Never on an Anthropic model (the conductor is the only Anthropic session). The brief must stand alone: the goal, the constraints, the files, and what "done" means.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'The brief, in full' },
                repo: { type: 'string', description: 'owner/name or an https git URL' },
                agent: { type: 'string', description: 'codex, opencode, command-code, deepseek, aider: never claude-code or claude-other' },
                model: { type: 'string', description: 'The model for that agent (never an Anthropic one)' },
                ref: { type: 'string', description: 'A branch or tag to start from' },
            },
            required: ['prompt', 'repo'],
            additionalProperties: true,
        },
    },
    {
        name: 'codes_task_list',
        description: 'The owner\'s tasks, newest first: running (queued, placed or running), needs (unfinished, waiting for a person) or done.',
        inputSchema: { type: 'object', properties: { state: { type: 'string', enum: ['running', 'needs', 'done'], description: 'Narrow the list' }, limit: { type: 'number' } }, additionalProperties: true },
    },
    {
        name: 'codes_task_show',
        description: 'One task: its state, its attempts (agent, machine, why each ended), its outcome in plain words, and the last lines of its session.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' }, lines: { type: 'number' } }, required: ['id'], additionalProperties: true },
    },
    {
        name: 'codes_task_continue',
        description: 'Carry a task on in the same conversation, with a note on what to do next.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' }, message: { type: 'string' }, agent: { type: 'string' } }, required: ['id', 'message'], additionalProperties: true },
    },
    {
        name: 'codes_task_stop',
        description: 'Stop a task: its running attempt stops and nothing carries it on.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: true },
    },
    {
        name: 'codes_fleet',
        description: 'The coding CLIs on this machine: installed, signed in, and their limit windows (read from the CLIs\' own files, read-only).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    },
    {
        name: 'codes_ship_status',
        description: 'A GitHub pull request\'s state: CI, merge state, title and branch. Read-only.',
        inputSchema: { type: 'object', properties: { repo: { type: 'string' }, pr: { type: 'number', description: 'The pull request number' } }, required: ['repo', 'pr'], additionalProperties: true },
    },
    {
        name: 'codes_approve',
        description: 'Ask the owner to approve a tool call (Claude Code calls this; the owner answers on openvibe.codes or their phone). Returns {behavior: "allow"|"deny", updatedInput?, message?}.',
        inputSchema: {
            type: 'object',
            properties: {
                tool_name: { type: 'string', description: 'The tool that wants to run' },
                input: { type: 'object', description: 'The arguments of that tool' },
                summary: { type: 'string', description: 'A short line for the owner' },
            },
            required: ['tool_name'],
            additionalProperties: true,
        },
    },
];

// ── The tools ───────────────────────────────────────────────────────────────────────────────────────────────────

async function startTask(args) {
    const task = conductorTask();
    if (!task) return failed('codes_task_start needs OPENVIBE_CONDUCTOR_TASK: it starts sub-tasks of the conductor task');
    const prompt = String(args.prompt || '').trim();
    if (!prompt) return failed('a sub-task needs a prompt');
    const repo = repoUrl(args.repo);
    if (!repo) return failed('a sub-task needs the repository it works in: owner/name or an https git URL');
    const agent = args.agent ? String(args.agent) : null;
    const model = args.model ? String(args.model) : null;
    if (agent && /^(claude-code|claude-other|claude|cm)$/i.test(agent)) return failed('the conductor may start sub-tasks on any agent except an Anthropic one: that session is the conductor itself');
    if (model && /(^|[^a-z])(claude|opus|sonnet|haiku|anthropic)([^a-z]|$)/i.test(model)) return failed('the conductor may start sub-tasks on any agent except an Anthropic model: that session is the conductor itself');
    const c = auth();
    const answer = await call(c, 'POST', `/api/v1/conductor/${encodeURIComponent(task)}/tasks`, {
        prompt, repo, ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(args.ref ? { ref: String(args.ref).slice(0, 100) } : {}),
    });
    const t = answer.task || {};
    return text({
        id: t.id, state: t.state, agent: t.agent, model: model || null, repo: t.repo, url: t.url,
        ...(args.machine || args.effort ? { note: 'machine and effort are not fields of a Codes task yet: Run places it on one of the owner\'s machines, and the agent\'s own effort applies' } : {}),
    });
}

async function listTasks(args) {
    const q = new URLSearchParams();
    if (args.state) q.set('state', String(args.state));
    if (args.limit) q.set('limit', String(Math.min(100, Math.max(1, Number(args.limit) || 20))));
    const answer = await call(auth(), 'GET', `/api/v1/tasks${q.toString() ? `?${q}` : ''}`);
    return text({
        tasks: (answer.tasks || []).map((t) => ({
            id: t.id, state: t.state, agent: t.agent, repo: t.repo,
            outcome: t.outcome ? t.outcome.state : null,
            note: t.outcome && t.outcome.note ? String(t.outcome.note).slice(0, 300) : null,
            brief: String(t.prompt || '').split('\n')[0].slice(0, 160),
        })),
    });
}

async function showTask(args) {
    const id = String(args.id || '');
    if (!TASK.test(id)) return failed('that is not a task id (tsk_…)');
    const c = auth();
    const t = await call(c, 'GET', `/api/v1/tasks/${encodeURIComponent(id)}`);
    const want = Math.min(100, Math.max(1, Number(args.lines) || 20));
    let lines = [];
    try { lines = (await call(c, 'GET', `/api/v1/tasks/${encodeURIComponent(id)}/lines?limit=${want}`)).lines || []; } catch { lines = []; }
    return text({
        id: t.id, state: t.state, repo: t.repo, agent: t.agent,
        outcome: t.outcome ? { state: t.outcome.state, note: t.outcome.note } : null,
        attempts: (t.attempts || []).map((a) => ({ n: a.n, agent: a.agent, model: a.model, machine: a.machine, state: a.state, why: a.why, end_why: a.end_why })),
        summary: t.result && t.result.summary ? String(t.result.summary).slice(0, 4000) : null,
        error: t.error || null,
        last_lines: lines.map((l) => {
            const b = l.body || {};
            if (typeof b === 'string') return b;
            if (b.t === 'tool') return `→ ${b.name || ''} ${String((b.input && (b.input.command || b.input.file_path)) || b.what || '').slice(0, 200)}`.trim();
            if (b.t === 'tool_result') return `  ${b.ok === false ? '✗' : '·'} ${String(b.output || '').split('\n')[0].slice(0, 200)}`;
            if (b.t === 'done') return `done${b.ok === false ? ' (failed)' : ''}: ${String(b.text || '').split('\n')[0].slice(0, 300)}`;
            return String(b.text || b.message || '').split('\n')[0].slice(0, 300);
        }).filter(Boolean),
    });
}

async function continueTask(args) {
    const id = String(args.id || '');
    if (!TASK.test(id)) return failed('that is not a task id (tsk_…)');
    const message = String(args.message || '').trim();
    if (!message) return failed('codes_task_continue needs a message: what the task should do next');
    const t = await call(auth(), 'POST', `/api/v1/tasks/${encodeURIComponent(id)}/continue`, {
        note: message, ...(args.agent ? { agent: String(args.agent) } : {}),
    });
    return text({ id: t.id, state: t.state, outcome: t.outcome ? t.outcome.state : null });
}

async function stopTask(args) {
    const id = String(args.id || '');
    if (!TASK.test(id)) return failed('that is not a task id (tsk_…)');
    const t = await call(auth(), 'POST', `/api/v1/tasks/${encodeURIComponent(id)}/stop`);
    return text({ id: t.id, state: t.state, outcome: t.outcome ? t.outcome.state : null });
}

async function fleet() {
    const rows = probeLogins({ home: os.homedir() });
    return text({
        machine: os.hostname(),
        agents: rows.map((r) => ({
            agent: r.id, installed: !!r.installed, signed_in: !!r.signed_in,
            version: r.version || null,
            windows: (r.windows || []).map((w) => ({ name: w.name, used: w.used == null ? null : w.used, limit: w.limit == null ? null : w.limit, resets_at: w.resets_at || null })),
        })),
    });
}

async function shipStatus(args) {
    const gh = githubRepo(args.repo);
    const pr = Number(args.pr);
    if (!gh) return failed('repo is owner/name or a GitHub URL');
    if (!Number.isInteger(pr) || pr < 1) return failed('pr is the pull request number');
    const base = String(process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
    const token = String(process.env.GITHUB_TOKEN || '').trim();
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'openvibe-codes', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const get = async (p) => {
        const res = await fetch(`${base}${p}`, { headers, signal: AbortSignal.timeout(10_000) });
        const doc = await res.json().catch(() => null);
        return { status: res.status, ok: res.ok, doc };
    };
    const out = await get(`/repos/${gh.owner}/${gh.name}/pulls/${pr}`);
    if (!out.ok || !out.doc) return failed(`GitHub answered ${out.status} for ${gh.owner}/${gh.name}#${pr}`);
    const d = out.doc;
    let ci = null;
    const sha = d.head && d.head.sha ? String(d.head.sha) : null;
    if (sha && /^[0-9a-f]{7,40}$/i.test(sha)) {
        const st = await get(`/repos/${gh.owner}/${gh.name}/commits/${sha}/status`);
        if (st.ok && st.doc) ci = ({ success: 'Passed', failure: 'Failed', error: 'Errored', pending: 'Running' })[st.doc.state] || null;
    }
    return text({
        repo: `${gh.owner}/${gh.name}`, pr, title: d.title || null,
        state: d.merged ? 'merged' : d.state === 'closed' ? 'closed' : 'open',
        draft: !!d.draft, mergeable: d.mergeable == null ? null : !!d.mergeable, mergeable_state: d.mergeable_state || null,
        ci, branch: d.head && d.head.ref ? d.head.ref : null, base: d.base && d.base.ref ? d.base.ref : null,
    });
}

/**
 * Ask the owner: one approval on the conductor's page (or its task), then wait for the decision. The answer is the
 * shape Claude Code's permission prompt tool expects.
 */
async function approve(args) {
    const task = conductorTask();
    if (!task) return failed('codes_approve needs OPENVIBE_CONDUCTOR_TASK: it asks about a conductor\'s tool call');
    const tool = String(args.tool_name || args.tool || '').trim();
    if (!tool) return failed('which tool? pass tool_name');
    const input = args.input && typeof args.input === 'object' && !Array.isArray(args.input) ? args.input : {};
    const c = auth();
    let created;
    try {
        created = await call(c, 'POST', `/api/v1/tasks/${encodeURIComponent(task)}/approvals`, {
            tool, input, ...(args.summary ? { summary: String(args.summary).slice(0, 400) } : {}),
        });
    } catch (e) {
        return { behavior: 'deny', message: `the approval could not be asked: ${e.message}` };
    }
    if (created.decision) return { behavior: created.decision === 'allow' ? 'allow' : 'deny', message: created.message || 'already decided' };
    const until = Date.now() + APPROVAL_TIMEOUT_MS;
    while (Date.now() < until) {
        await sleep(POLL_MS);
        let st = null;
        try { st = await call(c, 'GET', `/api/v1/tasks/${encodeURIComponent(task)}/approvals/${encodeURIComponent(created.id)}?wait=1`); } catch { st = null; }
        if (st && st.decision) {
            return {
                behavior: st.decision === 'allow' ? 'allow' : 'deny',
                message: st.message || (st.decision === 'allow' ? 'the owner said yes' : 'the owner said no'),
            };
        }
    }
    return { behavior: 'deny', message: `no answer from the owner in ${Math.round(APPROVAL_TIMEOUT_MS / 60000)} minutes` };
}

const RUNNERS = {
    codes_task_start: startTask,
    codes_task_list: listTasks,
    codes_task_show: showTask,
    codes_task_continue: continueTask,
    codes_task_stop: stopTask,
    codes_fleet: fleet,
    codes_ship_status: shipStatus,
    codes_approve: approve,
};

// ── JSON-RPC over stdio ─────────────────────────────────────────────────────────────────────────────────────────

function reply(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); }
function fail(id, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: String(message).slice(0, 800) } })}\n`); }

async function handle(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') return reply(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'openvibe-codes', version: require('../package.json').version } });
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return undefined;
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: TOOLS });
    if (method === 'tools/call') {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        const fn = RUNNERS[name];
        if (!fn) return fail(id, `unknown tool: ${name}`);
        try {
            const out = await fn(args);
            // Every tool answers with MCP content; the tools that return a plain object (approve does, because Claude
            // Code reads its JSON) are wrapped here.
            return reply(id, out && Array.isArray(out.content) ? out : text(out));
        } catch (e) {
            // A refusal from the server (422, 409) is an answer to the conductor, not a crash of the server.
            return reply(id, failed((e && e.message) || String(e)));
        }
    }
    if (id != null) return fail(id, `unknown method: ${method}`);
    return undefined;
}

/** `openvibe-codes mcp` → the exit code (it runs until stdin closes). */
function mcp() {
    let buf = '';
    process.stdin.on('data', (chunk) => {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            handle(msg).catch((e) => { if (msg && msg.id != null) fail(msg.id, (e && e.message) || String(e)); });
        }
    });
    process.stdin.on('end', () => process.exit(0));
    return undefined;
}

module.exports = { mcp, TOOLS, RUNNERS, repoUrl, githubRepo, handle };

if (require.main === module) mcp();
