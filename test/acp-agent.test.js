'use strict';
/**
 * `openvibe-codes acp` (bin/acp.js): Codes as one Agent Client Protocol agent, driven over stdio the way Zed or T3 Code
 * drives an agent, with a stand-in OpenAI-compatible server behind the openai-compatible harness. The session offers
 * "auto" and the harnesses as models and read/edit/full as modes; a prompt's tool calls, results and words arrive as
 * session updates; the next prompt continues the same agent's session; a cancel stops the turn; a saved session loads
 * and replays; what the agent cannot do is a JSON-RPC error.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { spawn } = require('child_process');
const { check, done } = require('./helpers/boot');

const CLI = path.join(__dirname, '..', 'bin', 'openvibe-codes.js');

async function mockApi() {
    const requests = [];
    let script = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', async () => {
            requests.push(JSON.parse(body || '{}'));
            const step = script.shift() || { content: 'done' };
            if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: step.content || '', ...(step.calls ? { tool_calls: step.calls.map((c, i) => ({ id: `call_${requests.length}_${i}`, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1]) } })) } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}/v1`, requests, set: (s) => { script = s; requests.length = 0; }, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

/** An ACP client over the agent's stdio: request(method, params) → result; every notification is kept. */
function client(env) {
    const child = spawn(process.execPath, [CLI, 'acp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let next = 1;
    const pending = new Map();
    const updates = [];
    readline.createInterface({ input: child.stdout }).on('line', (raw) => {
        const m = JSON.parse(raw);
        if (m.method === 'session/update') updates.push(m.params.update);
        else if (m.id !== undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code })); else p.resolve(m.result); }
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    return {
        updates,
        request: (method, params) => new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }),
        notify: (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
        close: () => new Promise((r) => { child.on('close', r); child.stdin.end(); }),
        stderr: () => stderr,
    };
}

