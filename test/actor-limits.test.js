'use strict';
/**
 * Per-actor rate limits (server/http/actor-limits.js, roadmap WS-R task 4): past its limit one caller
 * gets 429 problem+json `rate_limited` with Retry-After, before the route does any work, while
 * another caller still passes; the window reopens on the clock. A person counts as themselves, an app
 * token as its app, anyone else by address. Writes have their own, tighter numbers: a refused one
 * never reaches Network. Health, ready, release.json and metrics are never limited; refusals are
 * logged (no token) and counted.
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
    const projectId = await t.project(rosa, 'Limits');
    const app = await t.app(rosa, projectId, { name: 'Counted' });
    const other = await t.app(rosa, projectId, { name: 'Other' });

    await check('a portal read: 3 a minute per person, then 429 rate_limited with Retry-After; another person passes', async () => {
        for (let i = 0; i < 3; i++) assert.strictEqual((await t.get('/projects', { as: rosa })).status, 200);
        const asked = t.network.requests.length;
        const r = await t.get('/projects', { as: rosa });
        assert.strictEqual(r.status, 429, r.text.slice(0, 300));
        assert.strictEqual(r.headers.get('retry-after'), '45');
        assert.ok(/^application\/problem\+json/.test(r.headers.get('content-type')), r.headers.get('content-type'));
        const body = r.json();
        assert.deepStrictEqual([body.code, body.status, body.retry_after_seconds], ['rate_limited', 429, 45]);
        assert.ok(body.detail.includes('codes.portal.read'), body.detail);
        assert.strictEqual(t.network.requests.length, asked, 'Network was not asked');
        assert.strictEqual((await t.get('/projects', { as: sam })).status, 200, 'another person still passes');
    });

    await check('an API read: an app token counts as its app; signed-out callers by address', async () => {
        const token = t.network.mintApp(app.id, 'openvibe.codes', ['codes.release.read']);
        const path = `/api/v1/apps/${app.id}/trust`;
        for (let i = 0; i < 3; i++) assert.strictEqual((await t.get(path, { headers: { authorization: `Bearer ${token}` } })).status, 200);
        const r = await t.get(path, { headers: { authorization: `Bearer ${token}` } });
        assert.deepStrictEqual([r.status, r.json().code], [429, 'rate_limited']);
        const theirs = t.network.mintApp(other.id, 'openvibe.codes', ['codes.release.read']);
        assert.strictEqual((await t.get(path, { headers: { authorization: `Bearer ${theirs}` } })).status, 200, 'another app still passes');
        const from = (ip) => t.get(path, { headers: { 'X-Forwarded-For': ip } });
        for (let i = 0; i < 3; i++) assert.strictEqual((await from('203.0.113.7')).status, 200);
        assert.strictEqual((await from('203.0.113.7')).status, 429);
        assert.strictEqual((await from('203.0.113.8')).status, 200, 'another address still passes');
    });

    await check('the next minute opens the window again', async () => {
        clock += 45 * 1000;
        assert.strictEqual((await t.get('/projects', { as: rosa })).status, 200);
    });

    await check('a write has its own number: 5 new projects a minute, the 6th refused before Network hears of it', async () => {
        clock = Date.UTC(2026, 8, 27, 12, 5, 0);
        for (let i = 0; i < 4; i++) await t.project(sam, `Sam ${i}`);
        await t.project(sam, 'Sam 4');
        const asked = t.network.requests.length;
        const r = await t.get('/projects', { as: sam, form: { name: 'Sam 5' } });
        assert.deepStrictEqual([r.status, r.json().code, r.headers.get('retry-after')], [429, 'rate_limited', '60']);
        assert.ok(r.json().detail.includes('codes.project.create'), r.json().detail);
        assert.strictEqual(t.network.requests.length, asked, 'Network was not asked');
        const mine = await t.get('/projects', { as: rosa, form: { name: 'Rosa 2' } });
        assert.strictEqual(mine.status, 303, 'another person still creates');
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
        assert.ok(/codes_rate_limited_total\{limit="codes.portal.read",window="minute"\} 1/.test(m), counted);
        assert.ok(/codes_rate_limited_total\{limit="codes.read",window="minute"\} 2/.test(m), counted);
        assert.ok(/codes_rate_limited_total\{limit="codes.project.create",window="minute"\} 1/.test(m), counted);
        const logs = t.logs();
        assert.ok(logs.includes(`[Limits] codes.portal.read: user:${rosa.subject} refused`), 'one log line per refusal');
        assert.ok(logs.includes(`[Limits] codes.read: app:${app.id} refused`));
        assert.ok(!/\[Limits\][^\n]*eyJ/.test(logs), 'a token in the log');
    });

    await check('who is counted', () => {
        assert.strictEqual(actor({ principal: { sub: 'app:app_1' }, viewer: { kind: 'user', subject: 'usr_a' }, ip: '203.0.113.1' }), 'app:app_1');
        assert.strictEqual(actor({ viewer: { kind: 'user', subject: 'usr_a' }, ip: '203.0.113.1' }), 'user:usr_a');
        assert.strictEqual(actor({ principal: { legacy: true }, viewer: { kind: 'anonymous' }, ip: '203.0.113.1' }), 'ip:203.0.113.1');
        assert.strictEqual(actor({ viewer: { kind: 'anonymous' }, ip: '198.51.100.4' }), 'ip:198.51.100.4');
    });

    await t.close();
    done();
})();
