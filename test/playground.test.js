'use strict';
/**
 * Playgrounds cannot exceed the project's grants.
 *   - without the grant: refused at the grant step, the missing grant is named, and NOTHING else
 *     happens (no token request to Network, no call to Events or Media)
 *   - production apps and revoked apps are refused
 *   - with the grant: the app's own token (from its secret, or pasted) is used through the SDK
 *   - a pasted token for another app, another audience or without the capability is refused
 *   - the Network refusing the token request surfaces as Network said it
 *   - the Events playground uses events.app.publish: app.<project_key>.* types, source app-<ulid>
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const owner = t.network.addUser('mia');
    const projectId = await t.project(owner, 'Play');
    const app = await t.app(owner, projectId);
    const base = `/projects/${projectId}/apps/${app.id}`;
    const key = `p${projectId.replace(/^prj_/, '').toLowerCase()}`;
    const media = (fields, file = { name: 'a.txt', content: 'hello' }) => t.get(`${base}/playground/media`, { as: owner, multipart: { fields, file } });
    const outside = () => ({
        token: t.network.tokenRequests.filter((x) => x.client_id === app.id).length,
        media: t.media.requests.length,
        events: t.events.requests.length,
    });

    await check('without media.object.upload: refused at the grant step, nothing requested or called', async () => {
        const before = outside();
        const r = await media({ credential_type: 'client_secret', credential: app.secret });
        assert.strictEqual(r.status, 403);
        assert.match(r.text, /does not hold media\.object\.upload/);
        assert.match(r.text, /Request media\.object\.upload on the app page/);
        assert.deepStrictEqual(outside(), before);
        const page = await t.get(`${base}/playground`, { as: owner });
        assert.match(page.text, /Cannot run:/);
        assert.ok(!page.text.includes(`action="${base}/playground/media"`), 'no upload form without the grant');
    });

    await check('without events.app.publish: refused, the grant named, nothing requested or called', async () => {
        const before = outside();
        const r = await t.get(`${base}/playground/events`, { as: owner, form: { event_type: `app.${key}.test.ping`, credential_type: 'client_secret', credential: app.secret } });
        assert.strictEqual(r.status, 403);
        assert.match(r.text, /does not hold events\.app\.publish/);
        assert.match(r.text, /Request events\.app\.publish on the app page/);
        assert.deepStrictEqual(outside(), before);
    });

    await check('a requested (not approved) grant still refuses', async () => {
        await t.get(`${base}/grants`, { as: owner, form: { capability: 'media.object.upload' } });   // outside the allowance → requested
        const before = outside();
        const r = await media({ credential_type: 'client_secret', credential: app.secret });
        assert.strictEqual(r.status, 403);
        assert.deepStrictEqual(outside(), before);
    });

    await check('with the grant and the client secret: uploads through the SDK with the app token', async () => {
        await t.grant(owner, projectId, app.id, 'media.object.upload');
        const r = await media({ credential_type: 'client_secret', credential: app.secret }, { name: 'hello.txt', content: 'hello playground' });
        assert.strictEqual(r.status, 200, r.text.slice(0, 400));
        assert.match(r.text, /Done\./);
        assert.strictEqual(t.media.uploads.length, 1);
        assert.strictEqual(t.media.uploads[0].app, projectId, 'the namespace is the project id');
        const tok = t.network.tokenRequests.filter((x) => x.client_id === app.id).pop();
        assert.strictEqual(tok.audience, 'openvibe.media');
        assert.strictEqual(tok.scope, 'media.object.upload');
    });

    await check('a pasted token for another app is refused before any call', async () => {
        const other = await t.app(owner, projectId, { name: 'Other' });
        await t.grant(owner, projectId, other.id, 'media.object.upload');
        const foreign = t.network.mintApp(other.id, 'openvibe.media', ['media.object.upload']);
        const before = outside();
        const r = await media({ credential_type: 'access_token', credential: foreign });
        assert.strictEqual(r.status, 401);
        assert.match(r.text, /not app:/);
        assert.deepStrictEqual(outside(), before);
    });

    await check('a pasted token without the capability, or for another audience, is refused', async () => {
        const noCap = t.network.mintApp(app.id, 'openvibe.media', ['media.object.read']);
        const r1 = await media({ credential_type: 'access_token', credential: noCap });
        assert.strictEqual(r1.status, 401);
        assert.match(r1.text, /does not carry media\.object\.upload/);
        const wrongAud = t.network.mintApp(app.id, 'openvibe.events', ['media.object.upload']);
        const r2 = await media({ credential_type: 'access_token', credential: wrongAud });
        assert.strictEqual(r2.status, 401);
        assert.match(r2.text, /not for openvibe\.media/);
        const prod = t.network.mintApp(app.id, 'openvibe.media', ['media.object.upload'], { env: 'production' });
        const r3 = await media({ credential_type: 'access_token', credential: prod });
        assert.strictEqual(r3.status, 401);
        assert.match(r3.text, /not sandbox/);
    });

    await check('Network refusing the token request is shown as Network said it', async () => {
        const r = await media({ credential_type: 'client_secret', credential: 'ovsec_wrong' });
        assert.strictEqual(r.status, 401);
        assert.match(r.text, /invalid_client/);
        assert.match(r.text, /Network refused the token request/);
    });

    await check('a sandbox audience Network does not allow: invalid_target surfaces', async () => {
        const t2 = await boot({ network: { sandboxAudiences: [] } });
        const o = t2.network.addUser('ned');
        const p = await t2.project(o);
        const a = await t2.app(o, p);
        await t2.grant(o, p, a.id, 'media.object.upload');
        const r = await t2.get(`/projects/${p}/apps/${a.id}/playground/media`, { as: o, multipart: { fields: { credential_type: 'client_secret', credential: a.secret }, file: { name: 'x', content: 'x' } } });
        assert.strictEqual(r.status, 400);
        assert.match(r.text, /invalid_target/);
        assert.match(r.text, /does not accept sandbox tokens/);
        assert.strictEqual(t2.media.requests.length, 0);
        await t2.close();
    });

    await check('production apps are refused', async () => {
        t.network.setEnvironmentPolicy(projectId, 'sandbox+production');
        const prod = await t.app(owner, projectId, { name: 'Prod', environment: 'production' });
        await t.grant(owner, projectId, prod.id, 'media.object.upload');
        const r = await t.get(`/projects/${projectId}/apps/${prod.id}/playground/media`, { as: owner, multipart: { fields: { credential_type: 'client_secret', credential: prod.secret }, file: { name: 'x', content: 'x' } } });
        assert.strictEqual(r.status, 403);
        assert.match(r.text, /playgrounds run only sandbox apps/);
    });

    await check('revoking the grant in Network stops the playground at once', async () => {
        await t.get(`${base}/grants/media.object.upload/revoke`, { as: owner, form: {} });
        const before = outside();
        const r = await media({ credential_type: 'client_secret', credential: app.secret });
        assert.strictEqual(r.status, 403);
        assert.deepStrictEqual(outside(), before);
    });

    await check('the run log records outcomes and codes, never the credential', async () => {
        const rows = t.ctx.store.db.prepare('SELECT * FROM playground_runs WHERE app_id = ? ORDER BY at').all(app.id);
        assert.ok(rows.length >= 6);
        assert.ok(rows.some((x) => x.outcome === 'ok' && x.ref));
        assert.ok(rows.some((x) => x.stage === 'grant' && x.code === 'playground.grant_missing'));
        const dump = JSON.stringify(rows);
        assert.ok(!dump.includes(app.secret));
        assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\./.test(dump), 'no JWT in the run log');
    });

    await check('a non-member cannot open the playground of another project\'s app', async () => {
        const stranger = t.network.addUser('zed');
        const r = await t.get(`${base}/playground`, { as: stranger });
        assert.strictEqual(r.status, 404);
        assert.match(r.text, /project\.not_found/);
    });

    await check('with events.app.publish: publishes as the app, with its source and project-scoped type', async () => {
        await t.grant(owner, projectId, app.id, 'events.app.publish');
        const r = await t.get(`${base}/playground/events`, { as: owner, form: { event_type: `app.${key}.test.ping`, payload: '{"n":1}', credential_type: 'client_secret', credential: app.secret } });
        assert.strictEqual(r.status, 200, r.text.slice(0, 600));
        assert.match(r.text, /Done\./);
        assert.strictEqual(t.events.published.length, 1);
        const e = t.events.published[0];
        assert.strictEqual(e.sub, `app:${app.id}`);
        assert.strictEqual(e.event.source, `app-${app.id.replace(/^app_/, '').toLowerCase()}`);
        assert.deepStrictEqual(e.event.actor, { type: 'app', id: app.id });
        const tok = t.network.tokenRequests.filter((x) => x.client_id === app.id).pop();
        assert.strictEqual(tok.audience, 'openvibe.events');
        assert.strictEqual(tok.scope, 'events.app.publish');
    });

    await check('an event type outside the project\'s app.<project_key>.* space is refused locally', async () => {
        const before = outside();
        const r = await t.get(`${base}/playground/events`, { as: owner, form: { event_type: 'network.app.created', credential_type: 'client_secret', credential: app.secret } });
        assert.strictEqual(r.status, 422);
        assert.match(r.text, new RegExp(`starting with app\\.${key}\\.`));
        assert.deepStrictEqual(outside(), before);
    });

    await t.close();
    done();
})();
