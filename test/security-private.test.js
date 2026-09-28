'use strict';
/**
 * A developer's projects, apps, credentials and draft releases reach nobody else, on any path
 * (roadmap WS-R task 5, the private-object class). Ann has a project with an app (its client secret
 * and credential), a member, a draft release with notes, and a playground page; Bob has his own
 * project. Every route the booted app has (listed from Express's router stack, test/security-crawl.js)
 * is requested with Ann's project, app, credential, release and subject ids in every parameter,
 * as anonymous, Bob and a signed-in person with no project. Ann's project and app names, the
 * secret and the draft's notes never appear (the public release list and pages carry
 * published releases only). A control shows Ann sees them.
 *
 *   node test/security-private.test.js
 */
const assert = require('assert');
const manifests = require('../server/domain/manifests');
const appModule = require('../server/app');
let capturedApp = null;
const realCreate = appModule.createApp;
appModule.createApp = async (...a) => { const built = await realCreate(...a); capturedApp = built.app; return built; };
const { boot, check, done } = require('./helpers/boot');
const { getPaths, crawl } = require('./security-crawl');

(async () => {
    const t = await boot();
    assert.ok(capturedApp, 'the Express app was captured');
    const ann = t.network.addUser('ann');
    const bob = t.network.addUser('bob');
    const nobody = t.network.addUser('nobody');
    const annProject = await t.project(ann, 'Ann Secret Project');
    const annApp = await t.app(ann, annProject, { name: 'Ann Hidden App' });
    await t.project(bob, 'Bob Project');
    const cred = [...t.network.state.creds.values()].find((c) => c.app_id === annApp.id);
    const manifest = JSON.stringify({ ...manifests.template('app', { appId: annApp.id, projectId: annProject, environment: 'sandbox', name: 'Ann Hidden App' }), version: '1.0.0' });
    const made = await t.get(`/projects/${annProject}/apps/${annApp.id}/releases`, { as: ann, form: { kind: 'app', manifest, intent: 'create', notes: 'ann-draft-notes' } });
    assert.strictEqual(made.status, 303, made.text.slice(0, 200));
    const release = made.headers.get('location').split('/').pop();
    // (Ids are not needles: a page may echo the address it was asked for.)
    const SECRET = { project: 'Ann Secret Project', app: 'Ann Hidden App', notes: 'ann-draft-notes', ...(annApp.secret ? { secret: annApp.secret } : {}) };

    await check('control: Ann sees her project, app and draft', async () => {
        assert.ok((await t.get(`/projects/${annProject}`, { as: ann })).text.includes('Ann Secret Project'));
        assert.ok((await t.get(`/releases/${release}`, { as: ann })).text.includes('ann-draft-notes'));
    });

    await check('every GET route: nothing of Ann\'s reaches anonymous, Bob or a person without a project', async () => {
        const values = (name) => {
            if (name === 'project') return [annProject];
            if (name === 'app') return [annApp.id];
            if (name === 'credential') return [cred ? cred.id : 'cred_x'];
            if (name === 'subject') return [ann.subject];
            if (name === 'id') return [release, annApp.id, annProject];
            return [annProject, annApp.id, release];
        };
        const paths = getPaths(capturedApp, values, {
            query: `project=${annProject}&app=${annApp.id}&release=${release}&q=Ann`,
            extra: [`/api/v1/releases/${release}`, `/api/v1/apps/${annApp.id}/releases`, `/api/v1/apps/${annApp.id}/trust`, `/apps/${annApp.id}/releases`, `/releases/${release}`,
                '/sitemap.xml', '/events', '/updates', '/staff', `/projects/${annProject}/export?format=json`],
        });
        const r = await crawl(t, paths, { anonymous: null, bob, nobody }, () => SECRET);
        console.log(`    (${paths.length} paths × 3 people; answers ${JSON.stringify(r.statuses)})`);
        assert.ok(r.answered >= paths.length * 2);
        assert.deepStrictEqual(r.found, []);
    });

    await check('the events outbox carries nothing of the draft (drafts emit nothing)', async () => {
        const text = JSON.stringify(await t.ctx.store.db.prepare('SELECT envelope FROM event_outbox').all());
        assert.ok(!text.includes('ann-draft-notes') && !text.includes(release));
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
