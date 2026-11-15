'use strict';

/**
 * `openvibe-codes acp`: Codes as one Agent Client Protocol agent (protocol v1, JSON-RPC over stdin and stdout), so any
 * ACP client (Zed, JetBrains, T3 Code, Neovim's plugins, another Codes) runs the whole harness as one agent: routing to
 * the agent a task fits, hand-off to the next one when an agent fails, stalls or hits its limit, every catalog harness
 * and model, checkpoints and kept runs. What a plain ACP client sees:
 *
 *   models   "auto" (Codes routes each prompt) and every harness this machine can run, as `<harness>` or
 *            `<harness>/<model>` (session/set_model): the editor's model picker is the harness and model swap
 *   modes    read, edit, full: the task's permission level (session/set_mode)
 *   updates  the agents' words (agent_message_chunk), their tool calls and results (tool_call, tool_call_update),
 *            which agent runs and every hand-off (agent_thought_chunk)
 *   turns    a later prompt continues the same agent's session (its resume); after a swap, the new agent gets the
 *            conversation so far; session/load replays a saved session; session/cancel stops the run
 *
 * An OpenVibe-aware client reads more under `_meta.openvibe` (the run id, the agents tried, the cost, the harnesses with
 * why they are not available). Nothing here talks to OpenVibe: it runs on this machine with its agents and keys.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { createHarness } = require('../harness');
const { version: VERSION } = require('../package.json');

const PROTOCOL_VERSION = 1;
const MODES = [
    { id: 'read', name: 'Read only', description: 'The agents read and search; nothing is changed.' },
    { id: 'edit', name: 'Edit files', description: 'The agents may change files in the folder.' },
    { id: 'full', name: 'Full access', description: 'The agents may also run commands.' },
];
const KIND = { Read: 'read', LS: 'read', Grep: 'search', Glob: 'search', Write: 'edit', Edit: 'edit', MultiEdit: 'edit', Bash: 'execute', WebFetch: 'fetch', WebSearch: 'fetch', Advise: 'think' };
const HISTORY_MAX = 40;

function acp({ argv = [], input = process.stdin, output = process.stdout, env = process.env, harness = createHarness({ env }) } = {}) {
    const defaults = { permission: 'edit', agent: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--permission' && MODES.some((m) => m.id === argv[i + 1])) defaults.permission = argv[++i];
        else if (argv[i] === '--agent' && argv[i + 1]) defaults.agent = argv[++i];
    }
    const send = (m) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
    const sessions = new Map();
    const dir = path.join(harness.store.root, 'acp-sessions');
    const file = (id) => path.join(dir, `${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
    const persist = (s) => {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const { controller, ...keep } = s;
        fs.writeFileSync(file(s.id), JSON.stringify(keep), { mode: 0o600 });
    };

    function harnesses() {
        try { return harness.agents(); } catch { return []; }
    }
    function modelsOf(s) {
        const rows = harnesses();
        const available = [{ modelId: 'auto', name: 'Auto', description: 'Codes picks the agent each task fits, and hands it on when one fails' }];
        for (const h of rows) {
            if (!h.available) continue;
            available.push({ modelId: h.id, name: h.name, description: `${h.name}, its own default model` });
            for (const a of h.agents || []) if (a.model && a.model !== h.id) available.push({ modelId: `${h.id}/${a.model}`, name: `${h.name}: ${a.model}` });
        }
        return {
            currentModelId: s.agent ? (s.model ? `${s.agent}/${s.model}` : s.agent) : 'auto',
            availableModels: available.slice(0, 200),
            _meta: { openvibe: { unavailable: rows.filter((h) => !h.available).map((h) => ({ id: h.id, name: h.name, why: h.reason || null })) } },
        };
    }
    const modesOf = (s) => ({ currentModeId: s.permission, availableModes: MODES });

    function newSession(cwd) {
        const s = { id: `ovc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, cwd: path.resolve(String(cwd || process.cwd())),
            permission: defaults.permission, agent: defaults.agent, model: null, last: null, history: [], controller: null };
        sessions.set(s.id, s);
        persist(s);
        return s;
    }
    function sessionOf(params) {
        const s = sessions.get(String((params && params.sessionId) || ''));
        if (!s) throw Object.assign(new Error('no such session'), { code: -32602 });
        return s;
    }

    /** The words of a prompt: text blocks, and embedded resources as their text under their address. */
    function promptText(blocks) {
        const parts = [];
        for (const b of Array.isArray(blocks) ? blocks : []) {
            if (!b || typeof b !== 'object') continue;
            if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
            else if (b.type === 'resource' && b.resource && typeof b.resource.text === 'string') parts.push(`\n<file uri="${String(b.resource.uri || '')}">\n${b.resource.text}\n</file>`);
            else if (b.type === 'resource_link' && b.uri) parts.push(`(see ${b.uri})`);
        }
        return parts.join('\n').trim();
    }

    async function prompt(s, params) {
        const text = promptText(params.prompt);
        if (!text) return { stopReason: 'end_turn' };
        if (s.controller) throw Object.assign(new Error('a prompt is already running in this session'), { code: -32603 });
        const controller = new AbortController();
        s.controller = controller;
        // The same agent continues its own session; a swapped agent (or auto after a swap) gets the conversation so far.
        const prev = s.last;
        const same = prev && prev.session_id && (!s.agent || s.agent === prev.agent);
        const earlier = !same && s.history.length
            ? `The conversation so far (you are taking it over):\n${s.history.slice(-12).map((h) => `${h.role === 'user' ? 'Person' : 'Agent'}: ${h.text.slice(0, 2000)}`).join('\n')}\n\nNow: `
            : '';
        const run = harness.run({
            prompt: `${earlier}${text}`, task: same ? 'resume' : 'edit', agent: same ? prev.agent : s.agent, model: s.model,
            cwd: s.cwd, resume: same ? prev.session_id : null, permission: s.permission, handoff: !same && !s.agent, signal: controller.signal,
        });
        let answer = '';
        let final = null;
        const agents = [];
        try {
            for await (const e of run) {
                if (e.type === 'system' && e.subtype === 'init') {
                    if (e.agent && !agents.includes(e.agent)) agents.push(e.agent);
                    update(s.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `${e.agent || 'an agent'}${e.model ? ` (${e.model})` : ''} is on it.\n` } });
                } else if (e.type === 'system' && e.subtype === 'handoff') {
                    update(s.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `${e.from} handed the task on: ${e.reason}.\n` } });
                } else if (e.type === 'system' && (e.subtype === 'warning' || e.subtype === 'error') && e.text) {
                    update(s.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `${e.text}\n` } });
                } else if (e.type === 'system' && e.subtype === 'tool_progress') {
                    update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: String(e.tool_use_id), status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: String(e.text || '') } }] });
                } else if (e.type === 'assistant') {
                    for (const c of (e.message && e.message.content) || []) {
                        if (c.type === 'text' && c.text) { answer = c.text; update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${c.text}\n` } }); }
                        if (c.type === 'tool_use') {
                            const input = c.input && typeof c.input === 'object' ? c.input : {};
                            const where = input.file_path || input.path || input.command || input.pattern || '';
                            update(s.id, { sessionUpdate: 'tool_call', toolCallId: String(c.id), title: `${c.name}${where ? ` ${String(where).slice(0, 120)}` : ''}`,
                                kind: KIND[c.name] || 'other', status: 'in_progress', rawInput: input,
                                ...(input.file_path || input.path ? { locations: [{ path: path.resolve(s.cwd, String(input.file_path || input.path)) }] } : {}) });
                        }
                    }
                } else if (e.type === 'user') {
                    for (const c of (e.message && e.message.content) || []) {
                        if (c.type === 'tool_result') update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: String(c.tool_use_id), status: c.is_error ? 'failed' : 'completed', content: [{ type: 'content', content: { type: 'text', text: String(c.content || '') } }] });
                    }
                } else if (e.type === 'result') {
                    final = e;
                }
            }
        } finally {
            s.controller = null;
        }
        const saved = harness.store.loadRun(run.runId) || {};
        const lastAttempt = [...(saved.attempts || [])].reverse().find((a) => a.session_id) || null;
        s.last = lastAttempt ? { agent: lastAttempt.agent, session_id: lastAttempt.session_id, model: s.model, run_id: run.runId } : null;
        if (final && final.is_error && !controller.signal.aborted) {
            update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `The task did not finish: ${final.result}\n` } });
        }
        s.history.push({ role: 'user', text }, { role: 'agent', text: (final && final.is_error ? `(did not finish: ${final.result})` : answer) || '' });
        s.history = s.history.slice(-HISTORY_MAX);
        persist(s);
        return {
            stopReason: controller.signal.aborted ? 'cancelled' : 'end_turn',
            _meta: { openvibe: { run_id: run.runId, agents, ok: !!(final && !final.is_error), cost_usd: final ? final.total_cost_usd || 0 : 0 } },
        };
    }

    async function handle(m) {
        const p = m.params || {};
        switch (m.method) {
            case 'initialize':
                return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
                    authMethods: [], agentInfo: { name: 'openvibe-codes', title: 'OpenVibe Codes', version: VERSION } };
            case 'authenticate':
                return {};
            case 'session/new': {
                const s = newSession(p.cwd);
                return { sessionId: s.id, modes: modesOf(s), models: modelsOf(s) };
            }
            case 'session/load': {
                let saved = null;
                try { saved = JSON.parse(fs.readFileSync(file(p.sessionId), 'utf8')); } catch { /* none */ }
                if (!saved) throw Object.assign(new Error('no such session on this machine'), { code: -32602 });
                const s = { ...saved, cwd: path.resolve(String(p.cwd || saved.cwd)), controller: null };
                sessions.set(s.id, s);
                for (const h of s.history) update(s.id, { sessionUpdate: h.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', content: { type: 'text', text: h.text } });
                return { modes: modesOf(s), models: modelsOf(s) };
            }
            case 'session/set_mode': {
                const s = sessionOf(p);
                if (!MODES.some((x) => x.id === p.modeId)) throw Object.assign(new Error('mode is read, edit or full'), { code: -32602 });
                s.permission = p.modeId;
                persist(s);
                return {};
            }
            case 'session/set_model': {
                const s = sessionOf(p);
                const id = String(p.modelId || '');
                if (id === 'auto') { s.agent = null; s.model = null; persist(s); return {}; }
                const [agent, ...rest] = id.split('/');
                const row = harnesses().find((h) => h.id === agent);
                if (!row || !row.available) throw Object.assign(new Error(row ? `${row.name} cannot run here: ${row.reason || 'not available'}` : `no harness ${agent}`), { code: -32602 });
                s.agent = agent;
                s.model = rest.length ? rest.join('/') : null;
                persist(s);
                return {};
            }
            case 'session/prompt':
                return prompt(sessionOf(p), p);
            default:
                throw Object.assign(new Error(`${m.method} is not offered`), { code: -32601 });
        }
    }

    return new Promise((resolve) => {
        const rl = readline.createInterface({ input, crlfDelay: Infinity });
        rl.on('line', (raw) => {
            let m;
            try { m = JSON.parse(raw); } catch { return send({ id: null, error: { code: -32700, message: 'parse error' } }); }
            if (!m || typeof m !== 'object' || !m.method) return undefined;
            if (m.method === 'session/cancel') {
                const s = sessions.get(String((m.params && m.params.sessionId) || ''));
                if (s && s.controller) s.controller.abort();
                return undefined;
            }
            if (m.id === undefined || m.id === null) return undefined;   // another notification: nothing to answer
            Promise.resolve().then(() => handle(m))
                .then((result) => send({ id: m.id, result: result === undefined ? null : result }))
                .catch((err) => send({ id: m.id, error: { code: Number.isInteger(err.code) ? err.code : -32603, message: String(err.message || 'failed').slice(0, 500) } }));
            return undefined;
        });
        rl.on('close', () => { for (const s of sessions.values()) if (s.controller) s.controller.abort(); resolve(0); });
    });
}

module.exports = { acp };
