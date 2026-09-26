'use strict';
/**
 * The full project archive (roadmap WS-N task 9; server/domain/project-archive.js):
 *   - owner and admins only (developers, viewers, non-members, forged forms get nothing, and no
 *     export token is minted for them); Network mints one read-only export token per service and
 *     environment with the person's own token, and Media and Events are read only with those
 *   - one zip: manifest.json, README.txt, project.json (the metadata document with the audit log),
 *     modules/<release>.json, media/<env>/(namespaces.json|objects.jsonl), events/<env>.jsonl, for
 *     both environments; every object (deleted and uploading ones too) with a public or signed URL
 *     or none; every retained app event of the project, paged; nothing of another project
 *   - never a secret or a token in the archive, Codes' database or its logs
 *   - a failing service fails the whole export (never a partial zip); a limit makes the part and
 *     the archive say complete: false and where they stopped
 */
const assert = require('assert');
const crypto = require('crypto');
const manifests = require('../server/domain/manifests');
const { FORMAT } = require('../server/domain/project-archive');
const { unzip } = require('./helpers/unzip');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const owner = t.network.addUser('ona');
    const admin = t.network.addUser('ada');
    const dev = t.network.addUser('dev');
    const viewer = t.network.addUser('vee');
    const stranger = t.network.addUser('sam');
    const staff = t.network.addUser('staffer', { role: 'admin' });
    const projectId = await t.project(owner, 'Archived things');
    t.network.setEnvironmentPolicy(projectId, 'sandbox+production');
    for (const [u, role] of [['ada', 'admin'], ['dev', 'developer'], ['vee', 'viewer']]) {
        assert.strictEqual((await t.get(`/projects/${projectId}/members`, { as: owner, form: { username: u, role } })).status, 303);
    }
    const app = await t.app(owner, projectId, { name: 'Shop' });
    assert.ok(app.secret);
    const manifest = JSON.stringify({ ...manifests.template('app', { appId: app.id, projectId, environment: 'sandbox', name: 'Shop' }), version: '1.2.3' });
    let r = await t.get(`/projects/${projectId}/apps/${app.id}/releases`, { as: owner, form: { kind: 'app', manifest, intent: 'create' } });
    assert.strictEqual(r.status, 303, r.text.slice(0, 300));
    const releaseId = r.headers.get('location').split('/').pop();
    assert.strictEqual((await t.get(`/releases/${releaseId}/publish`, { as: owner, form: {} })).status, 303);

    // What the services hold: this project's objects and events in both environments, and another project's.
    const otherProject = await t.project(stranger, 'Not mine');
    const O = {
        pub: [0, 1, 2].map(() => t.media.addObject(projectId, 'production', { visibility: 'public' })),
        priv: [0, 1].map(() => t.media.addObject(projectId, 'production', { visibility: 'private', size: 2048 })),
        uploading: t.media.addObject(projectId, 'production', { status: 'uploading' }),
        deleted: t.media.addObject(projectId, 'production', { status: 'deleted' }),
        sandbox: [0, 1, 2].map(() => t.media.addObject(projectId, 'sandbox', { visibility: 'public' })),
        other: t.media.addObject(otherProject, 'production', { visibility: 'public' }),
    };
    const E = { production: [], sandbox: [], other: [] };
    for (let i = 0; i < 1203; i++) {
        E.production.push(t.events.addAppEvent(projectId, 'production', 'order.created', { n: i }));
        if (i % 400 === 0) E.sandbox.push(t.events.addAppEvent(projectId, 'sandbox', 'order.tested', { n: i }));
        if (i % 300 === 0) E.other.push(t.events.addAppEvent(otherProject, 'production', 'order.created', { n: i }));
    }

    const archivePath = `/projects/${projectId}/export/archive`;
    const exportAs = (who, form = {}) => t.get(archivePath, { as: who, form });
    const minted = () => t.network.state.exportTokens;
    const lines = (buf) => buf.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    let files = null;

    await check('the owner downloads one zip with every part, for both environments', async () => {
        r = await exportAs(owner);
        assert.strictEqual(r.status, 200, r.text.slice(0, 500));
        assert.strictEqual(r.headers.get('content-type'), 'application/zip');
        assert.match(r.headers.get('content-disposition'), new RegExp(`^attachment; filename="openvibe-project-${projectId}-\\d{4}-\\d{2}-\\d{2}\\.zip"$`));
        assert.strictEqual(r.headers.get('cache-control'), 'no-store');
        files = unzip(r.buffer);
        assert.deepStrictEqual([...files.keys()], [
            'manifest.json', 'README.txt', 'project.json', `modules/${releaseId}.json`,
            'media/production/namespaces.json', 'media/production/objects.jsonl', 'events/production.jsonl',
            'media/sandbox/namespaces.json', 'media/sandbox/objects.jsonl', 'events/sandbox.jsonl',
        ]);
        const m = JSON.parse(files.get('manifest.json'));
        assert.strictEqual(m.format, FORMAT);
        assert.strictEqual(m.format_version, 1);
        assert.strictEqual(m.exported_by, owner.subject);
        assert.deepStrictEqual(m.project, { id: projectId, name: 'Archived things', archived_at: null });
        assert.strictEqual(m.complete, true);
        assert.deepStrictEqual([m.parts.media.production.objects.count, m.parts.media.sandbox.objects.count, m.parts.events.production.count, m.parts.events.sandbox.count], [7, 3, 1203, E.sandbox.length]);
        assert.deepStrictEqual(m.parts.media.production.objects.downloads, { public: 3, signed: 2, none: 2 });
        assert.deepStrictEqual(m.parts.media.sandbox.objects.downloads, { public: 0, signed: 3, none: 0 });
        assert.deepStrictEqual(m.parts.modules.files.map((x) => [x.release_id, x.kind, x.version, x.status, x.schema]), [[releaseId, 'app', '1.2.3', 'published', 'codes.app-manifest@1']]);
        assert.ok(m.not_included.some((x) => /Tools job results/.test(x.what)) && m.not_included.some((x) => /user modules/.test(x.what)));
        for (const f of m.files) {
            assert.strictEqual(files.get(f.path).length, f.bytes, f.path);
            assert.strictEqual(crypto.createHash('sha256').update(files.get(f.path)).digest('hex'), f.sha256, f.path);
        }
        assert.match(files.get('README.txt').toString(), /Complete: every part/);
    });

    await check('project.json is the metadata document with the audit log; modules are the manifests as validated', async () => {
        const x = JSON.parse(files.get('project.json'));
        assert.strictEqual(x.format, 'openvibe.codes.project-export');
        assert.strictEqual(x.project.id, projectId);
        assert.deepStrictEqual(x.members.map((mm) => mm.username).sort(), ['ada', 'dev', 'ona', 'vee']);
        assert.ok(Array.isArray(x.audit.entries) && x.audit.entries.some((e) => e.action === 'app.created'), 'the audit log (admin+)');
        assert.deepStrictEqual(x.codes.releases.map((rel) => rel.id), [releaseId]);
        assert.deepStrictEqual(JSON.parse(files.get(`modules/${releaseId}.json`)), JSON.parse(manifest));
    });

    await check('objects: all of this project\'s, per environment, each with a public URL, a signed one or none', async () => {
        const prod = lines(files.get('media/production/objects.jsonl'));
        const sbx = lines(files.get('media/sandbox/objects.jsonl'));
        const ids = (list) => list.map((o) => o.id).sort();
        assert.deepStrictEqual(ids(prod), [...O.pub, ...O.priv, O.uploading, O.deleted].map((o) => o.id).sort(), 'deleted and uploading objects are listed too');
        assert.deepStrictEqual(ids(sbx), O.sandbox.map((o) => o.id).sort());
        assert.ok(![...prod, ...sbx].some((o) => o.id === O.other.id), 'nothing of another project');
        const byId = new Map(prod.map((o) => [o.id, o]));
        for (const o of O.pub) assert.deepStrictEqual(byId.get(o.id).download, { url: o.public_url, expires_at: null, public: true });
        for (const o of [...O.priv.map((x) => byId.get(x.id)), ...sbx]) {
            assert.strictEqual(o.download.public, false);
            assert.match(o.download.url, new RegExp(`/o/${o.id}\\?exp=\\d+&sig=`));
            const left = Date.parse(o.download.expires_at) - Date.now();
            assert.ok(left > 55 * 60 * 1000 && left <= 3600 * 1000, 'signed for an hour');
        }
        assert.strictEqual(byId.get(O.uploading.id).download, null);
        assert.strictEqual(byId.get(O.deleted.id).download, null);
        assert.strictEqual(byId.get(O.priv[0].id).size_bytes, 2048, 'Media\'s metadata as it answered');
        const ns = JSON.parse(files.get('media/sandbox/namespaces.json'));
        assert.deepStrictEqual(ns.namespaces.map((n) => n.namespace), [`app.${projectId}.sandbox`]);
    });

    await check('events: every retained app event of the project, per environment, paged in order', async () => {
        const prod = lines(files.get('events/production.jsonl'));
        const sbx = lines(files.get('events/sandbox.jsonl'));
        assert.deepStrictEqual(prod.map((e) => e.seq), E.production.map((e) => e.seq), 'all 1,203, across two pages');
        assert.deepStrictEqual(sbx.map((e) => e.event.event_id), E.sandbox.map((e) => e.event.event_id));
        assert.deepStrictEqual(prod[5].event, E.production[5].event, 'the envelope as Events keeps it');
        const pulls = t.events.requests.filter((q) => q.method === 'GET' && q.path.startsWith('/api/v1/events'));
        assert.ok(pulls.length >= 3, 'production took more than one page');
    });

    await check('Network minted the tokens for the owner, one per service and environment; Media and Events saw only those', async () => {
        const mine = minted().filter((x) => x.subject === owner.subject);
        assert.deepStrictEqual(mine.map((x) => `${x.audience} ${x.env}`).sort(), ['openvibe.events production', 'openvibe.events sandbox', 'openvibe.media production', 'openvibe.media sandbox']);
        const tokens = new Set(minted().map((x) => `Bearer ${x.token}`));
        const reads = [...t.media.requests, ...t.events.requests].filter((q) => q.method === 'GET');
        assert.ok(reads.length > 10);
        assert.ok(reads.every((q) => tokens.has(q.auth)), 'every read carried an export token, never the person\'s own');
        const mintCalls = t.network.requests.filter((q) => q.path.endsWith('/export-tokens'));
        assert.strictEqual(mintCalls.length, 4);
        const claimsOf = (h) => JSON.parse(Buffer.from(String(h).split('.')[1], 'base64url').toString('utf8'));
        assert.ok(mintCalls.every((q) => claimsOf(q.headers.authorization).sub === owner.id && !claimsOf(q.headers.authorization).actor_type), 'asked with the person\'s own Network token');
    });

    await check('no secret and no token in the archive, in Codes\' database or in its logs', async () => {
        const everything = [...files.values()].map((b) => b.toString('utf8')).join('\n');
        assert.ok(!everything.includes(app.secret), 'the client secret');
        assert.ok(!/ovsec_/.test(everything));
        assert.ok(!everything.includes(t.network.userToken(owner).split('.')[2]), 'the person\'s token');
        for (const x of minted()) {
            const sig = x.token.split('.')[2];
            assert.ok(!everything.includes(sig), 'an export token in the archive');
            assert.ok(!t.dbDump().includes(sig), 'an export token in Codes\' database');
            assert.ok(!t.logs().includes(sig), 'an export token in the logs');
        }
        assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(everything), 'no JWT at all');
        assert.match(t.logs(), new RegExp(`project ${projectId} archive exported by user:${owner.subject}: 10 objects, ${1203 + E.sandbox.length} events, 1 modules`));
    });

    await check('an admin may download it; the project page offers it to owner and admins only', async () => {
        r = await exportAs(admin);
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.ok(minted().some((x) => x.subject === admin.subject));
        assert.match((await t.get(`/projects/${projectId}`, { as: admin })).text, /Download full archive \(zip\)/);
        const devPage = (await t.get(`/projects/${projectId}`, { as: dev })).text;
        assert.ok(!devPage.includes(`action="${archivePath}"`));
        assert.match(devPage, /for the project's owner and admins/);
        assert.match(devPage, /Download export \(JSON\)/, 'the metadata export stays for every member');
    });

    await check('developers, viewers, staff outside the project, strangers, forged forms and anonymous visitors get nothing, and nothing is minted', async () => {
        const before = minted().length;
        const readsBefore = t.media.requests.length + t.events.requests.length;
        for (const who of [dev, viewer, staff]) {
            r = await exportAs(who);
            assert.strictEqual(r.status, 403, who.username);
            assert.ok(!r.headers.get('content-disposition'));
        }
        r = await exportAs(stranger);
        assert.strictEqual(r.status, 404);
        assert.match(r.text, /project\.not_found/);
        r = await exportAs(owner, { csrf: 'forged' });
        assert.strictEqual(r.status, 403);
        assert.strictEqual((await t.get(archivePath, { method: 'POST', form: {} })).status, 401);
        assert.strictEqual((await t.get(archivePath, { as: owner })).status, 404, 'no GET: it is a form');
        assert.strictEqual(minted().length, before);
        assert.strictEqual(t.media.requests.length + t.events.requests.length, readsBefore);
    });

    const failsWhole = async (label, arrange, pattern) => {
        arrange();
        try {
            r = await exportAs(owner);
            assert.strictEqual(r.status, 502, `${label}: ${r.status} ${r.text.slice(0, 200)}`);
            assert.ok(!r.headers.get('content-disposition'), `${label}: no download`);
            assert.match(r.headers.get('content-type'), /text\/html/);
            assert.match(r.text, pattern, label);
            assert.match(r.text, /Nothing was exported/);
        } finally { t.media.clear(); t.events.clear(); }
    };

    await check('a failing service fails the whole export: nothing is downloaded, the page names the service, part and environment', async () => {
        await failsWhole('Media listing', () => t.media.fail(/\/objects\?/, 503), /OpenVibe\.Media answered 503[^]*objects \(production\)/);
        await failsWhole('one signed URL', () => t.media.fail(new RegExp(`/objects/${O.sandbox[1].id}/download`), 500, 'media.internal'), /OpenVibe\.Media answered 500 \(media\.internal\)[^]*download URLs \(sandbox\)/);
        await failsWhole('Events refusing', () => t.events.fail(/\/api\/v1\/events\?/, 403, 'capability.denied'), /OpenVibe\.Events answered 403 \(capability\.denied\)[^]*events \(production\)/);
        await failsWhole('Events unreachable', () => { t.ctx.config.export.eventsUrl = 'http://127.0.0.1:9'; }, /OpenVibe\.Events did not answer[^]*events \(production\)/);
        t.ctx.config.export.eventsUrl = t.events.url;
    });

    await check('when Network refuses the export token, its answer is shown and no service is called', async () => {
        const orig = t.ctx.network.projects.exportToken;
        t.ctx.network.projects.exportToken = async () => { throw Object.assign(new (require('openvibe-sdk/core').OpenVibeError)({ status: 403, code: 'project.forbidden', message: 'requires admin role' })); };
        const readsBefore = t.media.requests.length;
        try {
            r = await exportAs(owner);
            assert.strictEqual(r.status, 403, r.text.slice(0, 300));
            assert.match(r.text, /project\.forbidden/);
            assert.ok(!r.headers.get('content-disposition'));
            assert.strictEqual(t.media.requests.length, readsBefore);
        } finally { t.ctx.network.projects.exportToken = orig; }
    });

    await check('limits: a part that reaches one says complete: false and where it stopped; so does the archive', async () => {
        const x = t.ctx.config.export;
        const saved = { ...x };
        x.maxObjects = 4;
        x.maxEvents = 1000;
        try {
            r = await exportAs(owner);
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            const z = unzip(r.buffer);
            const m = JSON.parse(z.get('manifest.json'));
            assert.strictEqual(m.complete, false);
            const o = m.parts.media.production.objects;
            assert.deepStrictEqual([o.count, o.complete, o.limit], [4, false, 4]);
            const listed = lines(z.get('media/production/objects.jsonl'));
            assert.strictEqual(listed.length, 4);
            assert.strictEqual(o.next_cursor, listed[3].id, 'continue from the last one listed');
            assert.strictEqual(m.parts.media.sandbox.objects.complete, true, 'the sandbox has 3: under the limit');
            const ev = m.parts.events.production;
            assert.deepStrictEqual([ev.count, ev.complete, ev.next_after_seq], [1000, false, E.production[999].seq]);
            assert.strictEqual(lines(z.get('events/production.jsonl')).length, 1000);
            assert.strictEqual(m.parts.events.sandbox.complete, true);
            assert.match(z.get('README.txt').toString(), /NOT COMPLETE/);
        } finally { Object.assign(x, saved); }
    });

    await check('a long export asks Network again before a token expires', async () => {
        t.network.state.exportTtl = 30;   // under the one-minute margin: every read gets a fresh token
        const before = minted().length;
        try {
            r = await exportAs(owner);
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.ok(minted().length - before > 10, `re-minted (${minted().length - before})`);
        } finally { t.network.state.exportTtl = 300; }
    });

    await check('an archived project can still be exported by its owner', async () => {
        assert.strictEqual((await t.get(`/projects/${projectId}/archive`, { as: owner, form: { confirm: '1' } })).status, 303);
        r = await exportAs(owner);
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.ok(JSON.parse(unzip(r.buffer).get('manifest.json')).project.archived_at);
    });

    await check('the docs describe the archive', async () => {
        r = await t.get('/docs/export');
        assert.strictEqual(r.status, 200);
        for (const s of ['manifest.json', 'objects.jsonl', 'events/&lt;env&gt;.jsonl', 'modules/&lt;release_id&gt;.json', 'All or nothing', 'Not included']) assert.ok(r.text.includes(s), s);
        assert.match((await t.get('/docs')).text, /href="\/docs\/export"/);
    });

    await t.close();
    done();
})();
