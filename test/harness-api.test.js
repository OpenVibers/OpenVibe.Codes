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
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: step.content || '', ...(step.calls ? { tool_calls: step.calls.map((c, i) => ({ id: `call_${requests.length}_${i}`, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1]) } })) } : {}) } }], usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 400 } }));
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
