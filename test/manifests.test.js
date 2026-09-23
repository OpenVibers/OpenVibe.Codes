'use strict';
/**
 * Manifest validation with openvibe-contracts: mods.mod-manifest@1 (released) and the app manifest
 * proposal compiled into the contracts validator; semantic checks against the pinned catalog.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const manifests = require('../server/domain/manifests');
const { boot, check, done } = require('./helpers/boot');

const FIX = path.join(path.dirname(require.resolve('openvibe-contracts/package.json')), 'fixtures', 'mods.mod-manifest');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const APP = 'app_01JABCDEFGHJKMNPQRSTVWXYZ0';
const PRJ = 'prj_01JABCDEFGHJKMNPQRSTVWXYZ0';

(async () => {
    await check('the contracts\' own mod fixtures: valid ones pass, invalid ones fail', async () => {
        for (const f of fs.readdirSync(path.join(FIX, 'valid'))) assert.strictEqual(manifests.validate('mod', read(path.join(FIX, 'valid', f))).valid, true, f);
        for (const f of fs.readdirSync(path.join(FIX, 'invalid'))) assert.strictEqual(manifests.validate('mod', read(path.join(FIX, 'invalid', f))).valid, false, f);
    });

    await check('schema errors come from openvibe-contracts with JSON pointers', async () => {
        const m = read(path.join(FIX, 'valid', fs.readdirSync(path.join(FIX, 'valid'))[0]));
        const v = manifests.validate('mod', { ...m, version: 'one' });
        assert.strictEqual(v.valid, false);
        assert.ok(v.errors.some((e) => e.path === '/version'));
        assert.strictEqual(v.schema.id, 'mods.mod-manifest');
    });

    await check('the starter templates validate', async () => {
        assert.deepStrictEqual(manifests.validate('app', manifests.template('app')).errors, []);
        assert.deepStrictEqual(manifests.validate('mod', manifests.template('mod')).errors, []);
    });

    await check('app manifests: unknown and non-grantable capabilities are errors', async () => {
        const internal = contracts.capabilities.manifests.find((c) => c.visibility === 'internal').id;
        const m = { ...manifests.template('app'), capabilities: ['media.object.upload', 'nope.not.real', internal] };
        const v = manifests.validate('app', m);
        assert.strictEqual(v.valid, false);
        assert.ok(v.errors.some((e) => e.path === '/capabilities/1' && /not in openvibe-contracts/.test(e.message)));
        assert.ok(v.errors.some((e) => e.path === '/capabilities/2' && /never granted/.test(e.message)));
        assert.ok(!v.errors.some((e) => e.path === '/capabilities/0'));
    });

    await check('ranges must parse; out-of-range pins are warnings', async () => {
        const bad = manifests.validate('app', { ...manifests.template('app'), compatibility: { contracts: 'lots' } });
        assert.ok(bad.errors.some((e) => e.path === '/compatibility/contracts'));
        const old = manifests.validate('app', { ...manifests.template('app'), compatibility: { contracts: '^0.5.0' } });
        assert.strictEqual(old.valid, true);
        assert.ok(old.warnings.some((w) => /outside \^0\.5\.0/.test(w.message)));
    });

    await check('unknown consumed events are warnings, not errors', async () => {
        const types = new Set(contracts.services.manifests.flatMap((m) => m.eventsProduced || []));
        const v = manifests.validate('app', { ...manifests.template('app'), events: { consumes: ['network.app.created', 'made.up.thing', 'network.*'] } }, { eventTypes: types });
        assert.strictEqual(v.valid, true);
        assert.strictEqual(v.warnings.filter((w) => /made\.up\.thing/.test(w.message)).length, 1);
        assert.ok(!v.warnings.some((w) => /network\.\*/.test(w.message)));
    });

    await check('for a release, the manifest must describe that app (id, project, environment, publisher)', async () => {
        const app = { id: APP, project_id: PRJ, environment: 'sandbox', grants: [] };
        const ok = manifests.validate('app', manifests.template('app', { appId: APP, projectId: PRJ }), { app });
        assert.strictEqual(ok.valid, true, JSON.stringify(ok.errors));
        const other = manifests.validate('app', { ...manifests.template('app', { appId: APP, projectId: PRJ }), id: 'app_01JZZZZZZZZZZZZZZZZZZZZZZZ', environment: 'production', publisher: { type: 'user', id: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0' } }, { app, viewerSubject: 'usr_01JBBBBBBBBBBBBBBBBBBBBBBB' });
        assert.ok(other.errors.some((e) => e.path === '/id'));
        assert.ok(other.errors.some((e) => e.path === '/environment'));
        assert.ok(other.errors.some((e) => e.path === '/publisher'));
        const ungranted = manifests.validate('app', { ...manifests.template('app', { appId: APP, projectId: PRJ }), capabilities: ['media.object.upload'] }, { app });
        assert.ok(ungranted.warnings.some((w) => /not granted to this app yet/.test(w.message)));
    });

    await check('the app manifest schema is loaded into openvibe-contracts\' validator (proposal until released)', async () => {
        const info = manifests.appSchemaInfo();
        assert.strictEqual(info.id, 'codes.app-manifest');
        assert.strictEqual(info.released, false);
        const v = manifests.validate('app', { ...manifests.template('app'), publisher: { type: 'nobody', id: 'x' } });
        assert.ok(v.errors.some((e) => e.path.startsWith('/publisher')), 'the $ref to identity.subject-ref resolves');
    });

    const t = await boot();
    await check('the validator page and API work without signing in and store nothing', async () => {
        const r = await t.get('/manifests/validate', { form: { kind: 'mod', manifest: JSON.stringify(manifests.template('mod')) } });
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /Valid\./);
        const bad = await t.get('/manifests/validate', { form: { kind: 'app', manifest: '{not json' } });
        assert.strictEqual(bad.status, 422);
        assert.match(bad.text, /not valid JSON/);
        const api = await t.get('/api/v1/manifests/validate', { json: { kind: 'app', manifest: { ...manifests.template('app'), capabilities: ['nope.not.real'] } } });
        assert.strictEqual(api.status, 422);
        assert.strictEqual(api.json().valid, false);
        assert.strictEqual(api.json().contracts_version, require('openvibe-contracts/package.json').version);
        assert.strictEqual(t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM manifests').get().n, 0);
    });
    await t.close();
    done();
})();
