'use strict';
/**
 * Codes' own secrets never leave in a response, an event or a log line (roadmap WS-R task 5, the
 * internal-secret class). secrets.test.js pins the secrets Network hands out (client secrets, typed
 * tokens); this suite covers Codes' environment: its Network OAuth client secret and its form secret
 * are sentinels, and every route the booted app has (listed from Express's router stack) is
 * requested as anonymous, a developer and staff with real and nonsense ids, plus the sign-in callback
 * with a forged code (it posts the client secret to Network), unknown paths and every write route
 * with a broken body. No body or header may carry either (a form token derived from the form secret
 * is fine; the secret is not), nor may the outbox or the captured log lines.
 *
 *   node test/security-secrets.test.js
 */
const assert = require('assert');
const appModule = require('../server/app');
let capturedApp = null;
const realCreate = appModule.createApp;
appModule.createApp = (...a) => { const built = realCreate(...a); capturedApp = built.app; return built; };
const { boot, check, done } = require('./helpers/boot');
const { getPaths, crawl, listRoutes, expand, leaks, nextAddress } = require('./security-crawl');

const SECRETS = { OV_OAUTH_CLIENT_SECRET: 'sentinel-not-a-secret-codes-oauth-client', CODES_FORM_SECRET: 'sentinel-not-a-secret-codes-form' };

(async () => {
    const t = await boot({ env: SECRETS });
    const dev = t.network.addUser('dev');
    const staff = t.network.addUser('root', { role: 'admin' });
    const project = await t.project(dev, 'Secret Test');
    const app = await t.app(dev, project, { name: 'Secret App' });

    await check('every GET route, as three people, with real and nonsense ids: no sentinel', async () => {
        const nonsense = ['nope', "'\"<x>", 'x'.repeat(300)];
        const values = (name) => (name === 'project' ? [project, ...nonsense] : name === 'app' ? [app.id, ...nonsense] : [app.id, project, ...nonsense]);
        const paths = getPaths(capturedApp, values, {
            query: 'q=x&code=forged&state=forged&next=%2F',
            extra: ['/api/health', '/api/ready', '/metrics', '/release.json', '/auth/callback?code=forged&state=forged', '/callback?code=forged&state=forged', '/api/nope', '/nope', '/.env', '/api/%'],
        });
        const r = await crawl(t, paths, { anonymous: null, dev, staff }, () => SECRETS);
        assert.ok(r.answered >= paths.length * 2, `${r.answered} answers`);
        assert.deepStrictEqual(r.found, []);
    });

    await check('every write route with a broken body, anonymous and as the developer: no sentinel', async () => {
        const found = [];
        const values = (name) => (name === 'project' ? [project] : name === 'app' ? [app.id] : ['x']);
        for (const route of listRoutes(capturedApp)) {
            for (const method of route.methods.filter((m) => ['post', 'put', 'patch', 'delete'].includes(m))) {
                for (const p of expand(route.path, values)) {
                    for (const as of [null, dev]) {
                        const r = await t.get(p, { method: method.toUpperCase(), ...(as ? { as } : {}), body: '{"broken": ', headers: { 'content-type': 'application/json', 'x-forwarded-for': nextAddress() } });
                        for (const l of leaks(r, SECRETS)) found.push(`${method} ${p} → ${r.status} carries ${l.label}`);
                    }
                }
            }
        }
        assert.deepStrictEqual(found, []);
    });

    await check('the outbox and the captured log lines carry no sentinel', () => {
        const text = t.dbDump() + t.logs();
        for (const [k, v] of Object.entries(SECRETS)) assert.ok(!text.includes(v), `${k} in the database or the logs`);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
