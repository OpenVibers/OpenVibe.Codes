'use strict';
/**
 * The developer console moved to OpenVibe.Services on 2026-10-08 (server/http/moved.js): every address it had here
 * answers with a permanent redirect to the same path and query there — 301 for GET and HEAD, 308 for anything else
 * (the method and body are kept) — before sign-in or any route runs. What Codes still serves is untouched, and
 * /docs/harnesses, the agent catalog's old address, goes to /harnesses on this site.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { movedTo } = require('../server/http/moved');

(async () => {
    const t = await boot();
    const user = t.network.addUser('mover');

    await check('every console page answers 301 to the same path and query on openvibe.services', async () => {
        for (const p of ['/projects', '/projects/prj_01JABCDEFGHJKMNPQRSTVWXYZ0/apps?x=1', '/docs', '/docs/api/media', '/docs/contracts/common.problem.json',
            '/oauth', '/oauth/test-callback?code=c&state=s', '/tools/webhooks', '/manifests/validate', '/releases/rel_x', '/apps/app_x', '/staff',
            '/policy/rfc', '/policy/compatibility', '/policy/licensing', '/policy/transparency']) {
            const r = await t.get(p);
            assert.strictEqual(r.status, 301, `${p}: ${r.status}`);
            assert.strictEqual(r.headers.get('location'), `https://openvibe.services${p}`, p);
        }
    });

    await check('a signed-in person is redirected too (nothing of the console runs here any more)', async () => {
        const r = await t.get('/projects', { as: user });
        assert.strictEqual(r.status, 301);
        assert.strictEqual(r.headers.get('location'), 'https://openvibe.services/projects');
    });

    await check('the console API: 301 for reads, 308 for writes (the method and body survive)', async () => {
        const read = await t.get('/api/v1/apps/app_x/releases');
        assert.strictEqual(read.status, 301);
        assert.strictEqual(read.headers.get('location'), 'https://openvibe.services/api/v1/apps/app_x/releases');
        const write = await t.get('/api/v1/apps/app_x/releases', { method: 'POST', json: { kind: 'app' } });
        assert.strictEqual(write.status, 308);
        assert.strictEqual(write.headers.get('location'), 'https://openvibe.services/api/v1/apps/app_x/releases');
        assert.strictEqual((await t.get('/api/v1/resources?project=prj_x')).headers.get('location'), 'https://openvibe.services/api/v1/resources?project=prj_x');
    });

    await check('what Codes serves stays here', async () => {
        for (const p of ['/', '/start', '/harnesses', '/improve', '/policy', '/policy/contributing', '/updates', '/api/v1/harnesses', '/robots.txt']) {
            const r = await t.get(p);
            assert.strictEqual(r.status, 200, `${p}: ${r.status}`);
        }
        assert.strictEqual((await t.get('/api/v1/harnesses/route', { json: { task: 'edit' } })).status, 200);
        assert.strictEqual(movedTo({ path: '/auth/login', originalUrl: '/auth/login' }), null, 'sign-in stays');
    });

    await check('/docs/harnesses is the catalog\'s old address: 301 to /harnesses here', async () => {
        const r = await t.get('/docs/harnesses');
        assert.strictEqual(r.status, 301);
        assert.strictEqual(r.headers.get('location'), '/harnesses');
    });

    await t.close();
    done();
})();
