'use strict';
/**
 * The portal never persists or re-displays a secret.
 *
 * Every client secret Network hands out (app creation, rotation), every secret or token typed into a
 * playground, and every webhook secret typed into the tester is searched for in: every table of
 * Codes' database, every log line (app logger and console), and every later page and API response.
 * The only response allowed to contain a client secret is the one to the create/rotate that made it,
 * and that response is Cache-Control: no-store.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const owner = t.network.addUser('ada');
    const secrets = [];
    const seen = [];                       // every response body after the one-time display
    const record = (r) => { seen.push(r.text); return r; };

    const projectId = await t.project(owner, 'Secrets');
    let appId;

    await check('creating a confidential app shows the secret once, with no-store, and a clear warning', async () => {
        const made = await t.app(owner, projectId, { name: 'Server app' });
        assert.ok(made.secret, 'secret on the creation page');
        assert.ok(made.id);
        appId = made.id;
        secrets.push(made.secret);
        assert.strictEqual(made.page.headers.get('cache-control'), 'no-store');
        assert.match(made.page.text, /You won't see this secret again/);
        assert.match(made.page.text, /Codes does not keep it/);
        assert.ok(!made.page.headers.get('location'), 'no redirect through a URL');
    });

    await check('the app page afterwards shows only the last four characters', async () => {
        const r = record(await t.get(`/projects/${projectId}/apps/${appId}`, { as: owner }));
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.ok(!r.text.includes(secrets[0]));
        assert.ok(r.text.includes(`…${secrets[0].slice(-4)}`));
    });

    await check('rotating shows the new secret once; neither secret appears again', async () => {
        const r = await t.get(`/projects/${projectId}/apps/${appId}/credentials/rotate`, { as: owner, form: { overlap_seconds: '3600' } });
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.strictEqual(r.headers.get('cache-control'), 'no-store');
        const s = (r.text.match(/ovsec_[A-Za-z0-9_-]{43}/) || [])[0];
        assert.ok(s && s !== secrets[0]);
        assert.ok(!r.text.includes(secrets[0]), 'the old secret is not shown with the new one');
        secrets.push(s);
        const again = record(await t.get(`/projects/${projectId}/apps/${appId}`, { as: owner }));
        for (const x of secrets) assert.ok(!again.text.includes(x));
    });

    await check('a playground run with the client secret neither stores nor echoes it', async () => {
        await t.grant(owner, projectId, appId, 'media.object.upload');
        const r = record(await t.get(`/projects/${projectId}/apps/${appId}/playground/media`, {
            as: owner, multipart: { fields: { credential_type: 'client_secret', credential: secrets[1] }, file: { name: 'hello.txt', content: 'hello world' } },
        }));
        assert.strictEqual(r.status, 200, r.text.slice(0, 500));
        assert.match(r.text, /Done\./);
        assert.ok(!r.text.includes(secrets[1]), 'the form comes back empty');
    });

    await check('a playground run with a pasted access token neither stores nor echoes it', async () => {
        const token = t.network.mintApp(appId, 'openvibe.media', ['media.object.upload']);
        secrets.push(token);
        const r = record(await t.get(`/projects/${projectId}/apps/${appId}/playground/media`, {
            as: owner, multipart: { fields: { credential_type: 'access_token', credential: token }, file: { name: 'b.txt', content: 'bytes' } },
        }));
        assert.strictEqual(r.status, 200, r.text.slice(0, 500));
        assert.ok(!r.text.includes(token));
    });

    await check('a refused playground run (wrong secret) does not echo it either', async () => {
        const wrong = 'ovsec_' + 'x'.repeat(43);
        secrets.push(wrong);
        const r = record(await t.get(`/projects/${projectId}/apps/${appId}/playground/media`, {
            as: owner, multipart: { fields: { credential_type: 'client_secret', credential: wrong }, file: { name: 'c.txt', content: 'c' } },
        }));
        assert.strictEqual(r.status, 401, r.text.slice(0, 500));
        assert.match(r.text, /invalid_client/);
        assert.ok(!r.text.includes(wrong));
    });

    await check('webhook tester secrets are not echoed', async () => {
        const hook = 'whsec_test_' + 'y'.repeat(40);
        secrets.push(hook);
        const r1 = record(await t.get('/tools/webhooks/verify', { form: { body: '{"event":{},"seq":1}', signature: 'sha256=00', secret: hook } }));
        assert.strictEqual(r1.status, 422);
        const r2 = record(await t.get('/tools/webhooks/sample', { form: { event_type: 'network.app.created', secret: hook } }));
        assert.strictEqual(r2.status, 200);
        assert.ok(!r1.text.includes(hook) && !r2.text.includes(hook));
    });

    await check('the release flow, audit and project pages carry no secret', async () => {
        for (const p of [`/projects/${projectId}`, `/projects/${projectId}/audit`, `/projects/${projectId}/apps/${appId}/playground`, '/projects', `/apps/${appId}`, `/api/v1/apps/${appId}/releases`]) {
            record(await t.get(p, { as: owner }));
        }
    });

    await check('no secret or token anywhere: database, logs, later responses', async () => {
        const dump = t.dbDump();
        const logs = t.logs();
        assert.ok(secrets.length >= 5);
        for (const s of secrets) {
            assert.ok(!dump.includes(s), `secret ${s.slice(0, 10)}… found in the database`);
            assert.ok(!logs.includes(s), `secret ${s.slice(0, 10)}… found in the logs`);
            for (const body of seen) assert.ok(!body.includes(s), `secret ${s.slice(0, 10)}… re-displayed`);
        }
        assert.ok(!/ovsec_[A-Za-z0-9_-]{20,}/.test(dump), 'no ovsec_ value of any kind in the database');
        // The user's own Network access token is never rendered either.
        const userToken = t.network.userToken(owner);
        assert.ok(!seen.some((b) => b.includes(userToken.split('.')[2])));
    });

    await check('session cookies are httpOnly (no script can read the Network token)', async () => {
        const code = t.network.issueCode(owner, 'x');
        void code;
        const login = await t.get('/auth/login?next=/projects');
        const flow = login.headers.get('set-cookie');
        assert.match(flow, /codes_oauth=.*HttpOnly/i);
    });

    await t.close();
    done();
})();
