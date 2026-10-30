'use strict';
/**
 * A person's connections (Codes C3, spec codes-c3-connections.md): the API keys they keep for their own providers
 * and the plans on their machines.
 *
 *   - the key never comes back: not in the answer, not in the logs, not in the database, not in a page;
 *   - the owner of a key is the signed-in person: nobody else's connections are readable;
 *   - the router never picks an agent the person cannot run;
 *   - the run token is redacted by the transcript normaliser.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const router = require('../engine/router');

(async () => {
    const KEY = 'sk-ant-0123456789abcdefXYZ';
    // The public address is an address that cannot answer (the vault is a host-local API): if Codes reached for it
    // instead of its own loopback address, every call here would fail.
    const t = await boot({ env: (network) => ({ CODES_AI_URL: 'https://ai.openvibe.services.invalid', CODES_AI_INTERNAL_URL: network.url }) });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    const bo = t.network.addUser('bo');

    try {
        await check('the connections are the signed-in person\'s own; another person\'s are refused', async () => {
            const none = await t.get('/api/v1/connections');
            assert.strictEqual(none.status, 401, 'not signed in is 401');
            const mine = await t.get('/api/v1/connections', { as: ada });
            assert.strictEqual(mine.status, 200, mine.text);
            assert.deepStrictEqual(mine.json(), { keys: [], plans: [] }, 'no keys yet, and no plans until a machine reports one');
            const other = await t.get('/api/v1/connections', { as: ada, headers: { 'X-OV-Subject': bo.subject } });
            assert.strictEqual(other.status, 403, 'another person\'s connections are refused');
            assert.strictEqual(other.json().code, 'connections.forbidden');
            const named = await t.get(`/api/v1/connections?subject=${bo.subject}`, { as: ada });
            assert.strictEqual(named.status, 403, 'and by the query too');
        });

        await check('a key is stored in OpenVibe.AI and answered with the hint only', async () => {
            const put = await t.get('/api/v1/connections/anthropic', { as: ada, method: 'PUT', json: { key: KEY, budget_usd_per_day: 5 } });
            assert.strictEqual(put.status, 200, put.text);
            const body = put.json();
            assert.strictEqual(body.connection.provider, 'anthropic');
            assert.ok(body.connection.hint && body.connection.hint.length >= 4, 'the hint is there');
            assert.ok(!JSON.stringify(body).includes(KEY), 'the key is not in the answer');
            // AI really has it, under this person and this provider.
            const stored = t.network.state.vault.get(`${ada.subject}:anthropic`);
            assert.ok(stored, 'OpenVibe.AI holds the key');
            assert.strictEqual(stored.key, KEY);
            // And Codes holds no copy of it: not in its database, not in its logs, not in a page.
            assert.ok(!(await t.dbDump()).includes(KEY), 'the key is not in Codes\' database');
            assert.ok(!t.logs().includes(KEY), 'the key is not in the logs');
            const page = await t.get('/run', { as: ada });
            assert.ok(!page.text.includes(KEY), 'the key is not on a page');
        });

        await check('the connections are read back without the key', async () => {
            const list = await t.get('/api/v1/connections', { as: ada });
            assert.strictEqual(list.status, 200);
            assert.strictEqual(list.json().keys.length, 1);
            const key = list.json().keys[0];
            assert.strictEqual(key.provider, 'anthropic');
            assert.strictEqual(key.budget_usd_per_day, 5);
            assert.strictEqual(key.spent_usd_today, 0);
            assert.ok(!JSON.stringify(list.json()).includes(KEY), 'the key is not in the list either');
        });

        await check('a test request goes through AI with the person\'s own key', async () => {
            const res = await t.get('/api/v1/connections/anthropic/test', { as: ada, method: 'POST', json: {} });
            assert.strictEqual(res.status, 200, res.text);
            assert.strictEqual(res.json().ok, true);
            const sent = t.network.state.modelRequests[t.network.state.modelRequests.length - 1];
            assert.strictEqual(sent.path, '/v1/messages', 'Anthropic\'s own format');
            assert.strictEqual(sent.credential, `anthropic:${ada.subject}`, 'the header names the provider and the person');
        });

        await check('a key can be forgotten', async () => {
            const del = await t.get('/api/v1/connections/anthropic', { as: ada, method: 'DELETE' });
            assert.strictEqual(del.status, 204, del.text);
            const list = await t.get('/api/v1/connections', { as: ada });
            assert.deepStrictEqual(list.json().keys, []);
            assert.strictEqual((await t.get('/api/v1/connections/anthropic', { as: ada, method: 'DELETE' })).status, 404, 'and it is gone for good');
        });

        await check('the router never picks an agent the person cannot run', async () => {
            // The router (engine/router.js) is the portal's: a ladder of runners per tier. The person\'s connections
            // say which of them they may run — a runner whose connection is missing is never picked.
            const ladder = {};
            for (const tier of router.TIERS) ladder[tier] = [['cc', 'claude-sonnet-5-5', 'high']];
            const base = {
                cfg: { subagents: { cc: { enabled: true, max: 2 } } },
                health: { cc: { state: 'ok' } },
                counts: {}, models: { cc: ['claude-sonnet-5-5'] }, ladder,
            };
            const prompt = 'Find the root cause of a race condition in the payment worker and fix it.';
            const none = router.pick(prompt, { ...base, connections: { cc: { provider: 'anthropic', connected: false } } });
            assert.strictEqual(none, null, 'a runner the person has no connection for is never picked');
            const picked = router.pick(prompt, { ...base, connections: { cc: { provider: 'anthropic', connected: true } } });
            assert.ok(picked, 'a runner they may run is picked');
            assert.strictEqual(picked.runner, 'cc');
            assert.ok(router.pick(prompt, base), 'without a map of connections the ladder is as it was');
        });

        await check('the run token is redacted by the transcript normaliser', async () => {
            const minted = await t.ctx.runTokens.mint({ subject: ada.subject, task: null, attempt: null, harness: 'claude-code', provider: 'anthropic', ownKey: true });
            assert.ok(minted.token, 'a run token was minted');
            assert.ok(minted.env.ANTHROPIC_AUTH_TOKEN, 'the harness gets it in its environment');
            assert.strictEqual(minted.env.ANTHROPIC_CUSTOM_HEADERS, 'x-openvibe-credential: anthropic');
            // The token is not in Codes' database (only its jti and its expiry are).
            assert.ok(!(await t.dbDump()).includes(minted.token), 'the run token is not in Codes\' database');
            // A line that carries the token is redacted before it is kept.
            const taskId = 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T1';
            await t.ctx.sessions.append(taskId, [{ seq: 1, at: new Date().toISOString(), kind: 'text', body: { text: `the token is ${minted.token}` } }]);
            const lines = await t.ctx.sessions.allRows(taskId);
            const kept = JSON.stringify(lines);
            assert.ok(!kept.includes(minted.token), 'the token is not in the transcript');
            assert.ok(kept.includes('[redacted]'), 'it says that it was redacted');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
