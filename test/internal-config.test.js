'use strict';
/**
 * D11 owner settings: the codes.ai namespace and /internal/config.
 * Env pins win; codes.config.manage is required; an owner change applies live; no KEK still works;
 * a secret-class value never leaves a summary, snapshot or history.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const CAP = ['codes.config.manage'];
const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const SECRET = 'sk_codes_d11_toppsecret_123456';

(async () => {
    const t = await boot({ env: { CODES_AI_CATALOG: '1' } });
    const admin = () => t.network.mintService('svc:network', 'openvibe.codes', CAP);
    try {
        await check('the summary: schema, the env pin, sealed:false without a KEK', async () => {
            const r = await t.get('/internal/config/codes.ai', { bearer: admin() });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.strictEqual(r.json().namespace, 'codes.ai');
            assert.strictEqual(r.json().sealed, false);
            assert.strictEqual(r.json().values.catalog, true);
            assert.deepStrictEqual(r.json().pins.catalog, { env: 'CODES_AI_CATALOG', pinned: true });
            assert.ok(!r.text.includes(SECRET));
        });

        await check('a service token without codes.config.manage is refused', async () => {
            const wrong = t.network.mintService('svc:reader', 'openvibe.codes', ['codes.task.read']);
            const r = await t.get('/internal/config/codes.ai', { bearer: wrong });
            assert.strictEqual(r.status, 403);
            assert.strictEqual(r.json().code, 'capability.denied');
        });

        await check('an env-pinned key is read-only', async () => {
            const r = await t.get('/internal/config/codes.ai', {
                method: 'POST', bearer: admin(), headers: { 'x-ov-subject': OWNER }, json: { values: { catalog: false }, reason: 'off' },
            });
            assert.strictEqual(r.status, 409, r.text.slice(0, 300));
            assert.strictEqual(r.json().code, 'config.pinned_in_env');
        });
    } finally { await t.close(); }

    const live = await boot();
    const liveAdmin = () => live.network.mintService('svc:network', 'openvibe.codes', CAP);
    try {
        await check('an owner change applies live', async () => {
            assert.strictEqual(live.config.aiCatalog.enabled, false);
            const r = await live.get('/internal/config/codes.ai', {
                method: 'POST', bearer: liveAdmin(), headers: { 'x-ov-subject': OWNER }, json: { values: { catalog: true }, reason: 'owner turned it on' },
            });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.strictEqual(r.json().revision, 2);
            assert.strictEqual(live.config.aiCatalog.enabled, true);
            assert.strictEqual(live.ctx.aiCatalog.enabled, true);
            assert.ok(live.logs().includes('by user:' + OWNER));
            assert.ok(!live.logs().includes(SECRET));
        });

        await check('with a KEK the store is sealed and boot reseals', async () => {
            const sealed = await boot({ env: { OV_CONFIG_KEKS: 'k1:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=', OV_CONFIG_KEK_CURRENT: 'k1' } });
            try {
                const token = sealed.network.mintService('svc:network', 'openvibe.codes', CAP);
                const r = await sealed.get('/internal/config/codes.ai', { bearer: token });
                assert.strictEqual(r.status, 200, r.text.slice(0, 300));
                assert.strictEqual(r.json().sealed, true);
                assert.strictEqual(r.json().kek, 'k1');
            } finally { await sealed.close(); }
        });

        await check('a secret is write-only and never appears in a summary, snapshot or history', async () => {
            const shared = require('openvibe-shared/config');
            const extra = await shared.createConfigStore({
                db: live.ctx.store.db, service: 'codes', namespace: 'codes.test_secrets',
                schema: { type: 'object', additionalProperties: false, properties: { api_key: { type: 'string' } } },
                classify: () => 'secret',
            });
            const marker = await extra.setSecret('api_key', SECRET, { actor: { type: 'user', id: OWNER }, reason: 'test' });
            assert.strictEqual(marker.redacted, true);
            assert.ok(!JSON.stringify(marker).includes(SECRET));
            const summary = await extra.summary();
            assert.strictEqual(summary.values.api_key.redacted, true);
            assert.ok(!JSON.stringify(summary).includes(SECRET));
            assert.ok(!JSON.stringify(await extra.history()).includes(SECRET));
            assert.ok(!JSON.stringify(await extra.snapshot(1)).includes(SECRET));
        });
    } finally { await live.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
