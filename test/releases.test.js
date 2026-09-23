'use strict';
/**
 * Release metadata (Codes-owned, keyed to Network app ids) and its events.
 *   - draft → published → deprecated → revoked, with Network's role rules (developer+ sandbox)
 *   - each public transition writes codes.app.published|deprecated|revoked to the SDK outbox in the
 *     same transaction, as a valid events.event-envelope@1
 *   - trust tiers are staff-set metadata and change no permission
 *   - an app manages its own releases with an app token carrying codes.release.manage
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const manifests = require('../server/domain/manifests');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const owner = t.network.addUser('rosa');
    const viewer = t.network.addUser('vic');
    const staff = t.network.addUser('root', { role: 'admin' });
    const projectId = await t.project(owner, 'Releases');
    await t.get(`/projects/${projectId}/members`, { as: owner, form: { username: 'vic', role: 'viewer' } });
    const app = await t.app(owner, projectId, { name: 'Releaser' });
    const base = `/projects/${projectId}/apps/${app.id}`;
    const manifest = (version, extra = {}) => JSON.stringify({ ...manifests.template('app', { appId: app.id, projectId, environment: 'sandbox', name: 'Releaser' }), version, ...extra });
    const outbox = () => t.ctx.store.db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all().map((r) => JSON.parse(r.envelope));
    let rel1;
    let rel2;

    await check('the editor validates without creating anything', async () => {
        const r = await t.get(`${base}/releases`, { as: owner, form: { kind: 'app', manifest: manifest('1.0.0'), intent: 'validate' } });
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /Valid\./);
        assert.strictEqual(t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM releases').get().n, 0);
    });

    await check('an invalid manifest creates nothing and shows the errors', async () => {
        const r = await t.get(`${base}/releases`, { as: owner, form: { kind: 'app', manifest: manifest('1.0.0', { id: 'app_01JZZZZZZZZZZZZZZZZZZZZZZZ' }), intent: 'create' } });
        assert.strictEqual(r.status, 422);
        assert.match(r.text, /must be this app&#39;s id/);
        assert.strictEqual(t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM releases').get().n, 0);
    });

    await check('a draft is created, visible to members only, and emits nothing', async () => {
        const r = await t.get(`${base}/releases`, { as: owner, form: { kind: 'app', manifest: manifest('1.0.0'), intent: 'create', notes: 'First.' } });
        assert.strictEqual(r.status, 303, r.text.slice(0, 400));
        rel1 = r.headers.get('location').split('/').pop();
        assert.match(rel1, /^rel_/);
        assert.strictEqual((await t.get(`/releases/${rel1}`)).status, 404, 'anonymous cannot see a draft');
        assert.strictEqual((await t.get(`/releases/${rel1}`, { as: owner })).status, 200);
        assert.strictEqual((await t.get(`/api/v1/releases/${rel1}`)).status, 404);
        assert.strictEqual(outbox().length, 0);
    });

    await check('versions are immutable: the same version again is 409', async () => {
        const r = await t.get(`${base}/releases`, { as: owner, form: { kind: 'app', manifest: manifest('1.0.0'), intent: 'create' } });
        assert.strictEqual(r.status, 409);
        assert.match(r.text, /release\.exists/);
    });

    await check('a viewer cannot publish (Network reports the role; Codes enforces its own records)', async () => {
        const r = await t.get(`/releases/${rel1}/publish`, { as: viewer, form: {} });
        assert.strictEqual(r.status, 403);
        assert.match(r.text, /needs the developer role/);
    });

    await check('publishing emits codes.app.published (valid envelope, 3 segments, public)', async () => {
        const r = await t.get(`/releases/${rel1}/publish`, { as: owner, form: {} });
        assert.strictEqual(r.status, 303);
        const ev = outbox();
        assert.strictEqual(ev.length, 1);
        const e = ev[0];
        assert.strictEqual(e.event_type, 'codes.app.published');
        assert.strictEqual(e.event_type.split('.').length, 3);
        assert.strictEqual(e.source, 'codes');
        assert.deepStrictEqual(e.subject, { type: 'app', id: app.id });
        assert.deepStrictEqual(e.actor, { type: 'user', id: owner.subject });
        assert.strictEqual(e.payload.release_id, rel1);
        assert.strictEqual(e.payload.project_id, projectId);
        assert.strictEqual(e.payload.trust_tier, 'unreviewed');
        assert.strictEqual(contracts.validate('events.event-envelope@1', e).valid, true);
        const pub = await t.get(`/api/v1/apps/${app.id}/releases`);
        assert.strictEqual(pub.json().releases[0].status, 'published');
        const pageAnon = await t.get(`/releases/${rel1}`);
        assert.strictEqual(pageAnon.status, 200);
    });

    await check('deprecating needs a reason and a published replacement of the same app', async () => {
        const r2 = await t.get(`${base}/releases`, { as: owner, form: { kind: 'app', manifest: manifest('1.1.0'), intent: 'create' } });
        rel2 = r2.headers.get('location').split('/').pop();
        const noReason = await t.get(`/releases/${rel1}/deprecate`, { as: owner, form: { reason: '' } });
        assert.strictEqual(noReason.status, 422);
        const draftRepl = await t.get(`/releases/${rel1}/deprecate`, { as: owner, form: { reason: 'old', replacement: rel2 } });
        assert.strictEqual(draftRepl.status, 422, 'a draft cannot be the replacement');
        await t.get(`/releases/${rel2}/publish`, { as: owner, form: {} });
        const ok = await t.get(`/releases/${rel1}/deprecate`, { as: owner, form: { reason: 'Use 1.1.0', replacement: rel2 } });
        assert.strictEqual(ok.status, 303);
        const e = outbox().pop();
        assert.strictEqual(e.event_type, 'codes.app.deprecated');
        assert.strictEqual(e.payload.replacement, rel2);
    });

    await check('revoking needs confirmation and a reason; emits codes.app.revoked; is terminal', async () => {
        const unconfirmed = await t.get(`/releases/${rel1}/revoke`, { as: owner, form: { reason: 'bad' } });
        assert.strictEqual(unconfirmed.status, 422);
        const ok = await t.get(`/releases/${rel1}/revoke`, { as: owner, form: { reason: 'Security issue', confirm: '1' } });
        assert.strictEqual(ok.status, 303);
        assert.strictEqual(outbox().pop().event_type, 'codes.app.revoked');
        const again = await t.get(`/releases/${rel1}/revoke`, { as: owner, form: { reason: 'x', confirm: '1' } });
        assert.strictEqual(again.status, 409);
    });

    await check('revoking a draft announces nothing (it was never public)', async () => {
        const r = await t.get(`${base}/releases`, { as: owner, form: { kind: 'app', manifest: manifest('2.0.0-rc.1'), intent: 'create' } });
        const id = r.headers.get('location').split('/').pop();
        const n = outbox().length;
        await t.get(`/releases/${id}/revoke`, { as: owner, form: { reason: 'abandoned', confirm: '1' } });
        assert.strictEqual(outbox().length, n);
    });

    await check('only the three codes.app.* types are ever produced', async () => {
        const types = new Set(outbox().map((e) => e.event_type));
        for (const x of types) assert.ok(['codes.app.published', 'codes.app.deprecated', 'codes.app.revoked'].includes(x), x);
    });

    await check('trust tiers: staff only, noted, recorded, and they change no permission', async () => {
        const denied = await t.get('/staff/trust', { as: owner, form: { app_id: app.id, tier: 'reviewed', note: 'me' } });
        assert.strictEqual(denied.status, 403);
        const old = await t.get('/staff/trust', { as: staff, form: { app_id: app.id, tier: 'verified', note: 'pre-ADR-013 name' } });
        assert.strictEqual(old.status, 422, 'only ADR-013 tiers are accepted');
        const page = await t.get('/staff', { as: staff });
        assert.deepStrictEqual([...page.text.matchAll(/<option>([^<]+)<\/option>/g)].map((m) => m[1]), ['unreviewed', 'reviewed', 'first-party']);
        const ok = await t.get('/staff/trust', { as: staff, form: { app_id: app.id, tier: 'reviewed', note: 'Reviewed the source' } });
        assert.strictEqual(ok.status, 303);
        const trust = (await t.get(`/api/v1/apps/${app.id}/trust`)).json();
        assert.strictEqual(trust.tier, 'reviewed');
        assert.match(trust.note_on_authority, /metadata only/);
        // A reviewed app is still refused by the playground without the grant.
        const r = await t.get(`${base}/playground/media`, { as: owner, multipart: { fields: { credential_type: 'client_secret', credential: app.secret }, file: { name: 'x', content: 'x' } } });
        assert.strictEqual(r.status, 403);
        // And a viewer still cannot publish.
        const r3 = await t.get(`${base}/releases`, { as: owner, form: { kind: 'app', manifest: manifest('3.0.0'), intent: 'create' } });
        const id = r3.headers.get('location').split('/').pop();
        assert.strictEqual((await t.get(`/releases/${id}/publish`, { as: viewer, form: {} })).status, 403);
    });

    await check('mod releases validate as mods.mod-manifest@1', async () => {
        const mod = { ...manifests.template('mod', { appId: app.id }), id: contracts.ids.newId('mod'), version: '0.1.0' };
        const r = await t.get(`${base}/releases`, { as: owner, form: { kind: 'mod', manifest: JSON.stringify(mod), intent: 'create' } });
        assert.strictEqual(r.status, 303, r.text.slice(0, 300));
        const rel = t.ctx.releases.get(r.headers.get('location').split('/').pop());
        assert.strictEqual(rel.kind, 'mod');
        assert.strictEqual(rel.subject_id, mod.id);
    });

    // ── App token API ──
    await check('an app token with codes.release.manage creates and publishes its own release', async () => {
        const token = t.network.mintApp(app.id, 'openvibe.codes', ['codes.release.manage']);
        const r = await t.get(`/api/v1/apps/${app.id}/releases`, { headers: { authorization: `Bearer ${token}` }, json: { kind: 'app', manifest: JSON.parse(manifest('4.0.0', { publisher: { type: 'app', id: app.id } })), publish: true } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json().release.status, 'published');
        const e = outbox().pop();
        assert.deepStrictEqual(e.actor, { type: 'app', id: app.id });
    });

    await check('the API refuses: no token, wrong audience, no capability, another app', async () => {
        const body = { kind: 'app', manifest: JSON.parse(manifest('5.0.0')) };
        assert.strictEqual((await t.get(`/api/v1/apps/${app.id}/releases`, { json: body })).status, 401);
        const wrongAud = t.network.mintApp(app.id, 'openvibe.media', ['codes.release.manage']);
        assert.strictEqual((await t.get(`/api/v1/apps/${app.id}/releases`, { headers: { authorization: `Bearer ${wrongAud}` }, json: body })).status, 401);
        const noCap = t.network.mintApp(app.id, 'openvibe.codes', ['media.object.upload']);
        const r3 = await t.get(`/api/v1/apps/${app.id}/releases`, { headers: { authorization: `Bearer ${noCap}` }, json: body });
        assert.strictEqual(r3.status, 403);
        assert.strictEqual(r3.json().code, 'capability.denied');
        const other = await t.app(owner, projectId, { name: 'Other' });
        const otherTok = t.network.mintApp(other.id, 'openvibe.codes', ['codes.release.manage']);
        const r4 = await t.get(`/api/v1/apps/${app.id}/releases`, { headers: { authorization: `Bearer ${otherTok}` }, json: body });
        assert.strictEqual(r4.json().code, 'release.forbidden');
        assert.strictEqual(r4.status, 403);
        assert.strictEqual(r4.headers.get('content-type'), 'application/problem+json');
        const userTok = t.network.userToken(owner);
        assert.strictEqual((await t.get(`/api/v1/apps/${app.id}/releases`, { headers: { authorization: `Bearer ${userTok}` }, json: body })).status, 401);
    });

    await check('public reads need no token; a presented token must hold codes.release.read', async () => {
        assert.strictEqual((await t.get(`/api/v1/apps/${app.id}/releases`)).status, 200);
        const withRead = t.network.mintApp(app.id, 'openvibe.codes', ['codes.release.read']);
        assert.strictEqual((await t.get(`/api/v1/apps/${app.id}/releases`, { headers: { authorization: `Bearer ${withRead}` } })).status, 200);
        const without = t.network.mintApp(app.id, 'openvibe.codes', ['codes.release.manage']);
        const r = await t.get(`/api/v1/apps/${app.id}/trust`, { headers: { authorization: `Bearer ${without}` } });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(r.json().code, 'capability.denied');
        const forged = await t.get(`/api/v1/apps/${app.id}/releases`, { headers: { authorization: 'Bearer not.a.jwt' } });
        assert.strictEqual(forged.status, 401);
    });

    await t.close();
    done();
})();
