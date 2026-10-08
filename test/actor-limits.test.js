'use strict';
/**
 * Per-actor rate limits (server/http/actor-limits.js, roadmap WS-R task 4): past its limit one caller
 * gets 429 problem+json `rate_limited` with Retry-After, before the route does any work, while
 * another caller still passes; the window reopens on the clock. A person counts as themselves, anyone
 * else by address. The router has its own number. Health, ready, release.json and metrics are never
 * limited; refusals are logged (no token) and counted.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { actor } = require('../server/http/actor-limits');

(async () => {
    // The limiter's clock: 15 s into a minute, so the minute window has 45 s left. Reads: 3 a minute.
    let clock = Date.UTC(2026, 8, 27, 12, 0, 15);
    const t = await boot({ actorLimits: true, limitsNow: () => clock, env: { CODES_LIMITS_MINUTE: '3', CODES_LIMITS_HOUR: '100' } });
    const rosa = t.network.addUser('rosa');
    const sam = t.network.addUser('sam');

    await check('a catalog read: 3 a minute per person, then 429 rate_limited with Retry-After; another person passes', async () => {
        for (let i = 0; i < 3; i++) assert.strictEqual((await t.get('/api/v1/harnesses', { as: rosa })).status, 200);
        const r = await t.get('/api/v1/harnesses', { as: rosa });
        assert.strictEqual(r.status, 429);
        assert.match(r.headers.get('content-type'), /application\/problem\+json/);
        assert.ok(Number(r.headers.get('retry-after')) > 0 && Number(r.headers.get('retry-after')) <= 45, r.headers.get('retry-after'));
        const body = r.json();
        assert.strictEqual(body.code, 'rate_limited');
        assert.ok(body.detail.includes('codes.read'), body.detail);
        assert.strictEqual((await t.get('/api/v1/harnesses', { as: sam })).status, 200, 'another person still passes');
    });

    await check('signed-out callers count by address', async () => {
        for (let i = 0; i < 3; i++) assert.strictEqual((await t.get('/api/v1/harnesses', { headers: { 'x-forwarded-for': '203.0.113.7' } })).status, 200);
        assert.strictEqual((await t.get('/api/v1/harnesses', { headers: { 'x-forwarded-for': '203.0.113.7' } })).status, 429);
        assert.strictEqual((await t.get('/api/v1/harnesses', { headers: { 'x-forwarded-for': '203.0.113.8' } })).status, 200, 'another address still passes');
    });

    await check('the next minute opens the window again', async () => {
        clock += 60_000;
        assert.strictEqual((await t.get('/api/v1/harnesses', { as: rosa })).status, 200);
    });

    await check('the router has its own number: 30 a minute, the 31st refused before the body is read', async () => {
        for (let i = 0; i < 30; i++) assert.strictEqual((await t.get('/api/v1/harnesses/route', { as: sam, json: { task: 'edit' } })).status, 200);
        const r = await t.get('/api/v1/harnesses/route', { as: sam, json: { task: 'edit' } });
        assert.strictEqual(r.status, 429);
        assert.ok(r.json().detail.includes('codes.harness.route'), r.json().detail);
        assert.strictEqual((await t.get('/api/v1/harnesses/route', { as: rosa, json: { task: 'edit' } })).status, 200, 'another person still routes');
    });

    await check('health, ready, release.json and metrics are never limited', async () => {
        for (let i = 0; i < 6; i++) {
            assert.strictEqual((await t.get('/api/health')).status, 200);
            assert.notStrictEqual((await t.get('/api/ready')).status, 429);
            assert.strictEqual((await t.get('/release.json')).status, 200);
            assert.strictEqual((await t.get('/metrics')).status, 200);
        }
    });

    await check('refusals are counted in codes_rate_limited_total and logged without a token', async () => {
        const m = (await t.get('/metrics')).text;
        const counted = m.split('\n').filter((l) => l.includes('codes_rate_limited_total')).join('\n');
        assert.ok(/codes_rate_limited_total\{limit="codes.read",window="minute"\} 2/.test(m), counted);
        assert.ok(/codes_rate_limited_total\{limit="codes.harness.route",window="minute"\} 1/.test(m), counted);
        const logs = t.logs();
        assert.ok(logs.includes(`[Limits] codes.read: user:${rosa.subject} refused`), 'one log line per refusal');
        assert.ok(!/\[Limits\][^\n]*eyJ/.test(logs), 'a token in the log');
    });

    await check('who is counted', () => {
        assert.strictEqual(actor({ viewer: { kind: 'user', subject: 'usr_a' }, ip: '203.0.113.1' }), 'user:usr_a');
        assert.strictEqual(actor({ viewer: { kind: 'anonymous' }, ip: '198.51.100.4' }), 'ip:198.51.100.4');
    });

    await t.close();
    done();
})();
