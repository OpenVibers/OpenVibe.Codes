#!/usr/bin/env node
'use strict';
// A stand-in ACP agent (protocol v1, JSON-RPC over stdio) for test/harness-acp.test.js. It logs every message it gets
// to MOCK_ACP_LOG (JSON lines). Its prompt decides what it does: "wait" waits for session/cancel; "escape" reads a file
// outside the working directory; "die" exits mid-turn; anything else reads note.txt through the client, asks to edit
// (then writes out.txt) and to run a command, and answers with what it read.
const fs = require('fs');
const readline = require('readline');

const log = (m) => { if (process.env.MOCK_ACP_LOG) fs.appendFileSync(process.env.MOCK_ACP_LOG, `${JSON.stringify(m)}\n`); };
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
let next = 1000;
const waiting = new Map();
const ask = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); send({ id, method, params }); });
let cwd = process.cwd();
let cancelResolve = null;

process.stdout.write('mock agent starting (a log line, not JSON)\n');

async function prompt(id, params) {
    const sid = params.sessionId;
    const words = params.prompt.map((p) => p.text).join(' ');
    if (words === 'wait') {
        await new Promise((r) => { cancelResolve = r; });
        return send({ id, result: { stopReason: 'cancelled' } });
    }
    if (words === 'limit') { update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'You have hit your usage limit.' } }); return send({ id, error: { code: -32603, message: 'Internal error' } }); }
    if (words === 'die') { update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'about to go' } }); process.exit(3); }
    if (words === 'escape') {
        const r = await ask('fs/read_text_file', { sessionId: sid, path: '/etc/hostname' });
        log({ escape: r });
        update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: r.error ? 'refused' : 'read it' } });
        return send({ id, result: { stopReason: 'end_turn' } });
    }
    update(sid, { sessionUpdate: 'plan', entries: [{ content: 'read the note', status: 'in_progress', priority: 'high' }] });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reading ' } });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the note.' } });
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read note.txt', kind: 'read', status: 'in_progress', rawInput: { path: `${cwd}/note.txt` } });
    const read = await ask('fs/read_text_file', { sessionId: sid, path: `${cwd}/note.txt`, line: 1, limit: 1 });
    log({ read });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: read.result ? read.result.content : 'none' } }] });
    const edit = await ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 't2', title: 'Write out.txt', kind: 'edit' },
        options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] });
    log({ permission_edit: edit.result });
    if (edit.result && edit.result.outcome.optionId === 'yes') {
        const w = await ask('fs/write_text_file', { sessionId: sid, path: `${cwd}/out.txt`, content: 'written by the agent\n' });
        log({ write: w });
    }
    const exec = await ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 't3', title: 'npm test', kind: 'execute' },
        options: [{ optionId: 'run', name: 'Run', kind: 'allow_once' }, { optionId: 'skip', name: 'Skip', kind: 'reject_once' }] });
    log({ permission_execute: exec.result });
    update(sid, { sessionUpdate: 'usage_update', used: 1200, size: 128000, cost: { amount: 0.0125, currency: 'USD' } });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Done: ${read.result ? read.result.content : '?'}` } });
    send({ id, result: { stopReason: 'end_turn' } });
}

readline.createInterface({ input: process.stdin }).on('line', (raw) => {
    const m = JSON.parse(raw);
    log(m);
    if (m.id !== undefined && waiting.has(m.id) && !m.method) { const r = waiting.get(m.id); waiting.delete(m.id); return r(m); }
    if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: {} }, authMethods: [] } });
    if (m.method === 'session/new') { cwd = m.params.cwd; return send({ id: m.id, result: { sessionId: 'mock-1', models: { currentModelId: 'mock-small', availableModels: [{ modelId: 'mock-small', name: 'Small' }, { modelId: 'mock-large', name: 'Large' }] } } }); }
    if (m.method === 'session/load') {
        cwd = m.params.cwd;
        update(m.params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'the earlier question' } });
        update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the earlier answer' } });
        return send({ id: m.id, result: null });
    }
    if (m.method === 'session/set_model') return send({ id: m.id, result: {} });
    if (m.method === 'session/prompt') return prompt(m.id, m.params);
    if (m.method === 'session/cancel') { if (cancelResolve) cancelResolve(); return undefined; }
    if (m.id !== undefined) return send({ id: m.id, error: { code: -32601, message: 'unknown method' } });
    return undefined;
});
process.stdin.on('end', () => process.exit(0));
