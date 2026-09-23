'use strict';
/**
 * Project export and delete.
 *   - export: one JSON document, read from Network's /api/v1/projects with the person's token
 *     (project, members, apps with credentials and grants, quotas, audit for admin+) plus Codes'
 *     releases, trust and playground runs; never a secret; any member may export; a Network
 *     failure fails the export instead of returning a partial one
 *   - delete: owner (or staff) only, confirmed by the project name, CSRF-guarded; archives in
 *     Network first and changes nothing in Codes when Network refuses; then deletes drafts (and
 *     their manifests) and playground runs, and revokes public releases with codes.app.revoked
 */
const assert = require('assert');
const manifests = require('../server/domain/manifests');
const { buildExport, FORMAT } = require('../server/domain/project-export');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const db = t.ctx.store.db;
    const owner = t.network.addUser('ona');
    const dev = t.network.addUser('dev');
    const viewer = t.network.addUser('vee');
    const stranger = t.network.addUser('sam');
    const projectId = await t.project(owner, 'Exportable');
    await t.get(`/projects/${projectId}/members`, { as: owner, form: { username: 'dev', role: 'developer' } });
    await t.get(`/projects/${projectId}/members`, { as: owner, form: { username: 'vee', role: 'viewer' } });
    const app = await t.app(owner, projectId, { name: 'Exporter' });
    assert.ok(app.secret, 'a confidential app gets a secret');
    await t.grant(owner, projectId, app.id, 'media.object.upload');
    const manifest = (version) => JSON.stringify({ ...manifests.template('app', { appId: app.id, projectId, environment: 'sandbox', name: 'Exporter' }), version });
    const draft = async (version) => {
        const r = await t.get(`/projects/${projectId}/apps/${app.id}/releases`, { as: owner, form: { kind: 'app', manifest: manifest(version), intent: 'create' } });
        assert.strictEqual(r.status, 303, r.text.slice(0, 300));
        return r.headers.get('location').split('/').pop();
    };
    const published = await draft('1.0.0');
    assert.strictEqual((await t.get(`/releases/${published}/publish`, { as: owner, form: {} })).status, 303);
    const drafted = await draft('1.1.0');
    const draftManifest = db.prepare('SELECT manifest_id FROM releases WHERE id = ?').get(drafted).manifest_id;
    db.prepare(`INSERT INTO playground_runs (id, at, actor, project_id, app_id, kind, capability, credential, outcome, stage, detail)
                VALUES ('run_01JTEST00000000000000000000', ?, ?, ?, ?, 'media', 'media.object.upload', 'client_secret', 'ok', 'done', 'stored 5 bytes')`)
        .run(new Date().toISOString(), `user:${owner.subject}`, projectId, app.id);
    const count = (sql, ...a) => db.prepare(sql).get(...a).n;
    const exportPath = `/projects/${projectId}/export`;

    await check('the owner exports everything Network and Codes hold for the project, as a JSON download', async () => {
        const r = await t.get(exportPath, { as: owner });
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.match(r.headers.get('content-type'), /^application\/json/);
        assert.strictEqual(r.headers.get('content-disposition'), `attachment; filename="openvibe-project-${projectId}.json"`);
        assert.strictEqual(r.headers.get('cache-control'), 'no-store');
        const x = r.json();
        assert.strictEqual(x.format, FORMAT);
        assert.strictEqual(x.format_version, 1);
        assert.strictEqual(x.exported_by, owner.subject);
        assert.strictEqual(x.project.id, projectId);
        assert.deepStrictEqual(x.members.map((m) => m.username).sort(), ['dev', 'ona', 'vee']);
        assert.strictEqual(x.apps.length, 1);
        assert.strictEqual(x.apps[0].id, app.id);
        assert.strictEqual(x.apps[0].credentials.length, 1);
        assert.ok(x.apps[0].credentials[0].hint, 'credentials by id and hint');
        assert.deepStrictEqual(x.apps[0].grants.map((g) => g.capability), ['media.object.upload']);
        assert.ok(Array.isArray(x.quotas));
        assert.ok(Array.isArray(x.audit.entries) && x.audit.entries.length >= 1, 'the owner gets the audit log');
        assert.strictEqual(x.audit.complete, true);
        assert.deepStrictEqual(x.codes.releases.map((rel) => [rel.id, rel.status]), [[published, 'published'], [drafted, 'draft']]);
        assert.strictEqual(x.codes.releases[0].manifest.body.version, '1.0.0');
        assert.deepStrictEqual(x.codes.releases[0].log.map((l) => l.action), ['created', 'published']);
        assert.strictEqual(x.codes.trust[0].app_id, app.id);
        assert.strictEqual(x.codes.trust[0].tier, 'unreviewed');
        assert.strictEqual(x.codes.playground_runs.length, 1);
        assert.strictEqual(x.sources.network.api, '/api/v1/projects');
    });

    await check('the export never contains a secret or a token', async () => {
        const r = await t.get(exportPath, { as: owner });
        assert.ok(!r.text.includes(app.secret), 'the client secret');
        assert.ok(!/ovsec_/.test(r.text));
        assert.ok(!r.text.includes(t.network.userToken(owner).split('.')[2]));
    });

    await check('a viewer may export; the audit log (admin+ in Network) is left out and the document says so', async () => {
        const r = await t.get(exportPath, { as: viewer });
        assert.strictEqual(r.status, 200);
        const x = r.json();
        assert.strictEqual(x.audit.entries, null);
        assert.match(x.audit.note, /admin role/);
        assert.strictEqual(x.apps.length, 1);
        const pageText = (await t.get(`/projects/${projectId}`, { as: viewer })).text;
        assert.match(pageText, /Download export \(JSON\)/);
        assert.ok(!pageText.includes(`action="/projects/${projectId}/delete"`), 'no delete form for a viewer');
    });

    await check('a non-member gets Network\'s answer, not a document; anonymous must sign in', async () => {
        const r = await t.get(exportPath, { as: stranger });
        assert.strictEqual(r.status, 404);
        assert.match(r.text, /project\.not_found/);
        assert.ok(!r.headers.get('content-disposition'));
        assert.strictEqual((await t.get(exportPath)).status, 401);
    });

    await check('when Network fails part-way the export fails; it is never partial', async () => {
        const orig = t.ctx.network.projects.quotas;
        t.ctx.network.projects.quotas = async () => { throw Object.assign(new Error('x'), { status: 503 }); };
        try {
            const r = await t.get(exportPath, { as: owner });
            assert.notStrictEqual(r.status, 200);
            assert.ok(!r.headers.get('content-disposition'));
        } finally { t.ctx.network.projects.quotas = orig; }
    });

    const unchanged = () => {
        assert.strictEqual(t.network.state.projects.get(projectId).archived_at, null, 'not archived in Network');
        assert.strictEqual(count('SELECT COUNT(*) AS n FROM releases WHERE project_id = ?', projectId), 2);
        assert.strictEqual(count("SELECT COUNT(*) AS n FROM releases WHERE status = 'published' AND id = ?", published), 1);
        assert.strictEqual(count('SELECT COUNT(*) AS n FROM playground_runs WHERE project_id = ?', projectId), 1);
    };
    const del = `/projects/${projectId}/delete`;

    await check('delete: a developer is refused and nothing changes', async () => {
        const r = await t.get(del, { as: dev, form: { confirm_name: 'Exportable' } });
        assert.strictEqual(r.status, 403);
        assert.match(r.text, /only the project owner/);
        unchanged();
    });

    await check('delete: the wrong name, or no form token, changes nothing and calls no Network write', async () => {
        const before = t.network.requests.filter((q) => q.method === 'POST').length;
        const wrong = await t.get(del, { as: owner, form: { confirm_name: 'exportable' } });
        assert.strictEqual(wrong.status, 422);
        assert.match(wrong.text, /type the project name exactly/);
        const noCsrf = await t.get(del, { as: owner, form: { confirm_name: 'Exportable', csrf: 'forged' } });
        assert.strictEqual(noCsrf.status, 403);
        assert.strictEqual(t.network.requests.filter((q) => q.method === 'POST').length, before);
        unchanged();
    });

    await check('delete: when Network refuses to archive, Codes keeps everything', async () => {
        const orig = t.ctx.network.projects.archive;
        t.ctx.network.projects.archive = async () => { throw Object.assign(new Error('x'), { status: 503 }); };
        try {
            const r = await t.get(del, { as: owner, form: { confirm_name: 'Exportable' } });
            assert.notStrictEqual(r.status, 303);
        } finally { t.ctx.network.projects.archive = orig; }
        unchanged();
    });

    await check('delete by the owner: archived in Network, drafts and runs removed, public releases revoked with an event', async () => {
        const page = await t.get(`/projects/${projectId}`, { as: owner });
        assert.match(page.text, /Type the project name/);
        const r = await t.get(del, { as: owner, form: { confirm_name: 'Exportable' } });
        assert.strictEqual(r.status, 303, r.text.slice(0, 300));
        assert.match(decodeURIComponent(r.headers.get('location')), /Deleted: 1 revoked, 1 drafts and 1 runs removed/);
        const p = t.network.state.projects.get(projectId);
        assert.ok(p.archived_at, 'archived in Network');
        assert.ok(t.network.state.apps.get(app.id).revoked_at, 'Network revoked the app');
        assert.strictEqual(count('SELECT COUNT(*) AS n FROM releases WHERE id = ?', drafted), 0, 'draft deleted');
        assert.strictEqual(count('SELECT COUNT(*) AS n FROM manifests WHERE id = ?', draftManifest), 0, 'its manifest deleted');
        assert.strictEqual(db.prepare('SELECT status, revocation_reason FROM releases WHERE id = ?').get(published).status, 'revoked');
        assert.strictEqual(count('SELECT COUNT(*) AS n FROM playground_runs WHERE project_id = ?', projectId), 0);
        const ev = db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all().map((x) => JSON.parse(x.envelope));
        const revoked = ev.filter((e) => e.event_type === 'codes.app.revoked');
        assert.strictEqual(revoked.length, 1);
        assert.strictEqual(revoked[0].payload.release_id, published);
        assert.deepStrictEqual(db.prepare('SELECT action FROM release_log WHERE release_id = ? ORDER BY id').all(drafted).map((l) => l.action), ['created', 'deleted'], 'the append-only log records the deletion');
        // The public release page now says revoked.
        assert.match((await t.get(`/releases/${published}`)).text, /revoked/i);
    });

    await check('after delete: the export still works (archived) and deleting again is harmless', async () => {
        const x = (await t.get(exportPath, { as: owner })).json();
        assert.ok(x.project.archived_at);
        assert.deepStrictEqual(x.codes.releases.map((rel) => [rel.id, rel.status]), [[published, 'revoked']]);
        assert.deepStrictEqual(x.codes.playground_runs, []);
        const again = await t.get(del, { as: owner, form: { confirm_name: 'Exportable' } });
        assert.strictEqual(again.status, 303);
        assert.match(decodeURIComponent(again.headers.get('location')), /Deleted: 0 revoked, 0 drafts and 0 runs removed/);
    });

    await check('buildExport pages through Network\'s audit log and marks a very long one incomplete', async () => {
        const fake = (pages) => {
            let calls = 0;
            const P = {
                members: async () => ({ members: [] }), apps: async () => ({ apps: [] }), quotas: async () => ({ quotas: [] }),
                audit: async (_t, _p, { before, limit }) => {
                    calls++;
                    assert.strictEqual(limit, 200);
                    const n = before ? Number(before) : pages;
                    return { entries: [{ id: n }], next_before: n > 1 ? n - 1 : null };
                },
            };
            return { network: { projects: P }, calls: () => calls };
        };
        const deps = { releases: { listForProject: () => [] }, playground: { runsForProject: () => [] }, trust: { get: () => ({}), history: () => [] }, meta: {} };
        const three = fake(3);
        const a = await buildExport({ ...deps, network: three.network, token: 't', project: { id: 'prj_x' }, includeAudit: true });
        assert.deepStrictEqual(a.audit.entries.map((e) => e.id), [3, 2, 1]);
        assert.strictEqual(a.audit.complete, true);
        const many = fake(1000);
        const b = await buildExport({ ...deps, network: many.network, token: 't', project: { id: 'prj_x' }, includeAudit: true });
        assert.strictEqual(many.calls(), 50);
        assert.strictEqual(b.audit.complete, false);
    });

    await t.close();
    done();
})();
