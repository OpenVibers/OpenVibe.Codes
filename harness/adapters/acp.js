'use strict';

/**
 * Any coding agent that speaks the Agent Client Protocol (ACP, agentclientprotocol.com): JSON-RPC 2.0 over the agent's
 * stdin and stdout, one message a line. One adapter runs every agent in the public ACP registry that is launched with
 * npx or uvx (Gemini CLI, Qwen Code, Kimi Code, Grok, GitHub Copilot, Cline, Kilo, LangChain's deepagents, Claude and
 * Codex through their ACP bridges, …), each pinned to the exact version harness/acp-agents.json names. The shape of the
 * conversation follows the protocol's v1 (what T3 Code's MIT-licensed effect-acp client also speaks):
 *
 *   initialize → session/new (or session/load to resume) → [session/set_model] → session/prompt … → stopReason
 *   the agent's session/update notifications → Codes' events (text, tool calls and their results, the plan)
 *   the agent's own requests → answered here: session/request_permission by the task's permission level (read: reads
 *   and searches; edit: also edits; full: also commands), fs/read_text_file and fs/write_text_file inside the working
 *   directory only (the same checks as the API harness's tools); anything else is "method not found".
 *
 * A stop sends session/cancel and gives the agent eight seconds to end its turn before its process is killed.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const ev = require('../events');
const { inside } = require('./api');

const LEVELS = { read: 1, edit: 2, full: 3 };
// What each ACP tool kind needs (protocol v1 ToolKind): a kind the protocol adds later needs full.
const KIND_LEVEL = { read: 1, search: 1, think: 1, fetch: 1, edit: 2, delete: 2, move: 2, execute: 3, switch_mode: 3, other: 3 };
const PROTOCOL_VERSION = 1;
const MAX_LINE = 8 * 1024 * 1024;

/** The option a permission request is answered with: the first allow (once, else always) when the level allows the
 *  tool, else the first reject; null when there is nothing to pick (answered as cancelled). */
function permissionChoice(params, level) {
    const options = Array.isArray(params && params.options) ? params.options : [];
    const kind = String((params && params.toolCall && params.toolCall.kind) || 'other');
    const allowed = (KIND_LEVEL[kind] || 3) <= level;
    const pick = (kinds) => { for (const k of kinds) { const o = options.find((x) => x && x.kind === k); if (o) return o; } return null; };
    const chosen = allowed ? pick(['allow_once', 'allow_always']) : pick(['reject_once', 'reject_always']);
    return { allowed, optionId: chosen ? String(chosen.optionId) : null };
}

/** The words of an ACP content list (tool results, messages): text as it is, a diff as the file it changed. */
function contentText(content) {
    const list = Array.isArray(content) ? content : content ? [content] : [];
    const out = [];
    for (const c of list) {
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'text' && typeof c.text === 'string') out.push(c.text);
        else if (c.type === 'content' && c.content) out.push(contentText(c.content));
        else if (c.type === 'diff' && c.path) out.push(`changed ${c.path}`);
        else if (c.type === 'terminal' && c.terminalId) out.push(`terminal ${c.terminalId}`);
        else if (c.type === 'resource_link' && c.uri) out.push(String(c.uri));
    }
    return out.filter(Boolean).join('\n');
}

/**
 * acpAgent({ id, name, cmd, args, env, version, check }) → a Codes adapter (kind cli: availability looks for cmd on
 * PATH). ctx (harness/index.js): { env }.
 */
