'use strict';
// Codes' authority resource index (ADR-048 section 3; capability codes.resource.read):
// GET /api/v1/resources pages common.resource-summary@1 for the resources Codes owns — its validated
// manifests (codes.manifest, mfs_) and its releases (codes.release, rel_) — and GET /api/v1/resources/:ovrn
// reads one by its computed ovrn. ?project=&kind=&cursor=&limit= are honoured; ?project= is the tenancy
// boundary, so a resource of another project is never returned. Both kinds are nameable, so every summary
// carries an ovrn; every summary carries the project it was created in. The guard is the service-token
// capability check (no token 401, a token without the capability 403, with it 200), and every page and
// every read is validated against the released common.resource-list-result@1 / common.resource-summary@1.
const assert = require('assert');
const crypto = require('crypto');
const { validate, ids, serviceAuth } = require('openvibe-contracts');
const resourceIndex = require('../server/registry/resource-index');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const db = t.ctx.store.db;
    const at = '2026-10-01T00:00:00Z';

    // ── Fixtures: two projects, their manifests (user- and app-created) and releases in three states ──
    const prjA = ids.newId('project'); const prjB = ids.newId('project');
    const usrA = ids.newId('user');
    const appA = ids.newId('app'); const appB = ids.newId('app');
    const subjA = ids.newId('app'); const subjB = ids.newId('app');
    const mfsA1 = ids.newId('manifest'); const mfsA2 = ids.newId('manifest'); const mfsB = ids.newId('manifest');
    const relA1 = ids.newId('release'); const relA2 = ids.newId('release'); const relB = ids.newId('release');
    const usrB = ids.newId('user');

    const insertManifest = db.prepare('INSERT INTO manifests (id, kind, app_id, project_id, subject_id, version, body, contracts_version, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertRelease = db.prepare("INSERT INTO releases (id, app_id, project_id, environment, kind, subject_id, name, version, manifest_id, status, compatibility, notes, created_by, created_at) VALUES (?, ?, ?, 'sandbox', ?, ?, ?, ?, ?, ?, '{}', '', ?, ?)");
    const body = (subject, name, version) => JSON.stringify({ id: subject, name, version });
    await insertManifest.run(mfsA1, 'app', appA, prjA, subjA, '1.0.0', body(subjA, 'Notes app', '1.0.0'), '0.107.0', `user:${usrA}`, at);
    await insertManifest.run(mfsA2, 'app', appA, prjA, subjA, '1.1.0', body(subjA, 'Notes app', '1.1.0'), '0.107.0', `app:${appA}`, at);
    await insertManifest.run(mfsB, 'app', appB, prjB, subjB, '1.0.0', body(subjB, 'Other app', '1.0.0'), '0.107.0', `user:${usrB}`, at);
    await insertRelease.run(relA1, appA, prjA, 'app', subjA, 'Notes app', '1.0.0', mfsA1, 'published', `user:${usrA}`, at);
    await insertRelease.run(relA2, appA, prjA, 'app', subjA, 'Notes app', '1.1.0', mfsA2, 'draft', `app:${appA}`, at);
    await insertRelease.run(relB, appB, prjB, 'app', subjB, 'Other app', '1.0.0', mfsB, 'revoked', `user:${usrB}`, at);

    const expected = [
        { id: mfsA1, kind: resourceIndex.MANIFEST_KIND }, { id: mfsA2, kind: resourceIndex.MANIFEST_KIND }, { id: mfsB, kind: resourceIndex.MANIFEST_KIND },
        { id: relA1, kind: resourceIndex.RELEASE_KIND }, { id: relA2, kind: resourceIndex.RELEASE_KIND }, { id: relB, kind: resourceIndex.RELEASE_KIND },
    ].sort((x, y) => (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    const ovrnOfManifest = (project, id) => `ovrn:codes:${project}:manifest/${id}`;
    const ovrnOfRelease = (project, id) => `ovrn:codes:${project}:release/${id}`;

    // A first-party service token signed by the Network mock, holding the capabilities asked for.
    const token = (cap, { aud = 'openvibe.codes', sub = 'svc:services' } = {}) => {
        const now = Math.floor(Date.now() / 1000);
        return serviceAuth.signServiceToken({ iss: t.network.url, sub, actor_type: 'service', aud: [aud], cap, iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(8).toString('hex')}` }, t.network.privatePem);
    };
    const get = (path, headers) => t.get(path, headers ? { headers } : {});
    const auth = { authorization: `Bearer ${token([resourceIndex.RESOURCE_READ])}` };

    await check('no token 401, a token without codes.resource.read 403, wrong audience 401, with it 200', async () => {
        const none = await get('/api/v1/resources');
        assert.deepStrictEqual([none.status, none.json().code], [401, 'auth.required']);
        assert.ok(/^application\/problem\+json/.test(none.headers.get('content-type')));
        const without = await get('/api/v1/resources', { authorization: `Bearer ${token(['codes.release.read'])}` });
        assert.deepStrictEqual([without.status, without.json().code], [403, 'capability.denied']);
        const wrongAud = await get('/api/v1/resources', { authorization: `Bearer ${token([resourceIndex.RESOURCE_READ], { aud: 'openvibe.media' })}` });
        assert.deepStrictEqual([wrongAud.status, wrongAud.json().code], [401, 'token.wrong_audience']);
        const forged = await get('/api/v1/resources', { authorization: 'Bearer not.a.jwt' });
        assert.strictEqual(forged.status, 401);
        assert.strictEqual((await get('/api/v1/resources', auth)).status, 200);
        // The guard is on the single read too.
        assert.strictEqual((await get(`/api/v1/resources/${encodeURIComponent(ovrnOfRelease(prjA, relA1))}`)).status, 401);
    });

    const aPage = async (q = '', headers = auth) => {
        const y = await get(`/api/v1/resources${q}`, headers);
        assert.strictEqual(y.status, 200, `${q}: ${y.text.slice(0, 300)}`);
        assert.ok(validate('common.resource-list-result@1', y.json()).valid, JSON.stringify(validate('common.resource-list-result@1', y.json()).errors));
        return y;
    };
    const idsOf = async (q, headers = auth) => (await aPage(q, headers)).json().resources.map((r) => r.id);

    await check('the page is common.resource-list-result@1: only its fields, every summary valid and sorted', async () => {
        const y = await aPage();
        assert.strictEqual(y.headers.get('cache-control'), 'private, max-age=60');
        assert.deepStrictEqual(Object.keys(y.json()).sort(), ['next_cursor', 'resources'], 'the page carries only the contract fields');
        y.json().resources.forEach((s) => assert.ok(validate('common.resource-summary@1', s).valid, `${s.id}: ${JSON.stringify(validate('common.resource-summary@1', s).errors)}`));
        assert.strictEqual(y.json().next_cursor, null, 'one page holds the whole index');
        assert.deepStrictEqual(y.json().resources.map((r) => [r.kind, r.id]), expected.map((r) => [r.kind, r.id]), 'both kinds, sorted by (kind, id)');
        assert.deepStrictEqual([...new Set(y.json().resources.map((r) => r.service))], ['codes']);
        assert.deepStrictEqual([...new Set(y.json().resources.map((r) => r.project_id))].sort(), [prjA, prjB].sort(), 'every summary carries the project it was created in');
    });

    await check('every summary carries its computed ovrn, name, state and owner', async () => {
        const byId = new Map((await aPage()).json().resources.map((r) => [r.id, r]));
        assert.strictEqual(byId.get(mfsA1).ovrn, ovrnOfManifest(prjA, mfsA1));
        assert.strictEqual(byId.get(mfsB).ovrn, ovrnOfManifest(prjB, mfsB));
        assert.strictEqual(byId.get(relA1).ovrn, ovrnOfRelease(prjA, relA1));
        assert.strictEqual(byId.get(relB).ovrn, ovrnOfRelease(prjB, relB));
        assert.strictEqual(byId.get(mfsA1).name, 'Notes app', 'a manifest is named by its stored body');
        assert.strictEqual(byId.get(relA1).name, 'Notes app', "a release is named by the release row's own name");
        assert.deepStrictEqual(byId.get(mfsA1).owner, { type: 'user', id: usrA }, 'a user-created resource names its owner');
        assert.ok(!('owner' in byId.get(mfsA2)), 'an app-created resource has no person owner');
        assert.strictEqual(byId.get(mfsA1).state, 'valid', 'a stored manifest is a validated, immutable row');
        assert.strictEqual(byId.get(relA1).state, 'published', 'a release state is its status');
        assert.strictEqual(byId.get(relA2).state, 'draft');
        assert.strictEqual(byId.get(relB).state, 'revoked');
    });

    await check('?project= is the tenancy boundary: another project\'s rows are never returned', async () => {
        assert.deepStrictEqual((await idsOf(`?project=${prjA}`)).sort(), [mfsA1, mfsA2, relA1, relA2].sort());
        assert.deepStrictEqual((await idsOf(`?project=${prjB}`)).sort(), [mfsB, relB].sort());
        assert.deepStrictEqual(await idsOf(`?project=${ids.newId('project')}`), [], 'an unknown project has no resources');
        for (const s of (await aPage(`?project=${prjA}`)).json().resources) assert.strictEqual(s.project_id, prjA);
    });

    await check('?kind= narrows to one kind; an unknown kind is an empty page, not an error', async () => {
        assert.deepStrictEqual((await idsOf('?kind=codes.manifest')).sort(), [mfsA1, mfsA2, mfsB].sort());
        assert.deepStrictEqual((await idsOf('?kind=codes.release')).sort(), [relA1, relA2, relB].sort());
        assert.deepStrictEqual((await idsOf(`?project=${prjA}&kind=codes.release`)).sort(), [relA1, relA2].sort(), 'kind narrows within the project');
        assert.deepStrictEqual(await idsOf('?kind=codes.unknown'), []);
    });

    await check('an opaque cursor pages the whole index: no duplicates, none skipped, order preserved', async () => {
        const seen = [];
        let cursor = null;
        let pages = 0;
        for (;;) {
            const y = await aPage(`?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
            seen.push(...y.json().resources.map((r) => r.id));
            if (y.json().next_cursor === null) { assert.strictEqual(seen.length, expected.length, 'the cursor chain ends at the end'); break; }
            assert.ok(typeof y.json().next_cursor === 'string' && y.json().next_cursor !== '');
            cursor = y.json().next_cursor;
            if (++pages > 50) assert.fail('the cursor chain never ended');
        }
        assert.deepStrictEqual(seen, expected.map((r) => r.id));
        assert.deepStrictEqual(await idsOf('?limit=1000'), expected.map((r) => r.id), 'the maximum limit still pages one result');
    });

    await check('GET /:ovrn reads one resource by its computed name', async () => {
        const listed = new Map((await aPage()).json().resources.map((r) => [r.id, r]));
        for (const [why, name, id] of [['a manifest', ovrnOfManifest(prjA, mfsA1), mfsA1], ['a release', ovrnOfRelease(prjA, relA1), relA1]]) {
            const y = await get(`/api/v1/resources/${encodeURIComponent(name)}`, auth);
            assert.strictEqual(y.status, 200, `${why}: ${y.text.slice(0, 300)}`);
            assert.strictEqual(y.headers.get('cache-control'), 'private, max-age=60');
            assert.ok(validate('common.resource-summary@1', y.json()).valid);
            assert.deepStrictEqual(y.json(), listed.get(id), `${why}: the same summary the list answers`);
        }
    });

    await check('an unknown or non-matching OVRN is 404 resources.unknown_resource', async () => {
        const missing = [
            ['an unknown manifest', ovrnOfManifest(prjA, ids.newId('manifest'))],
            ['an unknown release', ovrnOfRelease(prjA, ids.newId('release'))],
            ["another project's resource", ovrnOfRelease(prjA, relB)],
            ['a type this service does not hold', `ovrn:codes:${prjA}:object/${mfsA1}`],
            ['an id of the other kind', ovrnOfRelease(prjA, mfsA1)],
            ['a non-OVRN', 'nope'],
        ];
        for (const [why, name] of missing) {
            const y = await get(`/api/v1/resources/${encodeURIComponent(name)}`, auth);
            assert.strictEqual(y.status, 404, why);
            assert.strictEqual(y.headers.get('content-type'), 'application/problem+json', why);
            assert.strictEqual(y.json().code, 'resources.unknown_resource', why);
        }
    });

    await check('a query that cannot be honoured is 400 resources.bad_query', async () => {
        const bad = [['?project=nope', 'project not a prj_ id'], ['?limit=0', 'limit below one'], ['?limit=abc', 'limit not a number'], ['?limit=99999', 'limit over the cap'], ['?cursor=***', 'cursor not one this index issued']];
        for (const [q, why] of bad) {
            const y = await get(`/api/v1/resources${q}`, auth);
            assert.strictEqual(y.status, 400, why);
            assert.strictEqual(y.headers.get('content-type'), 'application/problem+json', why);
            assert.strictEqual(y.json().code, 'resources.bad_query', why);
        }
    });

    await t.close();
    done();
})();
