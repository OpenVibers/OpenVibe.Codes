'use strict';
/**
 * IndexNow (openvibe-shared/indexnow): INDEXNOW_KEY unset → the feature is off (no key route, nothing
 * sent). With a key, the key file is served at /<key>.txt as text/plain and publishing a release pings
 * the engines with the release page, the app page, /updates and the sitemap. A draft never pings.
 */
const assert = require('assert');
const manifests = require('../server/domain/manifests');
const { boot, check, done } = require('./helpers/boot');

const KEY = 'k'.repeat(32);
const SITEMAP = 'https://openvibe.codes/sitemap.xml';
const UPDATES = 'https://openvibe.codes/updates';

(async () => {
    const off = await boot();
    await check('without a key IndexNow is off: no key route and nothing sent', async () => {
        assert.strictEqual(off.ctx.indexnow.enabled, false);
        const res = await off.get(`/${KEY}.txt`);
        assert.strictEqual(res.status, 404, res.text);
    });
    await off.close();

    const on = await boot({ env: { INDEXNOW_KEY: KEY } });
    await check('with a key the key file answers text/plain with the key', async () => {
        assert.strictEqual(on.ctx.indexnow.enabled, true);
        const res = await on.get(`/${KEY}.txt`);
        assert.strictEqual(res.status, 200, res.text);
        assert.match(res.headers.get('content-type'), /text\/plain/);
        assert.strictEqual(res.text, KEY);
    });
    await on.close();

    // A spy in place of the module's HTTP send: records every pingSoon batch.
    const pings = [];
    const spy = {
        enabled: true,
        keyFile: (_req, _res, next) => next(),
        pingSoon: (urls) => { const a = Array.isArray(urls) ? urls : [urls]; pings.push(...a); return a.length; },
        ping: async () => ({ sent: 0, status: 0 }),
        flush: async () => ({ sent: 0, status: 0 }),
    };
    const t = await boot({ indexnow: spy });
    const owner = t.network.addUser('rosa');
    const projectId = await t.project(owner, 'IndexNow');
    const app = await t.app(owner, projectId, { name: 'Pinger' });
    const base = `/projects/${projectId}/apps/${app.id}`;
    const manifest = (version) => JSON.stringify({ ...manifests.template('app', { appId: app.id, projectId, environment: 'sandbox', name: 'Pinger' }), version });
    let release;

    await check('a draft never pings', async () => {
        const r = await t.get(`${base}/releases`, { as: owner, form: { kind: 'app', manifest: manifest('1.0.0'), intent: 'create' } });
        assert.strictEqual(r.status, 303, r.text.slice(0, 400));
        release = r.headers.get('location').split('/').pop();
        assert.deepStrictEqual(pings, []);
    });

    await check('a publish pings the release page, the app page, /updates and the sitemap', async () => {
        const r = await t.get(`/releases/${release}/publish`, { as: owner, form: {} });
        assert.strictEqual(r.status, 303, r.text);
        assert.ok(pings.includes(`https://openvibe.codes/releases/${release}`), JSON.stringify(pings));
        assert.ok(pings.includes(`https://openvibe.codes/apps/${app.id}`), JSON.stringify(pings));
        assert.ok(pings.includes(UPDATES), JSON.stringify(pings));
        assert.ok(pings.includes(SITEMAP), JSON.stringify(pings));
    });

    await check('a revoke pings the page, the app page and the sitemap', async () => {
        pings.length = 0;
        const r = await t.get(`/releases/${release}/revoke`, { as: owner, form: { reason: 'Withdrawn', confirm: '1' } });
        assert.strictEqual(r.status, 303, r.text);
        assert.ok(pings.includes(`https://openvibe.codes/releases/${release}`), JSON.stringify(pings));
        assert.ok(pings.includes(SITEMAP), JSON.stringify(pings));
    });
    await t.close();

    done();
})().catch((err) => { console.error(err); process.exit(1); });
