'use strict';
/**
 * The API agent (harness/adapters/api.js) against a stand-in OpenAI-compatible server: the model's tool calls run inside
 * the working directory and the loop ends on an answer; usage and cost come from the API's own counts; the permission
 * level decides which tools exist; a path out of the working directory, a .env file or a .git write is refused; an HTTP
 * error ends the run with the server's message; resume continues the saved conversation. On OpenVibe.AI a run that
 * asked for an advisor gets the advise tool: a bounded transcript and a question go to the run's advice route, the
 * guidance feeds the loop, and the fourth ask is refused without another call.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createHarness } = require('../harness');
const { createStore } = require('../harness/sessions');
const { adviceTranscript } = require('../harness/adapters/api');
const { check, done } = require('./helpers/boot');

/** A chat-completions server that answers from a script: each request gets the next scripted message. Advice calls
 *  (POST /api/v1/runs/:id/advice) are recorded apart and answered from their own script. */
async function mockApi() {
    const requests = [];
    const advice = [];
    let script = [];
    let adviceScript = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            const parsed = JSON.parse(body || '{}');
            if (req.method === 'POST' && /\/api\/v1\/runs\/.+\/advice$/.test(req.url || '')) {
                advice.push({ url: req.url, auth: req.headers.authorization || null, body: parsed });
                const step = adviceScript.length ? adviceScript.shift() : { advice: 'keep going' };
                if (step.status) { res.writeHead(step.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: step.error, ...(step.code ? { code: step.code } : {}) } })); return; }
                res.writeHead(201, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ run_id: 'run_9', use: advice.length, max_uses: 3, advice: step.advice }));
                return;
            }
            requests.push({ auth: req.headers.authorization || null, body: parsed });
            const step = script.shift();
            if (!step) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); return; }
            if (step.status) { res.writeHead(step.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: step.error, ...(step.code ? { code: step.code } : {}) } })); return; }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: step.content || '', ...(step.calls ? { tool_calls: step.calls.map((c, i) => ({ id: `call_${requests.length}_${i}`, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1]) } })) } : {}) } }], usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 400 }, ...(step.x ? { x_openvibe: step.x } : {}) }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, requests, advice, set: (s) => { script = s; requests.length = 0; }, adviceSet: (s) => { adviceScript = s; advice.length = 0; }, close: () => new Promise((r) => server.close(r)) };
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
    // The same stand-in as OpenVibe.AI: the advice route hangs off the chat base without its /v1.
    const aiEnv = { ...env, OPENVIBE_AI_URL: api.url, OPENVIBE_AI_TOKEN: 'ov-task-token' };
    const ai = createHarness({ env: aiEnv, store: createStore({ env: aiEnv }) });
    const toolNames = (req) => req.body.tools.map((t) => t.function.name);

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

    await check('OpenVibe.AI: an exact id is sent unchanged, its disclosure is recorded, and a refusal is that error', async () => {
        const exactEnv = { ...env, OPENVIBE_AI_URL: api.url, OPENVIBE_AI_TOKEN: 'ov-task-token' };
        const exact = createHarness({ env: exactEnv, store: createStore({ env: exactEnv }) });
        api.set([{
            content: 'It ran.',
            x: { run_id: 'run_9', cost_usd: 0.0012, resolved_model: 'acme/m1:q4_k_m@rev1', revision: 'rev1', provider_access: 'OWN_DEPLOYMENT', rate_version: 'rr-1', policy: 'exact', fallback_reason: null },
        }]);
        const events = await collect(exact.run({ prompt: 'run exactly', agent: 'openvibe-ai', model: 'acme/m1:q4_k_m@rev1', cwd: work, permission: 'read', handoff: false }));
        const r = events.find((e) => e.type === 'result');
        assert.strictEqual(r.is_error, false, r.result);
        assert.strictEqual(api.requests[0].body.model, 'acme/m1:q4_k_m@rev1', 'the exact id is sent unchanged');
        assert.strictEqual(r.model, 'acme/m1:q4_k_m@rev1', 'the resolved model is what the run records');
        assert.strictEqual(r.resolved_model, 'acme/m1:q4_k_m@rev1');
        assert.strictEqual(r.disclosure.provider_access, 'OWN_DEPLOYMENT');
        assert.strictEqual(r.total_cost_usd, 0.0012);
        assert.strictEqual(events.find((e) => e.type === 'system' && e.subtype === 'init').model, 'acme/m1:q4_k_m@rev1', 'the session starts on the model that answered');

        // An alias is sent as the alias; the disclosure says which exact model it resolved to, and that is recorded.
        api.set([{ content: 'Alias ran.', x: { run_id: 'run_10', cost_usd: 0.001, resolved_model: 'acme/m3@rev3', policy: 'auto' } }]);
        const aliased = await collect(exact.run({ prompt: 'run the alias', agent: 'openvibe-ai', model: 'openvibe/auto', cwd: work, permission: 'read', handoff: false }));
        assert.strictEqual(api.requests[0].body.model, 'openvibe/auto', 'the alias is sent unchanged');
        assert.strictEqual(aliased.find((e) => e.type === 'result').model, 'acme/m3@rev3', 'the resolved exact id is recorded');

        api.set([{ status: 404, code: 'ai.model_not_found', error: 'no artifact acme/nope@rev0' }]);
        const missing = await collect(exact.run({ prompt: 'run a missing model', agent: 'openvibe-ai', model: 'acme/nope@rev0', cwd: work, permission: 'read', handoff: false }));
        const missingResult = missing.find((e) => e.type === 'result');
        assert.strictEqual(api.requests.length, 1, 'one request: never retried with another model');
        assert.match(missingResult.result, /ai\.model_not_found/);
        assert.match(missingResult.result, /acme\/nope@rev0/);

        api.set([{ status: 400, code: 'ai.model_unavailable', error: 'the artifact has no active deployment' }]);
        const unavailable = await collect(exact.run({ prompt: 'run an unavailable model', agent: 'openvibe-ai', model: 'acme/m2@rev2', cwd: work, permission: 'read', handoff: false }));
        assert.match(unavailable.find((e) => e.type === 'result').result, /ai\.model_unavailable/);
        assert.strictEqual(api.requests.length, 1, 'the unavailable model was not swapped for another');
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

    await check('OpenVibe.AI: the run\'s effort and advisor are forwarded on every turn', async () => {
        const forwardEnv = { ...env, OPENVIBE_AI_URL: api.url, OPENVIBE_AI_TOKEN: 'ov-task-token' };
        const forward = createHarness({ env: forwardEnv, store: createStore({ env: forwardEnv }) });
        api.set([{ content: 'done' }]);
        const events = await collect(forward.run({ prompt: 'x', agent: 'openvibe-ai', cwd: work, permission: 'read', handoff: false, effort: 'low', advisor: { model: 'deepseek/deepseek-v4-pro' } }));
        assert.strictEqual(events.find((e) => e.type === 'result').is_error, false);
        assert.strictEqual(api.requests[0].body.effort, 'low');
        assert.deepStrictEqual(api.requests[0].body.advisor, { model: 'deepseek/deepseek-v4-pro' });
        assert.strictEqual(api.requests[0].body.model, 'openvibe');
        api.set([{ content: 'done' }]);
        await collect(forward.run({ prompt: 'x', agent: 'openvibe-ai', cwd: work, permission: 'read', handoff: false, advisor: true }));
        assert.strictEqual(api.requests[0].body.advisor, true);
        assert.ok(!('effort' in api.requests[0].body), 'no effort names no level');
    });

    await check('an HTTP error ends the run with the server\'s message', async () => {
        api.set([{ status: 429, error: 'rate limited, slow down' }]);
        const events = await collect(h.run({ prompt: 'x', agent: 'openai-compatible', cwd: work, handoff: false }));
        const r = events.find((e) => e.type === 'result');
        assert.strictEqual(r.is_error, true);
        assert.match(r.result, /HTTP 429: rate limited/);
    });

    await check('advise is offered only on OpenVibe.AI when the run asked for an advisor', async () => {
        api.set([{ content: 'done' }]);
        await collect(ai.run({ prompt: 'x', agent: 'openvibe-ai', cwd: work, permission: 'read', handoff: false, advisor: true }));
        assert.ok(toolNames(api.requests[0]).includes('advise'), 'asked on OpenVibe.AI');
        api.set([{ content: 'done' }]);
        await collect(ai.run({ prompt: 'x', agent: 'openvibe-ai', cwd: work, permission: 'read', handoff: false }));
        assert.ok(!toolNames(api.requests[0]).includes('advise'), 'off unless asked');
        api.set([{ content: 'done' }]);
        await collect(h.run({ prompt: 'x', agent: 'openai-compatible', cwd: work, permission: 'read', handoff: false, advisor: true }));
        assert.ok(!toolNames(api.requests[0]).includes('advise'), 'another API path has no advice endpoint');
    });

    await check('advise sends the bounded transcript and the question; the guidance feeds the loop', async () => {
        api.set([
            { calls: [['read_file', { path: 'src/a.js' }], ['advise', { question: 'is the parser done?' }]], x: { run_id: 'run_9' } },
            { content: 'done' },
        ]);
        api.adviceSet([{ advice: 'check the parser first' }]);
        const events = await collect(ai.run({ prompt: 'fix the parser', agent: 'openvibe-ai', cwd: work, permission: 'read', handoff: false, advisor: true }));
        assert.strictEqual(api.advice.length, 1);
        const call = api.advice[0];
        assert.ok(call.url.endsWith('/api/v1/runs/run_9/advice'), call.url);
        assert.strictEqual(call.auth, 'Bearer ov-task-token', 'the advice call carries the run token');
        assert.strictEqual(call.body.question, 'is the parser done?');
        assert.ok(!('model' in call.body), 'no model named, none sent');
        const t = call.body.transcript;
        assert.ok(Array.isArray(t) && t.length >= 3, 'system, task and the turn so far');
        assert.ok(t.every((m) => ['system', 'user', 'assistant', 'tool'].includes(m.role) && typeof m.content === 'string' && m.content.trim()), 'text only, roles AI accepts');
        assert.ok(t.reduce((n, m) => n + m.content.length, 0) <= 80_000, 'bounded');
        assert.strictEqual(t[0].role, 'system');
        assert.ok(t.some((m) => m.role === 'user' && m.content === 'fix the parser'), 'the task rides along');
        assert.ok(t.some((m) => m.role === 'assistant' && /called: Read/.test(m.content)), 'the tool call reads as a line');
        const res = toolResults(events);
        assert.ok(res.some((c) => !c.is_error && /check the parser first/.test(c.content) && /\(advice 1 of 3\)/.test(c.content)), JSON.stringify(res.map((c) => c.content)));
        const fed = api.requests[1].body.messages.find((m) => m.role === 'tool' && /check the parser first/.test(m.content));
        assert.ok(fed, 'the guidance feeds the next turn');
    });

    await check('the fourth ask is refused in the loop, without another HTTP call', async () => {
        api.set([{ calls: [['advise', { question: 'one' }], ['advise', { question: 'two' }], ['advise', { question: 'three' }], ['advise', { question: 'four' }]], x: { run_id: 'run_9' } }, { content: 'done' }]);
        api.adviceSet([{ advice: 'a' }, { advice: 'b' }, { advice: 'c' }]);
        const events = await collect(ai.run({ prompt: 'x', agent: 'openvibe-ai', cwd: work, permission: 'read', handoff: false, advisor: true }));
        assert.strictEqual(api.advice.length, 3);
        const res = toolResults(events);
        assert.ok(res.slice(0, 3).every((c) => !c.is_error));
        assert.ok(res[3].is_error && /asked 3 times/.test(res[3].content), res[3].content);
    });

    await check('an exhausted advisor and a missing run id end in words, not a crash', async () => {
        api.set([{ calls: [['advise', { question: 'any?' }]], x: { run_id: 'run_9' } }, { content: 'done' }]);
        api.adviceSet([{ status: 409, error: 'used up', code: 'advisor.exhausted' }]);
        const spent = await collect(ai.run({ prompt: 'x', agent: 'openvibe-ai', cwd: work, permission: 'read', handoff: false, advisor: true }));
        assert.ok(toolResults(spent).some((c) => c.is_error && /no calls left/.test(c.content)));
        api.set([{ calls: [['advise', { question: 'any?' }]] }, { content: 'done' }]);
        api.adviceSet([]);
        const norun = await collect(ai.run({ prompt: 'x', agent: 'openvibe-ai', cwd: work, permission: 'read', handoff: false, advisor: true }));
        assert.ok(toolResults(norun).some((c) => c.is_error && /ask again after the next answer/.test(c.content)));
        assert.strictEqual(api.advice.length, 0, 'no run id, no call');
    });

    await check('the advice transcript: text only, bounded, the task always first', () => {
        const messages = [{ role: 'system', content: 'be careful' }, { role: 'user', content: 'the task' }];
        for (let i = 0; i < 100; i++) {
            messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, function: { name: 'read_file', arguments: JSON.stringify({ path: `f${i}.js`, pad: 'y'.repeat(5000) }) } }] });
            messages.push({ role: 'tool', tool_call_id: `c${i}`, content: `file ${i}\n${'z'.repeat(5000)}` });
        }
        messages.push({ role: 'assistant', content: '   ' }, { role: 'user', content: '' }, { role: 'bogus', content: 'x' });
        const t = adviceTranscript(messages);
        assert.ok(t.length <= 50, `${t.length} messages`);
        assert.ok(t.reduce((n, m) => n + m.content.length, 0) <= 80_000, 'bounded');
        assert.ok(t.every((m) => ['system', 'user', 'assistant', 'tool'].includes(m.role) && m.content.trim()), 'text only');
        assert.strictEqual(t[0].content, 'be careful');
        assert.strictEqual(t[1].content, 'the task', 'the task rides first even past the budget');
        assert.ok(t.some((m) => /called: Read/.test(m.content)), 'tool calls read as lines');
        assert.deepStrictEqual(adviceTranscript([]), [{ role: 'user', content: 'the executor asked for advice but has no transcript yet' }]);
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
