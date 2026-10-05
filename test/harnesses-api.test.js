'use strict';

/**
 * The harness read API (/api/v1/harnesses): the catalog with its agents, routing a task over the
 * catalog's offers, 422 problems for a bad body or an unknown task, and the per-actor limits on both.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

const rows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'data', 'harness-offers.json'), 'utf8'));

(async () => {
    const t = await boot();
    const post = (json, headers) => t.get('/api/v1/harnesses/route', { method: 'POST', json, headers });

    await check('GET /harnesses returns every seed harness with its agents', async () => {
        const r = await t.get('/api/v1/harnesses');
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        const { harnesses } = r.json();
        assert.deepStrictEqual(harnesses.map((h) => h.id), rows.map((row) => row.id));
        assert.ok(harnesses.some((h) => h.id === 'opencode'), "GET /harnesses includes the 'opencode' harness");
        for (const row of rows) {
            const h = harnesses.find((x) => x.id === row.id);
            // Every seed row ships at least one agent (command-code, aider and opencode each carry one subscription pool).
            assert.deepStrictEqual(h, { ...row, agents: row.agents });
            assert.ok(h.agents.length > 0, `${row.id} has an agent`);
        }
    });

    await check('POST /harnesses/route {task:review} returns a selected offer and candidates', async () => {
        const r = await post({ task: 'review' });
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        const body = r.json();
        assert.strictEqual(typeof body.selected, 'string');
        assert.ok(Array.isArray(body.reasons));
        const agents = rows.reduce((n, row) => n + row.agents.length, 0);
        assert.strictEqual(body.candidates.length, agents);
        assert.ok(body.candidates.some((c) => c.id === body.selected && c.included === true));
    });

    await check('a bad body is 422 harness.invalid', async () => {
        for (const json of [{}, { task: '' }, { task: 7 }, { task: 'review', requirements: 'x' }, { task: 'review', requirements: [] }, { task: 'review', requirements: { capabilities: 5 } }]) {
            const r = await post(json);
            assert.deepStrictEqual([r.status, r.json().code], [422, 'harness.invalid'], JSON.stringify(json));
            assert.ok(/^application\/problem\+json/.test(r.headers.get('content-type')));
        }
    });

    await check('an unknown task is 422 harness.task_unknown', async () => {
        const r = await post({ task: 'nope' });
        assert.deepStrictEqual([r.status, r.json().code], [422, 'harness.task_unknown']);
    });
    await t.close();

    // The per-actor limits (http/actor-limits.js), as test/actor-limits.test.js asserts them.
    const clock = Date.UTC(2026, 8, 27, 12, 0, 15);
    const l = await boot({ actorLimits: true, limitsNow: () => clock, env: { CODES_LIMITS_MINUTE: '3', CODES_LIMITS_HOUR: '100' } });
    const from = (ip, o = {}) => ({ ...o, headers: { 'X-Forwarded-For': ip } });

    await check('GET /harnesses takes the read limit: 3 a minute per caller, then 429 rate_limited', async () => {
        for (let i = 0; i < 3; i++) assert.strictEqual((await l.get('/api/v1/harnesses', from('203.0.113.7'))).status, 200);
        const r = await l.get('/api/v1/harnesses', from('203.0.113.7'));
        assert.deepStrictEqual([r.status, r.json().code], [429, 'rate_limited']);
        assert.strictEqual((await l.get('/api/v1/harnesses', from('203.0.113.8'))).status, 200, 'another address still passes');
    });

    await check('POST /harnesses/route has its own budget: 30 a minute per caller, then 429 rate_limited', async () => {
        const route = (ip) => l.get('/api/v1/harnesses/route', from(ip, { method: 'POST', json: { task: 'review' } }));
        for (let i = 0; i < 30; i++) assert.strictEqual((await route('203.0.113.9')).status, 200);
        const r = await route('203.0.113.9');
        assert.deepStrictEqual([r.status, r.json().code], [429, 'rate_limited']);
        assert.ok(r.json().detail.includes('codes.harness.route'), r.json().detail);
        assert.strictEqual((await route('203.0.113.10')).status, 200, 'another address still passes');
    });
    await l.close();
    done();
})();