(async () => {
    const api = await mockApi();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-acp-agent-'));
    const work = path.join(dir, 'work');
    fs.mkdirSync(work);
    // No coding CLI on PATH: only the openai-compatible harness (the stand-in server) can run here.
    const env = { PATH: path.dirname(process.execPath), HOME: dir, OPENVIBE_CODES_HOME: path.join(dir, 'home'), OPENVIBE_CODES_BASE_URL: api.url, OPENVIBE_CODES_MODEL: 'tiny', OPENVIBE_CODES_API_KEY: 'k-1', OPENVIBE_CODES_RG: 'off' };
    const c = client(env);
    let sessionId;
    try {
        await check('initialize and a session: auto and the harnesses as models, read/edit/full as modes', async () => {
            const init = await c.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
            assert.deepStrictEqual([init.protocolVersion, init.agentInfo.name, init.agentCapabilities.loadSession], [1, 'openvibe-codes', true]);
            const s = await c.request('session/new', { cwd: work, mcpServers: [] });
            sessionId = s.sessionId;
            assert.ok(/^ovc_/.test(sessionId));
            assert.deepStrictEqual(s.modes.availableModes.map((m) => m.id), ['read', 'edit', 'full']);
            assert.strictEqual(s.modes.currentModeId, 'edit');
            const ids = s.models.availableModels.map((m) => m.modelId);
            assert.strictEqual(s.models.currentModelId, 'auto');
            assert.ok(ids[0] === 'auto' && ids.includes('openai-compatible'), ids.join(','));
            assert.ok(s.models._meta.openvibe.unavailable.some((h) => h.id === 'claude-code' && h.why), 'and why the others cannot run here');
        });

        await check('a prompt: the tool call, its result and the words arrive as updates; the file is written', async () => {
            await c.request('session/set_model', { sessionId, modelId: 'openai-compatible' });
            api.set([{ calls: [['write_file', { path: 'hello.txt', content: 'hi\n' }]] }, { content: 'Wrote hello.txt.' }]);
            const r = await c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'write hello.txt' }, { type: 'resource', resource: { uri: 'file:///notes.md', text: 'context from the editor' } }] });
            assert.strictEqual(r.stopReason, 'end_turn');
            assert.ok(/^run_/.test(r._meta.openvibe.run_id) && r._meta.openvibe.ok === true && r._meta.openvibe.agents[0] === 'openai-compatible', JSON.stringify(r._meta));
            assert.strictEqual(fs.readFileSync(path.join(work, 'hello.txt'), 'utf8'), 'hi\n');
            const call = c.updates.find((u) => u.sessionUpdate === 'tool_call');
            assert.deepStrictEqual([call.kind, call.status, call.locations[0].path], ['edit', 'in_progress', path.join(work, 'hello.txt')]);
            assert.ok(c.updates.some((u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === call.toolCallId && u.status === 'completed'));
            assert.ok(c.updates.some((u) => u.sessionUpdate === 'agent_message_chunk' && /Wrote hello\.txt\./.test(u.content.text)));
            assert.ok(c.updates.some((u) => u.sessionUpdate === 'agent_thought_chunk' && /openai-compatible/.test(u.content.text)), 'which agent runs');
            assert.ok(api.requests[0].messages.some((m) => m.role === 'user' && /context from the editor/.test(m.content)), 'embedded context rides the prompt');
        });

        await check('the next prompt continues the same agent\'s session; a read-only mode offers no write', async () => {
            await c.request('session/set_mode', { sessionId, modeId: 'read' });
            api.set([{ content: 'second answer' }]);
            const r = await c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'and now?' }] });
            assert.strictEqual(r.stopReason, 'end_turn');
            const sent = api.requests[0];
            assert.ok(sent.messages.some((m) => m.role === 'assistant' && /Wrote hello\.txt\./.test(m.content)), 'the earlier turn came back (resume)');
            assert.ok(!sent.tools.some((t) => t.function.name === 'write_file'), 'read mode: no write tool');
        });

        await check('a cancel stops the turn at once', async () => {
            api.set([{ content: 'too late', delayMs: 4000 }]);
            const t0 = Date.now();
            const pending = c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'something slow' }] });
            setTimeout(() => c.notify('session/cancel', { sessionId }), 300);
            const r = await pending;
            assert.strictEqual(r.stopReason, 'cancelled');
            assert.ok(Date.now() - t0 < 3500, `ended in ${Date.now() - t0} ms`);
        });

        await check('refusals are JSON-RPC errors: an unknown harness or mode, another session, an unknown method', async () => {
            await assert.rejects(c.request('session/set_model', { sessionId, modelId: 'claude-code' }), /cannot run here/);
            await assert.rejects(c.request('session/set_model', { sessionId, modelId: 'nope' }), /no harness nope/);
            await assert.rejects(c.request('session/set_mode', { sessionId, modeId: 'root' }), /read, edit or full/);
            await assert.rejects(c.request('session/prompt', { sessionId: 'ovc_other', prompt: [] }), /no such session/);
            await assert.rejects(c.request('fs/read_text_file', {}), (e) => e.code === -32601);
        });
    } finally {
        await c.close();
    }

    await check('a saved session loads in a new process and replays its conversation', async () => {
        const c2 = client(env);
        try {
            await c2.request('initialize', { protocolVersion: 1 });
            const loaded = await c2.request('session/load', { sessionId, cwd: work, mcpServers: [] });
            assert.strictEqual(loaded.modes.currentModeId, 'read');
            assert.strictEqual(loaded.models.currentModelId, 'openai-compatible');
            const said = c2.updates.map((u) => `${u.sessionUpdate}:${u.content.text}`);
            assert.ok(said.includes('user_message_chunk:write hello.txt\n\n<file uri="file:///notes.md">\ncontext from the editor\n</file>'), said.join(' | '));
            assert.ok(said.includes('agent_message_chunk:Wrote hello.txt.'));
            api.set([{ content: 'after loading' }]);
            const r = await c2.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'still there?' }] });
            assert.strictEqual(r.stopReason, 'end_turn');
            assert.ok(api.requests[0].messages.some((m) => /second answer/.test(String(m.content))), 'the loaded session resumes the agent too');
        } finally { await c2.close(); }
    });

    await api.close();
    fs.rmSync(dir, { recursive: true, force: true });
    done();
})().catch((e) => { console.error(e); process.exit(1); });