function acpAgent(spec) {
    const adapter = {
        id: spec.id, name: spec.name, kind: 'cli', bin: spec.cmd, protocol: 'acp',
        ...(spec.check ? { check: spec.check } : {}),
        start(t, ctx = {}) {
            const env = { ...process.env, ...(ctx.env || {}), ...(spec.env || {}) };
            const cwd = path.resolve(t.cwd || process.cwd());
            const level = LEVELS[t.permission] || 1;
            const startedAt = Date.now();
            const queue = [];
            let wake = null;
            let finished = false;
            const emit = (e) => { if (e) { queue.push(e); if (wake) { const w = wake; wake = null; w(); } } };
            const finish = () => { finished = true; if (wake) { const w = wake; wake = null; w(); } };

            let child = null;
            let nextId = 1;
            const pending = new Map();
            let stderr = '';
            let sessionId = null;
            let replaying = false;
            let text = '';
            let lastText = '';
            let failure = null;
            let stopReason = null;
            let tools = 0;
            let cancelled = false;
            let killTimer = null;
            const seen = new Map();   // toolCallId → { title, done }
            const cost = { usd: 0, any: false };

            const flush = () => { if (text.trim()) { lastText = text; emit(ev.text(text, t.model || spec.model || null)); } text = ''; };
            const send = (msg) => { try { if (child && child.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`); } catch { /* the close handler reports it */ } };
            const request = (method, params) => new Promise((resolve, reject) => {
                const id = nextId++;
                pending.set(id, { resolve, reject, method });
                send({ id, method, params });
            });
            const reply = (id, result) => send({ id, result });
            const replyError = (id, code, message) => send({ id, error: { code, message } });
            const kill = () => { if (child && child.exitCode === null && !child.signalCode) { try { child.kill('SIGTERM'); } catch { /* gone */ } } };

            function onUpdate(params) {
                if (replaying || !params || params.sessionId !== sessionId) return;
                const u = params.update || {};
                switch (u.sessionUpdate) {
                    case 'agent_message_chunk':
                        if (u.content && u.content.type === 'text' && typeof u.content.text === 'string') text += u.content.text;
                        return;
                    case 'tool_call': {
                        flush();
                        const id = String(u.toolCallId || `acp_${tools}`);
                        tools++;
                        seen.set(id, { title: u.title || u.kind || 'tool', done: false });
                        emit(ev.toolUse(id, String(u.title || u.kind || 'Tool').slice(0, 120), u.rawInput && typeof u.rawInput === 'object' ? u.rawInput : { kind: u.kind || 'other' }, t.model || null));
                        if (u.status === 'completed' || u.status === 'failed') { seen.get(id).done = true; emit(ev.toolResult(id, contentText(u.content) || u.status, u.status === 'failed')); }
                        return;
                    }
                    case 'tool_call_update': {
                        const id = String(u.toolCallId || '');
                        const known = seen.get(id);
                        if (!known || known.done) return;
                        const body = contentText(u.content) || (u.rawOutput != null ? (typeof u.rawOutput === 'string' ? u.rawOutput : JSON.stringify(u.rawOutput)) : '');
                        if (u.status === 'completed' || u.status === 'failed') { known.done = true; emit(ev.toolResult(id, body || u.status, u.status === 'failed')); }
                        else if (body) emit(ev.toolProgress(id, body));
                        return;
                    }
                    case 'plan':
                        if (Array.isArray(u.entries) && u.entries.length) emit(ev.warning(`plan: ${u.entries.map((e) => `${e.status === 'completed' ? '✓' : '·'} ${String(e.content || '').slice(0, 120)}`).join(' | ')}`));
                        return;
                    case 'usage_update':
                        if (u.cost && Number.isFinite(+u.cost.amount) && String(u.cost.currency || 'USD').toUpperCase() === 'USD') { cost.usd = +u.cost.amount; cost.any = true; }
                        return;
                    default:
                }
            }

            function onAgentRequest(msg) {
                const p = msg.params || {};
                if (msg.method === 'session/request_permission') {
                    const { allowed, optionId } = permissionChoice(p, level);
                    if (!allowed) emit(ev.warning(`${spec.name} asked to ${String((p.toolCall && (p.toolCall.title || p.toolCall.kind)) || 'act')}: refused at the ${t.permission || 'read'} level`));
                    return reply(msg.id, { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } });
                }
                if (msg.method === 'fs/read_text_file') {
                    const f = inside(cwd, p.path);
                    if (f instanceof Error) return replyError(msg.id, -32602, f.message);
                    try {
                        const lines = fs.readFileSync(f, 'utf8').split('\n');
                        const from = Math.max(1, Number(p.line) || 1);
                        const n = Number(p.limit) > 0 ? Number(p.limit) : lines.length;
                        return reply(msg.id, { content: lines.slice(from - 1, from - 1 + n).join('\n') });
                    } catch (err) { return replyError(msg.id, -32603, err.code === 'ENOENT' ? `no such file: ${p.path}` : err.message); }
                }
                if (msg.method === 'fs/write_text_file') {
                    if (level < LEVELS.edit) return replyError(msg.id, -32603, `writing files needs the edit permission level (this task is ${t.permission || 'read'})`);
                    const f = inside(cwd, p.path, { write: true });
                    if (f instanceof Error) return replyError(msg.id, -32602, f.message);
                    try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, String(p.content == null ? '' : p.content)); return reply(msg.id, null); } catch (err) { return replyError(msg.id, -32603, err.message); }
                }
                return replyError(msg.id, -32601, `${msg.method} is not offered by this client`);
            }

            function onLine(raw) {
                if (!raw || raw.length > MAX_LINE) return;
                let msg;
                try { msg = JSON.parse(raw); } catch { return; }   // an agent's own log line on stdout
                if (!msg || typeof msg !== 'object') return;
                if (msg.method && msg.id !== undefined && msg.id !== null) return onAgentRequest(msg);
                if (msg.method === 'session/update') return onUpdate(msg.params);
                if (msg.id !== undefined && pending.has(msg.id)) {
                    const p = pending.get(msg.id);
                    pending.delete(msg.id);
                    if (msg.error) p.reject(Object.assign(new Error(String(msg.error.message || `${p.method} failed`).slice(0, 300)), { code: msg.error.code, data: msg.error.data }));
                    else p.resolve(msg.result);
                }
            }

            const stop = () => {
                if (cancelled) return;
                cancelled = true;
                if (sessionId) send({ method: 'session/cancel', params: { sessionId } });
                killTimer = setTimeout(kill, 8000);
                if (killTimer.unref) killTimer.unref();
            };
            if (t.signal) { if (t.signal.aborted) cancelled = true; else t.signal.addEventListener('abort', stop, { once: true }); }

            async function run() {
                try {
                    child = spawn(spec.cmd, spec.args || [], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
                } catch (err) { failure = `${spec.name} could not start: ${err.message}`; return; }
                const closed = new Promise((resolve) => {
                    child.on('error', (err) => { stderr += `\n${err.message}`; resolve(); });
                    child.on('close', () => resolve());
                });
                child.stdin.on('error', () => { /* the agent went away: its close reports it */ });
                readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', onLine);
                child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4096); });
                const died = closed.then(() => { throw new Error(`${spec.name} ended${stderr.trim() ? `: ${ev.scrub(stderr.trim().split('\n').pop()).slice(0, 200)}` : ''}`); });
                const timeout = new Promise((_, reject) => { const tm = setTimeout(() => reject(new Error(`${spec.name} ran past its time limit`)), Number(t.timeoutMs) || 45 * 60_000); if (tm.unref) tm.unref(); });
                const call = (method, params) => Promise.race([request(method, params), died, timeout]);
                try {
                    const init = await call('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }, clientInfo: { name: 'openvibe-codes', version: '1' } });
                    const caps = (init && init.agentCapabilities) || {};
                    let session = null;
                    if (t.resume && caps.loadSession) {
                        replaying = true;
                        sessionId = String(t.resume);
                        try { await call('session/load', { sessionId, cwd, mcpServers: [] }); } finally { replaying = false; }
                    } else {
                        if (t.resume) emit(ev.warning(`${spec.name} cannot load an earlier session: it starts a new one`));
                        session = await call('session/new', { cwd, mcpServers: [] });
                        sessionId = String((session && session.sessionId) || '');
                        if (!sessionId) throw new Error(`${spec.name} did not open a session`);
                    }
                    emit(ev.init(sessionId, spec.id, t.model || null));
                    const models = session && session.models && Array.isArray(session.models.availableModels) ? session.models.availableModels : [];
                    if (t.model && models.some((m) => m && m.modelId === t.model)) {
                        await call('session/set_model', { sessionId, modelId: t.model }).catch(() => emit(ev.warning(`${spec.name} kept its own model`)));
                    } else if (t.model && t.model !== spec.model) {
                        emit(ev.warning(`${spec.name} does not offer the model ${t.model} here: it runs its own`));
                    }
                    if (cancelled) { stopReason = 'cancelled'; return; }
                    const answer = await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: String(t.prompt || '') }] });
                    stopReason = String((answer && answer.stopReason) || 'end_turn');
                } catch (err) {
                    // What the agent said before it failed is often the real reason (a plan's usage limit, a missing
                    // sign-in) when its error is only "Internal error": the result carries both.
                    const said = String(text || lastText || '').trim().replace(/\s+/g, ' ').slice(0, 300);
                    failure = cancelled ? `${spec.name} was stopped`
                        : err.code === -32000 || /auth/i.test(err.message) ? `${spec.name} needs a sign-in on this machine: ${err.message}`
                            : `${spec.name}: ${err.message}${said ? ` (it said: ${said})` : ''}`;
                } finally {
                    flush();
                    try { child.stdin.end(); } catch { /* gone */ }
                    const grace = setTimeout(kill, 2000);
                    if (grace.unref) grace.unref();
                    await closed;
                    clearTimeout(grace);
                    if (killTimer) clearTimeout(killTimer);
                }
            }

            run().then(() => {
                if (!failure && stopReason && stopReason !== 'end_turn') {
                    failure = stopReason === 'cancelled' ? `${spec.name} was stopped` : `${spec.name} stopped: ${stopReason}`;
                }
                if (failure && !cancelled) emit(ev.error(failure));
                emit(ev.result({ ok: !failure, text: failure || lastText, sessionId, model: t.model || spec.model || null, startedAt, turns: Math.max(1, tools), costUsd: cost.any ? cost.usd : 0, usage: ev.usage({}) }));
                finish();
            });

            const iterator = (async function* events() {
                while (true) {
                    if (queue.length) { yield queue.shift(); continue; }
                    if (finished) return;
                    await new Promise((r) => { wake = r; });
                }
            }());
            iterator.cancel = stop;
            return iterator;
        },
    };
    return adapter;
}

/** The registry's launch line for an agent: npx and uvx packages at their exact versions; binaries are not run. */
function launchOf(entry) {
    const d = (entry && entry.distribution) || {};
    if (d.npx && d.npx.package) return { cmd: 'npx', args: ['-y', String(d.npx.package), ...(d.npx.args || []).map(String)], env: d.npx.env || {} };
    if (d.uvx && d.uvx.package) return { cmd: 'uvx', args: [String(d.uvx.package), ...(d.uvx.args || []).map(String)], env: d.uvx.env || {} };
    return null;
}

module.exports = { acpAgent, launchOf, permissionChoice, contentText, KIND_LEVEL };
