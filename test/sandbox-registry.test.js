'use strict';
/**
 * Codes' side of the chat plays sandbox workers (Agent Streams S6): /internal/sandbox-workers.
 *
 *   - a heartbeat must be signed with the worker secret: unsigned, wrongly signed, stale and replayed ones are refused,
 *     and without a configured secret nothing can check in;
 *   - a request that came through a proxy is refused (the routes are loopback only);
 *   - health says ready only for a worker that said ready, passed every check, enforces its limits and checked in
 *     recently; a worker that stopped checking in, or failed a check, is not there;
 *   - nothing but the facts is stored, and the health answer holds no secret.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const signature = require('../sandbox/signature');
const { REQUIRED } = require('../server/domain/sandbox-workers');

const SECRET = 'sandbox-worker-test-secret-0123456789abcdef';

function report(over = {}) {
    return {
        worker_id: 'sbw-test', service: 'codes-sandbox', version: '0.7.0', ready: true,
        checks: Object.fromEntries(REQUIRED.map((c) => [c, true])),
        isolation: { sandbox: 'bubblewrap', user_namespace: true, network_namespace: true, egress: { via: 'proxy', public_only: true, ports: [80, 443] }, host_credentials: 'none', host_files: 'none', seccomp: true, limits: { kind: 'cgroup', enforced: true, memory_mb: 2048, disk_mb: 512, pids: 256, cpu_percent: 100 } },
        capacity: 2, active: 0, at: new Date().toISOString(),
        ...over,
    };
}

(async () => {
    const t = await boot({ env: { CODES_SANDBOX_WORKER_SECRET: `old-secret-${'x'.repeat(20)},${SECRET}` } });
    const beat = (body, { secret = SECRET, at = Date.now(), headers = {} } = {}) => {
        const raw = JSON.stringify(body);
        return t.get('/internal/sandbox-workers/heartbeat', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', [signature.HEADER]: signature.sign(secret, raw, at), ...headers } });
    };
    const health = async () => (await t.get('/internal/sandbox-workers/health')).json();

    await check('no worker yet: health says not ready', async () => {
        const h = await health();
        assert.strictEqual(h.ready, false);
        assert.deepStrictEqual(h.workers, []);
    });

    await check('an unsigned, wrongly signed or stale heartbeat is refused', async () => {
        const raw = JSON.stringify(report());
        const unsigned = await t.get('/internal/sandbox-workers/heartbeat', { method: 'POST', body: raw, headers: { 'content-type': 'application/json' } });
        assert.strictEqual(unsigned.status, 401);
        assert.strictEqual((await beat(report(), { secret: 'not-the-secret' })).status, 401);
        assert.strictEqual((await beat(report(), { at: Date.now() - 5 * 60_000 })).status, 401, 'stale');
        // The signature covers the body: the same signature on another body is refused.
        const sig = signature.sign(SECRET, raw);
        const tampered = await t.get('/internal/sandbox-workers/heartbeat', { method: 'POST', body: raw.replace('"active":0', '"active":1'), headers: { 'content-type': 'application/json', [signature.HEADER]: sig } });
        assert.strictEqual(tampered.status, 401);
        assert.strictEqual((await health()).ready, false);
    });

    await check('through a proxy, the internal routes answer nothing', async () => {
        assert.strictEqual((await beat(report(), { headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 403);
        assert.strictEqual((await t.get('/internal/sandbox-workers/health', { headers: { 'cf-connecting-ip': '203.0.113.9' } })).status, 403);
    });

    await check('a signed heartbeat from a healthy worker makes health ready (either secret of a rotation)', async () => {
        const at = Date.now();
        const r = await beat(report(), { at });
        assert.strictEqual(r.status, 200, r.text);
        const h = await health();
        assert.strictEqual(h.ready, true);
        assert.deepStrictEqual(h.workers.map((w) => [w.id, w.healthy, w.room, w.limits]), [['sbw-test', true, 2, 'cgroup']]);
        const replay = await beat(report(), { at });
        assert.strictEqual(replay.status, 409, 'the same signed time again is a replay');
        assert.strictEqual((await beat(report(), { at: at + 1, secret: `old-secret-${'x'.repeat(20)}` })).status, 200, 'the old secret of a rotation still works');
    });

    await check('a worker that failed a check, does not enforce limits or said not ready is not healthy', async () => {
        const at = Date.now() + 10;
        for (const [n, bad] of [
            [1, report({ checks: { ...report().checks, egress_refuses_private: false } })],
            [2, report({ isolation: { ...report().isolation, limits: { kind: 'none', enforced: false } } })],
            [3, report({ ready: false })],
            [4, report({ isolation: { ...report().isolation, network_namespace: false } })],
        ]) {
            assert.strictEqual((await beat(bad, { at: at + n })).status, 200);
            const h = await health();
            assert.strictEqual(h.ready, false, `case ${n}`);
            assert.ok(h.workers[0].failing.length, `case ${n} says why`);
        }
        assert.strictEqual((await beat(report(), { at: at + 10 })).status, 200);
        assert.strictEqual((await health()).ready, true);
    });

    await check('a worker that stopped checking in is not there', async () => {
        await t.ctx.store.db.exec("UPDATE codes_sandbox_workers SET last_seen_at = now() - interval '10 minutes'");
        const h = await health();
        assert.strictEqual(h.ready, false);
        assert.deepStrictEqual(h.workers[0].failing, ['stale']);
    });

    await check('only the facts are stored, and health holds no secret', async () => {
        await beat(report({ secret: SECRET, endpoint: '/run/x.sock', isolation: { ...report().isolation, extra: 'http://10.0.0.1/' } }), { at: Date.now() + 100 });
        const dump = await t.dbDump();
        assert.ok(!dump.includes(SECRET), 'the secret is not stored');
        assert.ok(!dump.includes('/run/x.sock') && !dump.includes('10.0.0.1'), 'nothing but the facts is stored');
        const text = (await t.get('/internal/sandbox-workers/health')).text;
        assert.ok(!text.includes(SECRET) && !text.includes('old-secret'));
    });

    await t.close();

    await check('without a configured secret no worker can check in', async () => {
        const u = await boot();
        const raw = JSON.stringify(report());
        const r = await u.get('/internal/sandbox-workers/heartbeat', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', [signature.HEADER]: signature.sign(SECRET, raw) } });
        assert.strictEqual(r.status, 503);
        assert.strictEqual((await u.get('/internal/sandbox-workers/health')).json().ready, false);
        await u.close();
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
