'use strict';
/**
 * One developer cannot act on another's projects, apps, credentials or releases by swapping ids
 * (roadmap WS-R task 5, the IDOR class). Project data lives at OpenVibe.Network (Codes asks with the
 * person's own token, so Network's rules apply); releases, trust tiers and playground runs are
 * Codes' own. Ann and Bob each have a project with an app; Ann has a draft release. Bob tries every
 * page and form that takes an id with Ann's instead (her project's pages, apps, members, credentials,
 * grants, redirects, playground, archive, export, delete), and the nested swap: his own project in the
 * path with Ann's app or credential id. Then Ann's releases: the draft's page and API, and publish,
 * deprecate, revoke. Every refusal leaves Network's projects, apps and credentials and every table of
 * Codes as they were, and shows nothing of Ann's (her app's name, its secret, the draft's notes);
 * controls show the routes work for their owner.
 *
 *   node test/security-idor.test.js
 */
const assert = require('assert');
const manifests = require('../server/domain/manifests');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const ann = t.network.addUser('ann');
    const bob = t.network.addUser('bob');
    const annProject = await t.project(ann, 'Ann Secret Project');
    const annApp = await t.app(ann, annProject, { name: 'Ann Hidden App' });
    const bobProject = await t.project(bob, 'Bob Project');
    const bobApp = await t.app(bob, bobProject, { name: 'Bob App' });
    const annCred = [...t.network.state.creds.values()].find((c) => c.app_id === annApp.id);
    const manifest = JSON.stringify({ ...manifests.template('app', { appId: annApp.id, projectId: annProject, environment: 'sandbox', name: 'Ann Hidden App' }), version: '1.0.0' });
    const made = await t.get(`/projects/${annProject}/apps/${annApp.id}/releases`, { as: ann, form: { kind: 'app', manifest, intent: 'create', notes: 'ann-draft-notes' } });
    assert.strictEqual(made.status, 303, made.text.slice(0, 200));
    const annRelease = made.headers.get('location').split('/').pop();

    const networkState = () => JSON.stringify([[...t.network.state.projects.entries()], [...t.network.state.members.entries()], [...t.network.state.apps.entries()], [...t.network.state.creds.entries()]]);
    const snapshot = () => networkState() + t.dbDump();
    const HERS = ['Ann Hidden App', 'ann-draft-notes', ...(annApp.secret ? [annApp.secret] : [])];
    const refused = (r, what) => {
        assert.ok([401, 403, 404].includes(r.status) || (r.status === 303 && /\/login|\/auth/.test(r.headers.get('location') || '')), `${what}: ${r.status} ${r.text.slice(0, 160)}`);
        for (const h of HERS) assert.ok(!r.text.includes(h), `${what}: the answer carries "${h}"`);
    };

    await check('pages: Bob sees nothing of Ann\'s project, apps or releases', async () => {
        for (const p of ['', '/audit', '/usage', '/export', `/apps/${annApp.id}`, `/apps/${annApp.id}/playground`, `/apps/${annApp.id}/releases/new`]) {
            refused(await t.get(`/projects/${annProject}${p}`, { as: bob }), `GET project${p}`);
        }
        refused(await t.get(`/projects/${bobProject}/apps/${annApp.id}`, { as: bob }), 'Ann\'s app under Bob\'s project');
        refused(await t.get(`/releases/${annRelease}`, { as: bob }), 'Ann\'s draft release page');
        refused(await t.get(`/api/v1/releases/${annRelease}`), 'Ann\'s draft release API (anonymous)');
        const list = await t.get(`/api/v1/apps/${annApp.id}/releases`);
        assert.ok(!list.text.includes(annRelease) && !list.text.includes('ann-draft-notes'), 'the public release list holds no draft');
    });

    await check('forms: Bob cannot change Ann\'s project, apps, members, credentials, grants or releases', async () => {
        const before = snapshot();
        const P = `/projects/${annProject}`;
        const A = `${P}/apps/${annApp.id}`;
        for (const [p, form] of [
            [`${P}/apps`, { name: 'Bob in Ann', environment: 'sandbox', type: 'confidential', redirect_uris: '' }],
            [`${P}/members`, { username: 'bob', role: 'owner' }],
            [`${P}/members/${ann.subject}/remove`, {}], [`${P}/members/${ann.subject}/role`, { role: 'viewer' }],
            [`${A}/credentials/rotate`, {}], [`${A}/credentials/${annCred ? annCred.id : 'cred_x'}/revoke`, {}],
            [`${A}/grants`, { capability: 'media.object.upload' }], [`${A}/redirects`, { redirect_uris: 'https://bob.example/cb' }],
            [`${A}/revoke`, { confirm: '1' }], [`${A}/releases`, { kind: 'app', manifest, intent: 'create' }],
            [`${A}/playground/events`, { event_type: 'x' }], [`${A}/playground/media`, {}],
            [`${P}/archive`, { confirm: '1' }], [`${P}/delete`, { confirm: '1', name: annProject }], [`${P}/export/archive`, {}],
            // His own project in the path, her ids after it.
            [`/projects/${bobProject}/apps/${annApp.id}/credentials/rotate`, {}],
            [`/projects/${bobProject}/apps/${annApp.id}/revoke`, { confirm: '1' }],
            [`/projects/${bobProject}/apps/${bobApp.id}/credentials/${annCred ? annCred.id : 'cred_x'}/revoke`, {}],
            [`/releases/${annRelease}/publish`, {}], [`/releases/${annRelease}/deprecate`, { reason: 'x' }], [`/releases/${annRelease}/revoke`, { reason: 'x' }],
        ]) {
            refused(await t.get(p, { as: bob, form }), `POST ${p}`);
        }
        assert.strictEqual(snapshot(), before, 'something of Ann\'s changed');
    });

    await check('controls: Ann reads her project and publishes her release', async () => {
        const page = await t.get(`/projects/${annProject}/apps/${annApp.id}`, { as: ann });
        assert.strictEqual(page.status, 200);
        assert.ok(page.text.includes('Ann Hidden App'));
        const r = await t.get(`/releases/${annRelease}/publish`, { as: ann, form: {} });
        assert.strictEqual(r.status, 303, r.text.slice(0, 200));
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
