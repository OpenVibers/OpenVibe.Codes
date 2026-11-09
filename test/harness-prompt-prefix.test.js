'use strict';
/**
 * The prompt prefix is byte-identical between two different tasks (stage S3, cache-stable prompts): the system message
 * and the tool schemas never carry the task, tools come in a fixed name order, and only the user message differs.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createHarness } = require('../harness');
const { createStore } = require('../harness/sessions');
const { SYSTEM } = require('../harness/adapters/api');
const { check, done } = require('./helpers/boot');

/** A chat-completions server that records each request and always answers with a plain reply. */
async function mockApi() {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            requests.push(JSON.parse(body || '{}'));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) };
}

const collect = async (run) => { const out = []; for await (const e of run) out.push(e); return out; };
/** The stable prefix of one request as it is serialized: the model, the system message and the tools, in that order. */
const prefixOf = (body) => JSON.stringify({ model: body.model, messages: [body.messages[0]], tools: body.tools, tool_choice: body.tool_choice });

(async () => {
    const api = await mockApi();
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-prefix-'));
        const work = path.join(dir, 'work');
        fs.mkdirSync(work, { recursive: true });
        // An empty environment: the harness reads its base url and model from here, never from the machine's own.
        const env = { PATH: '/nonexistent', OPENVIBE_CODES_HOME: path.join(dir, 'home'), OPENVIBE_CODES_BASE_URL: api.url, OPENVIBE_CODES_MODEL: 'tiny', OPENVIBE_CODES_API_KEY: 'k-123' };
        const h = createHarness({ env, store: createStore({ env }) });

        await check('the system message never carries the task or a date', async () => {
            assert.ok(SYSTEM.trim().length > 100);
            assert.ok(!/\d{4}-\d{2}-\d{2}/.test(SYSTEM), 'no date in the stable system message');
        });

        await check('two tasks send the same model, system message and tools; only the prompt differs', async () => {
            await collect(h.run({ prompt: 'rename name to count', agent: 'openai-compatible', cwd: work, permission: 'edit', handoff: false }));
            await collect(h.run({ prompt: 'a much longer second task about the same repository', agent: 'openai-compatible', cwd: work, permission: 'edit', handoff: false }));
            assert.strictEqual(api.requests.length, 2);
            const [a, b] = api.requests;
            assert.strictEqual(prefixOf(a), prefixOf(b), 'the serialized prefix is byte-identical');
            assert.strictEqual(a.messages[0].role, 'system');
            assert.strictEqual(a.messages[1].role, 'user');
            assert.strictEqual(a.messages[1].content, 'rename name to count');
            assert.strictEqual(b.messages[1].content, 'a much longer second task about the same repository');
        });

        await check('tool schemas serialize in a fixed name order', async () => {
            const names = api.requests[0].tools.map((t) => t.function.name);
            assert.deepStrictEqual(names, [...names].sort(), 'tools are offered in name order');
            assert.deepStrictEqual(names, ['edit_file', 'grep', 'list_dir', 'read_file', 'write_file']);
            assert.strictEqual(JSON.stringify(api.requests[0].tools), JSON.stringify(api.requests[1].tools));
        });
    } finally {
        await api.close();
        done();
    }
})();
