'use strict';
/**
 * The API agent (harness/adapters/api.js) against a stand-in OpenAI-compatible server: the model's tool calls run inside
 * the working directory and the loop ends on an answer; usage and cost come from the API's own counts; the permission
 * level decides which tools exist; a path out of the working directory, a .env file or a .git write is refused; an HTTP
 * error ends the run with the server's message; resume continues the saved conversation.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createHarness } = require('../harness');
const { createStore } = require('../harness/sessions');
const { check, done } = require('./helpers/boot');

/** A chat-completions server that answers from a script: each request gets the next scripted message. */
async function mockApi() {
    const requests = [];
    let script = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            const parsed = JSON.parse(body || '{}');
            requests.push({ auth: req.headers.authorization || null, body: parsed });
            const step = script.shift();
            if (!step) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); return; }
            if (step.status) { res.writeHead(step.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: step.error } })); return; }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: step.content || '', ...(step.calls ? { tool_calls: step.calls.map((c, i) => ({ id: `call_${requests.length}_${i}`, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1]) } })) } : {}) } }], usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 400 }, ...(step.x ? { x_openvibe: step.x } : {}) }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, requests, set: (s) => { script = s; requests.length = 0; }, close: () => new Promise((r) => server.close(r)) };
}

const collect = async (run) => { const out = []; for await (const e of run) out.push(e); return out; };
const toolResults = (events) => events.filter((e) => e.type === 'user').flatMap((e) => e.message.content);

