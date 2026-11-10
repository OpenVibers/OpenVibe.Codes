'use strict';
/**
 * The deepseek harness's default path: its turns go to OpenVibe.Exchange's compatible API through the SDK's Exchange
 * client (openvibe-sdk/exchange), with the same model id and tool loop; no request reaches api.deepseek.com. The direct
 * DeepSeek API is used only for an operator's own key on a self-hosted run (OPENVIBE_CODES_DEEPSEEK_DIRECT=1), and the
 * Exchange's answer's receipt id and reported cost are carried on the run's result.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHarness, exchangeKeyOf, exchangeModelOf, platformHost } = require('../harness');
const { createStore } = require('../harness/sessions');
const { check, done } = require('./helpers/boot');

/** A stand-in Exchange: records every request; fails the test if the direct DeepSeek host is called on the default path. */
function mockExchange({ script = [] } = {}) {
    const requests = [];
    const fetchImpl = async (url, init = {}) => {
        const href = String(url);
        if (/api\.deepseek\.com/i.test(href)) throw new Error(`the direct DeepSeek API was called on the default path: ${href}`);
        let body = null;
        try { body = init.body ? JSON.parse(init.body) : null; } catch { body = null; }
        const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
        requests.push({ url: href, headers, body: body && JSON.parse(JSON.stringify(body)) });
        const step = script.length ? script.shift() : null;
        if (step && step.status) {
            return new Response(JSON.stringify(step.body || { error: { message: 'refused' } }), { status: step.status, headers: { 'content-type': 'application/json' } });
        }
        const message = step && step.calls
            ? { role: 'assistant', content: '', tool_calls: step.calls.map((c, i) => ({ id: `call_${requests.length}_${i}`, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1]) } })) }
            : { role: 'assistant', content: (step && step.content) || 'all done' };
        return new Response(JSON.stringify({
            id: 'chatcmpl-run_test', object: 'chat.completion',
            choices: [{ index: 0, message, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 400 },
            x_openvibe: { run_id: 'run_test', model: 'deepseek-chat', cost_usd: 0.00042, receipt_id: 'rcpt_test' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { requests, fetchImpl };
}

const collect = async (run) => { const out = []; for await (const e of run) out.push(e); return out; };

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-exchange-'));
    const work = path.join(dir, 'work');
    fs.mkdirSync(path.join(work, 'src'), { recursive: true });
    fs.writeFileSync(path.join(work, 'src', 'a.js'), 'const name = 1;\n');
    const baseEnv = { PATH: '/nonexistent', OPENVIBE_CODES_HOME: path.join(dir, 'home') };
    const EXCHANGE_KEY = `ovx_${'a'.repeat(43)}`;

    await check('the default path sends the turn to OpenVibe.Exchange through the SDK client, never to api.deepseek.com', async () => {
        const api = mockExchange({ script: [
            { calls: [['read_file', { path: 'src/a.js' }]] },
            { content: 'It exports name.' },
        ] });
        const env = { ...baseEnv, OPENVIBE_EXCHANGE_KEY: EXCHANGE_KEY };
        const h = createHarness({ env, fetch: api.fetchImpl, store: createStore({ env }) });
        assert.strictEqual(h.agents().find((a) => a.id === 'deepseek').available, true);
        const events = await collect(h.run({ prompt: 'what does a.js export?', agent: 'deepseek', cwd: work, permission: 'read', handoff: false }));
        const r = events.find((e) => e.type === 'result');
        assert.strictEqual(r.is_error, false, r.result);
        assert.strictEqual(r.result, 'It exports name.');
        assert.strictEqual(api.requests.length, 2, 'the tool loop ran both turns');
        assert.strictEqual(api.requests[0].url, 'https://api.openvibe.exchange/v1/chat/completions');
        assert.strictEqual(api.requests[0].headers.authorization, `Bearer ${EXCHANGE_KEY}`);
        assert.strictEqual(api.requests[0].body.model, 'deepseek-chat', 'the same model id the agent asked for');
        assert.ok(api.requests[0].body.tools.some((t) => t.function.name === 'read_file'), 'the same tools');
        assert.ok(api.requests[1].body.messages.some((m) => m.role === 'tool' && m.content.includes('const name = 1;')), 'the tool result went back to the model');
        assert.strictEqual(r.receipt_id, 'rcpt_test', 'the Exchange receipt is on the result');
        assert.strictEqual(r.total_cost_usd, 0.00084, 'the reported costs are summed');
        assert.deepStrictEqual([r.usage.input_tokens, r.usage.cache_read_input_tokens, r.usage.output_tokens], [1200, 800, 200]);
    });

    await check('the agent\'s model id goes as it is; OPENVIBE_EXCHANGE_MODEL can name an Exchange catalog id', () => {
        assert.strictEqual(exchangeModelOf('deepseek-chat'), 'deepseek-chat');
        assert.strictEqual(exchangeModelOf('deepseek-reasoner'), 'deepseek-reasoner');
        assert.strictEqual(exchangeModelOf('deepseek-chat', { OPENVIBE_EXCHANGE_MODEL: 'deepseek/deepseek-v4-pro' }), 'deepseek/deepseek-v4-pro');
    });

    await check('a service Exchange key is the fallback, and the Exchange URL can be pointed elsewhere', async () => {
        const api = mockExchange({ script: [{ content: 'ok' }] });
        const env = { ...baseEnv, OPENVIBE_EXCHANGE_SERVICE_KEY: `ovx_${'b'.repeat(43)}`, OPENVIBE_EXCHANGE_URL: 'https://exchange.test' };
        const h = createHarness({ env, fetch: api.fetchImpl, store: createStore({ env }) });
        const events = await collect(h.run({ prompt: 'say ok', agent: 'deepseek', cwd: work, permission: 'read', handoff: false }));
        assert.strictEqual(events.find((e) => e.type === 'result').is_error, false);
        assert.strictEqual(api.requests[0].url, 'https://exchange.test/v1/chat/completions');
        assert.strictEqual(api.requests[0].headers.authorization, `Bearer ovx_${'b'.repeat(43)}`);
    });

    await check('the direct DeepSeek API is used only with OPENVIBE_CODES_DEEPSEEK_DIRECT=1 and an operator key', async () => {
        const requests = [];
        const fetchImpl = async (url, init = {}) => {
            requests.push({ url: String(url), headers: { ...(init.headers || {}) } });
            return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'direct' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        const env = { ...baseEnv, OPENVIBE_CODES_DEEPSEEK_DIRECT: '1', DEEPSEEK_API_KEY: 'sk-own-key', DEEPSEEK_BASE_URL: 'https://api.deepseek.com', OPENVIBE_EXCHANGE_KEY: EXCHANGE_KEY };
        const h = createHarness({ env, fetch: fetchImpl, store: createStore({ env }) });
        const events = await collect(h.run({ prompt: 'say direct', agent: 'deepseek', cwd: work, permission: 'read', handoff: false }));
        assert.strictEqual(events.find((e) => e.type === 'result').is_error, false);
        assert.strictEqual(requests.length, 1);
        assert.strictEqual(requests[0].url, 'https://api.deepseek.com/chat/completions');
        assert.strictEqual(requests[0].headers.authorization, 'Bearer sk-own-key');
    });

    await check('a hosted deepseek attempt gets the Exchange pair with the run token, and keeps the old pair for older harnesses', () => {
        const { envFor } = require('../server/domain/run-tokens');
        const config = { ai: { url: 'https://ai.openvibe.services' }, exchange: { url: 'https://api.openvibe.exchange' } };
        const env = envFor({ config, harness: 'deepseek', token: 'run-token', provider: 'deepseek', ownKey: false });
        assert.strictEqual(env.OPENVIBE_EXCHANGE_URL, 'https://api.openvibe.exchange');
        assert.strictEqual(env.OPENVIBE_EXCHANGE_KEY, 'run-token');
        assert.strictEqual(env.DEEPSEEK_BASE_URL, 'https://ai.openvibe.services/v1', 'an older harness still reads these');
        assert.strictEqual(env.DEEPSEEK_API_KEY, 'run-token');
        // The person's own DeepSeek key names itself in OPENVIBE_CODES_HEADERS, which the SDK client cannot send:
        // that attempt keeps the AI path, so the header is never dropped.
        const own = envFor({ config, harness: 'deepseek', token: 'run-token', provider: 'deepseek', ownKey: true });
        assert.strictEqual(own.OPENVIBE_EXCHANGE_KEY, undefined);
        assert.strictEqual(own.OPENVIBE_EXCHANGE_URL, undefined);
        assert.strictEqual(own.DEEPSEEK_API_KEY, 'run-token');
    });

    await check('without an Exchange key or an own DeepSeek key the agent is unavailable, and the reason names both', () => {
        const h = createHarness({ env: baseEnv, store: createStore({ env: baseEnv }) });
        const ds = h.agents().find((a) => a.id === 'deepseek');
        assert.strictEqual(ds.available, false);
        assert.match(ds.reason, /OPENVIBE_EXCHANGE_KEY/);
        assert.match(ds.reason, /DEEPSEEK_API_KEY/);
        assert.strictEqual(exchangeKeyOf(baseEnv), null);
        assert.strictEqual(platformHost('https://ai.openvibe.services/v1'), true);
        assert.strictEqual(platformHost('https://api.deepseek.com'), false);
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
