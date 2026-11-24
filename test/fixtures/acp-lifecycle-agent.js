#!/usr/bin/env node
'use strict';
// Local protocol faults, without a provider or credentials. The test owns this process by PID.
const fs = require('fs');
const readline = require('readline');
const [mode, logFile] = process.argv.slice(2);
const log = (value) => fs.appendFileSync(logFile, `${JSON.stringify(value)}\n`);
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
log({ pid: process.pid });
const stubborn = mode === 'stubborn' || mode === 'timeout';
if (stubborn) {
    process.on('SIGTERM', () => log({ signal: 'SIGTERM' }));
    setInterval(() => {}, 1000);
}
let promptId;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const msg = JSON.parse(line);
    log(msg);
    if (mode === `hang:${msg.method}`) return;
    if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    if (msg.method === 'session/new') return send({ id: msg.id, result: { sessionId: 'lifecycle', models: { availableModels: [{ modelId: 'chosen' }] } } });
    if (msg.method === 'session/load' || msg.method === 'session/set_model') return send({ id: msg.id, result: {} });
    if (msg.method === 'session/cancel') {
        if (mode === 'late-end') return send({ id: promptId, result: { stopReason: 'end_turn' } });
        return;
    }
    if (msg.method !== 'session/prompt') return;
    promptId = msg.id;
    if (mode === 'late-end' || mode === 'timeout') return;
    if (mode !== 'empty-success') send({ method: 'session/update', params: { sessionId: 'lifecycle', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial answer.' } } } });
    const results = { missing: {}, null: null, 'empty-reason': { stopReason: '' }, 'bad-reason': { stopReason: 7 }, 'unknown-reason': { stopReason: 'unknown' }, max_tokens: { stopReason: 'max_tokens' } };
    if (mode === 'no-result') return send({ id: msg.id });
    send({ id: msg.id, result: Object.hasOwn(results, mode) ? results[mode] : { stopReason: 'end_turn' } });
});
process.stdin.on('end', () => { if (!stubborn) process.exit(0); });