(async () => {
    const api = await mockApi();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-api-'));
    const work = path.join(dir, 'work');
    fs.mkdirSync(path.join(work, 'src'), { recursive: true });
    fs.writeFileSync(path.join(work, 'src', 'a.js'), 'const name = 1;\nmodule.exports = name;\n');
    fs.writeFileSync(path.join(work, '.env'), 'SECRET=1\n');
    fs.writeFileSync(path.join(dir, 'outside.txt'), 'outside');
    fs.mkdirSync(path.join(dir, 'outside-dir'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'outside-dir', 'secret.txt'), 'OUTSIDE-SECRET-KEY\n');
    // Symlinks inside the working directory: they resolve textually inside it, but point out (or at .env).
    fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(work, 'outside-link'));
    fs.symlinkSync(path.join(work, '.env'), path.join(work, 'env-link'));
    fs.symlinkSync(path.join(dir, 'outside-dir'), path.join(work, 'dir-link'));
    const env = { PATH: '/nonexistent', OPENVIBE_CODES_HOME: path.join(dir, 'home'), OPENVIBE_CODES_BASE_URL: api.url, OPENVIBE_CODES_MODEL: 'tiny', OPENVIBE_CODES_API_KEY: 'k-123' };
    const h = createHarness({ env, store: createStore({ env }) });

    await check('the model\'s tool calls run in the working directory and the loop ends on its answer', async () => {
        api.set([
            { calls: [['list_dir', { path: 'src' }], ['read_file', { path: 'src/a.js' }]] },
            { calls: [['edit_file', { path: 'src/a.js', old_string: 'const name = 1;', new_string: 'const count = 1;' }]] },
            { content: 'Renamed name to count in src/a.js.' },
        ]);
        const events = await collect(h.run({ prompt: 'rename name to count', agent: 'openai-compatible', cwd: work, permission: 'edit', handoff: false }));
        assert.strictEqual(fs.readFileSync(path.join(work, 'src', 'a.js'), 'utf8'), 'const count = 1;\nmodule.exports = name;\n');
        const r = events.find((e) => e.type === 'result');
        assert.strictEqual(r.is_error, false, r.result);
        assert.strictEqual(r.result, 'Renamed name to count in src/a.js.');
        assert.strictEqual(r.num_turns, 3);
        assert.deepStrictEqual([r.usage.input_tokens, r.usage.cache_read_input_tokens, r.usage.output_tokens], [1800, 1200, 300]);
        assert.ok(toolResults(events).some((c) => c.content.includes('a.js')), 'the listing came back');
        assert.ok(toolResults(events).some((c) => c.content.includes('1\tconst name = 1;')), 'the file came back with line numbers');
        assert.strictEqual(api.requests[0].auth, 'Bearer k-123');
        assert.strictEqual(api.requests[0].body.model, 'tiny');
        assert.deepStrictEqual(api.requests[0].body.tools.map((t) => t.function.name).sort(), ['edit_file', 'grep', 'list_dir', 'read_file', 'write_file']);
        assert.strictEqual(api.requests[2].body.messages.filter((m) => m.role === 'tool').length, 3, 'every tool result went back to the model');
    });

    await check('OpenVibe.AI: the app\'s Network token is fetched once and reused, and the cost is what AI reported', async () => {
        const tokenCalls = [];
        const network = http.createServer((req, res) => {
            let body = '';
            req.on('data', (d) => { body += d; });
            req.on('end', () => {
                tokenCalls.push({ path: req.url, body: Object.fromEntries(new URLSearchParams(body)) });
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ access_token: 'ov-app-token', token_type: 'Bearer', expires_in: 300 }));
            });
        });
        await new Promise((r) => network.listen(0, '127.0.0.1', r));
        const aiEnv = { ...env, OPENVIBE_AI_URL: api.url, OPENVIBE_NETWORK_URL: `http://127.0.0.1:${network.address().port}`, OPENVIBE_APP_ID: 'app_01JAB2C3D4E5F6G7H8J9K0MNPQ', OPENVIBE_APP_SECRET: 's'.repeat(40) };
        const ai = createHarness({ env: aiEnv, store: createStore({ env: aiEnv }) });
        try {
            api.set([
                { calls: [['read_file', { path: 'src/a.js' }]], x: { run_id: 'run_1', cost_usd: 0.0021 } },
                { content: 'It exports name.', x: { run_id: 'run_2', cost_usd: 0.0009 } },
            ]);
            const events = await collect(ai.run({ prompt: 'what does a.js export?', agent: 'openvibe-ai', cwd: work, permission: 'read', handoff: false }));
            const r = events.find((e) => e.type === 'result');
            assert.strictEqual(r.is_error, false, r.result);
            assert.strictEqual(r.result, 'It exports name.');
            assert.deepStrictEqual(api.requests.map((q) => q.auth), ['Bearer ov-app-token', 'Bearer ov-app-token']);
            assert.strictEqual(api.requests[0].body.model, 'openvibe');
            assert.strictEqual(tokenCalls.length, 1, 'one token for both turns');
            assert.deepStrictEqual([tokenCalls[0].path, tokenCalls[0].body.grant_type, tokenCalls[0].body.audience, tokenCalls[0].body.client_id], ['/oauth/token', 'client_credentials', 'openvibe.ai', 'app_01JAB2C3D4E5F6G7H8J9K0MNPQ']);
            assert.ok(Math.abs(r.total_cost_usd - 0.003) < 1e-9, `cost ${r.total_cost_usd}`);
            assert.ok(!('x_openvibe' in api.requests[0].body), 'the router, when no project provider is named');
            // OPENVIBE_AI_SECRET names the project's own provider: every request carries it for AI to use.
            const ownEnv = { ...aiEnv, OPENVIBE_AI_SECRET: 'deepseek-key', OPENVIBE_AI_PROVIDER_URL: 'https://api.deepseek.com/v1', OPENVIBE_AI_PROVIDER_MODEL: 'deepseek-chat' };
            const own = createHarness({ env: ownEnv, store: createStore({ env: ownEnv }) });
            api.set([{ content: 'done' }]);
            const before = api.requests.length;
            const done = (await collect(own.run({ prompt: 'hi', agent: 'openvibe-ai', cwd: work, permission: 'read', handoff: false }))).find((e) => e.type === 'result');
            assert.strictEqual(done.is_error, false, done.result);
            assert.deepStrictEqual(api.requests[before].body.x_openvibe, { provider: { base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', secret: 'deepseek-key' } });
        } finally { await new Promise((r) => network.close(r)); }
    });

    await check('read permission offers no writing tool, and a forced write is refused', async () => {
        api.set([{ calls: [['write_file', { path: 'src/new.js', content: 'x' }]] }, { content: 'ok' }]);
        const events = await collect(h.run({ prompt: 'look', agent: 'openai-compatible', cwd: work, permission: 'read', handoff: false }));
        assert.deepStrictEqual(api.requests[0].body.tools.map((t) => t.function.name).sort(), ['grep', 'list_dir', 'read_file']);
        assert.ok(!fs.existsSync(path.join(work, 'src', 'new.js')));
        assert.ok(toolResults(events).some((c) => c.is_error && /needs the edit permission level/.test(c.content)));
    });

    await check('a path out of the working directory, a .env file and a .git write are refused', async () => {
        api.set([{ calls: [['read_file', { path: '../outside.txt' }], ['read_file', { path: '/etc/passwd' }], ['read_file', { path: '.env' }], ['write_file', { path: '.git/config', content: 'x' }], ['grep', { pattern: 'SECRET' }]] }, { content: 'ok' }]);
        const events = await collect(h.run({ prompt: 'try', agent: 'openai-compatible', cwd: work, permission: 'edit', handoff: false }));
        const res = toolResults(events);
        assert.strictEqual(res.filter((c) => c.is_error).length, 4, JSON.stringify(res.map((c) => c.content)));
        assert.ok(res.some((c) => /outside the working directory/.test(c.content)));
        assert.ok(res.some((c) => /\.env files are not read/.test(c.content)));
        assert.ok(res.some((c) => /\.git is not written/.test(c.content)));
        assert.ok(!res.some((c) => /SECRET=1/.test(c.content)), 'grep skips .env files');
        assert.ok(!fs.existsSync(path.join(work, '.git')));
    });

    await check('a symlink inside the working directory cannot carry a read or write past it', async () => {
        api.set([{ calls: [
            ['read_file', { path: 'outside-link' }],
            ['read_file', { path: 'env-link' }],
            ['read_file', { path: 'dir-link/secret.txt' }],
            ['write_file', { path: 'dir-link/planted.txt', content: 'x' }],
            ['grep', { pattern: 'OUTSIDE-SECRET-KEY' }],
        ] }, { content: 'ok' }]);
        const events = await collect(h.run({ prompt: 'escape', agent: 'openai-compatible', cwd: work, permission: 'full', handoff: false }));
        const res = toolResults(events);
        assert.strictEqual(res.length, 5, JSON.stringify(res.map((c) => c.content)));
        assert.ok(res.slice(0, 4).every((c) => c.is_error), JSON.stringify(res.map((c) => c.content)));
        assert.ok(res.slice(0, 4).every((c) => /outside the working directory|\.env files are not read/.test(c.content)), JSON.stringify(res.map((c) => c.content)));
        assert.strictEqual(res[4].content, 'no matches', 'grep did not follow the linked directory');
        assert.ok(!res.some((c) => /SECRET=1|OUTSIDE-SECRET-KEY/.test(c.content)), 'nothing behind a link came back');
        assert.ok(!fs.existsSync(path.join(dir, 'outside-dir', 'planted.txt')), 'no write through the link');
    });

    await check('run_command exists only at the full level, and runs in the working directory', async () => {
        api.set([{ calls: [['run_command', { command: 'pwd' }]] }, { content: 'ok' }]);
        const events = await collect(h.run({ prompt: 'where', agent: 'openai-compatible', cwd: work, permission: 'full', handoff: false }));
        assert.ok(api.requests[0].body.tools.some((t) => t.function.name === 'run_command'));
        assert.ok(toolResults(events).some((c) => c.content.trim() === fs.realpathSync(work)));
    });

    // A command's output reaches the stream while it runs (tool_progress), before its result: a long test run is seen
    // moving (the owner, 2026-10-28: the Claude app said "Output unavailable" for a running command).
    await check('a running command\'s output streams before its result; edits carry their change', async () => {
        api.set([{ calls: [['run_command', { command: 'echo first; sleep 0.4; echo second' }], ['write_file', { path: 'note.txt', content: 'hello' }]] }, { content: 'ok' }]);
        const events = await collect(h.run({ prompt: 'run it', agent: 'openai-compatible', cwd: work, permission: 'full', handoff: false }));
        const progress = events.filter((e) => e.type === 'system' && e.subtype === 'tool_progress');
        const resultAt = events.findIndex((e) => e.type === 'user' && e.message.content.some((c) => /second/.test(c.content)));
        assert.ok(progress.length >= 1 && /first/.test(progress[0].text), JSON.stringify(progress));
        assert.ok(events.indexOf(progress[0]) < resultAt, 'the first output came before the command ended');
        assert.ok(progress.every((p) => p.tool_use_id === progress[0].tool_use_id), 'every chunk names its step');
        const write = events.find((e) => e.type === 'assistant' && e.message.content.some((c) => c.type === 'tool_use' && c.name !== 'Bash' && /note\.txt/.test(JSON.stringify(c.input))));
        const input = write.message.content.find((c) => c.type === 'tool_use').input;
        assert.deepStrictEqual([input.file_path, input.content], ['note.txt', 'hello'], 'a new file shows what it holds');
    });

    await check('an HTTP error ends the run with the server\'s message', async () => {
        api.set([{ status: 429, error: 'rate limited, slow down' }]);
        const events = await collect(h.run({ prompt: 'x', agent: 'openai-compatible', cwd: work, handoff: false }));
        const r = events.find((e) => e.type === 'result');
        assert.strictEqual(r.is_error, true);
        assert.match(r.result, /HTTP 429: rate limited/);
    });

    await check('resume continues the saved conversation', async () => {
        api.set([{ content: 'first answer' }]);
        const run1 = h.run({ prompt: 'remember the word kiwi', agent: 'openai-compatible', cwd: work, handoff: false });
        const e1 = await collect(run1);
        const session = e1.find((e) => e.type === 'result').session_id;
        api.set([{ content: 'kiwi' }]);
        await collect(h.run({ prompt: 'which word?', agent: 'openai-compatible', cwd: work, resume: session, handoff: false }));
        const msgs = api.requests[0].body.messages;
        assert.ok(msgs.some((m) => m.role === 'user' && m.content === 'remember the word kiwi'), 'the earlier turn came back');
        assert.strictEqual(msgs[msgs.length - 1].content, 'which word?');
    });

    await api.close();
    fs.rmSync(dir, { recursive: true, force: true });
    done();
})().catch((e) => { console.error(e); process.exit(1); });
