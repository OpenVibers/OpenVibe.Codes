'use strict';

/**
 * Release metadata — Codes-owned records keyed to Network app ids.
 *
 *   draft → published → deprecated → revoked       (revoked is terminal; a draft can be revoked too)
 *
 * Who may act is decided from the Network's answer about the actor (their project role and the
 * app's environment), mirroring Network's own rule: developer+ for sandbox apps, admin+ for
 * production apps; Codes staff may revoke any release. An app acting with its own token (API,
 * codes.release.manage) may manage only its own releases.
 *
 * A release carries its validated manifest, its compatibility ranges and — when shown — the app's
 * current trust tier, which is metadata only: it never grants or bypasses anything.
 */
const { validate: validateManifest } = require('./manifests');

const RANK = { viewer: 1, developer: 2, admin: 3, owner: 4 };
const contractsVersion = require('openvibe-contracts/package.json').version;

class ReleaseError extends Error {
    constructor(status, code, detail, extra = {}) { super(detail || code); this.status = status; this.code = code; this.detail = detail; Object.assign(this, extra); }
}
const fail = (status, code, detail, extra) => { throw new ReleaseError(status, code, detail, extra); };

/** Role needed to manage releases of an app in this environment (Network's rule for apps). */
const manageRole = (environment) => (environment === 'production' ? 'admin' : 'developer');

function createReleases({ store, outbox, trust }) {
    const { db } = store;

    function view(r) {
        if (!r) return null;
        return {
            id: r.id, app_id: r.app_id, project_id: r.project_id, environment: r.environment, kind: r.kind,
            subject_id: r.subject_id, name: r.name, version: r.version, status: r.status, manifest_id: r.manifest_id,
            compatibility: JSON.parse(r.compatibility || '{}'), notes: r.notes,
            created_at: r.created_at, created_by: r.created_by,
            published_at: r.published_at || null, deprecated_at: r.deprecated_at || null, deprecation_reason: r.deprecation_reason || null,
            replacement: r.replacement || null, revoked_at: r.revoked_at || null, revocation_reason: r.revocation_reason || null,
            trust: trust.get(r.app_id),
        };
    }

    const get = (id) => view(db.prepare('SELECT * FROM releases WHERE id = ?').get(String(id)));
    const manifestOf = (id) => {
        const m = db.prepare('SELECT * FROM manifests WHERE id = ?').get(String(id));
        return m ? { id: m.id, kind: m.kind, body: JSON.parse(m.body), contracts_version: m.contracts_version, created_at: m.created_at } : null;
    };
    const listForApp = (appId, { includeDrafts = false } = {}) => db.prepare(
        `SELECT * FROM releases WHERE app_id = ? ${includeDrafts ? '' : "AND status != 'draft'"} ORDER BY created_at DESC, id DESC`,
    ).all(String(appId)).map(view);
    const recentPublic = (limit = 20) => db.prepare("SELECT * FROM releases WHERE status IN ('published', 'deprecated') ORDER BY published_at DESC LIMIT ?").all(limit).map(view);
    const log = (releaseId) => db.prepare('SELECT action, actor, at, detail FROM release_log WHERE release_id = ? ORDER BY id').all(releaseId)
        .map((l) => ({ ...l, detail: JSON.parse(l.detail || '{}') }));

    function writeLog(releaseId, action, actor, detail = {}) {
        db.prepare('INSERT INTO release_log (release_id, action, actor, at, detail) VALUES (?, ?, ?, ?, ?)')
            .run(releaseId, action, actor, store.iso(), JSON.stringify(detail));
    }

    /**
     * actor: { label: 'user:usr_…' | 'app:app_…', subject, kind: 'user' | 'app', role?, staff? }
     *   role is the person's project role as Network reported it; apps act on themselves only.
     */
    function assertCanManage(actor, app, { revoke = false } = {}) {
        if (actor.kind === 'app') {
            if (actor.subject !== app.id) fail(403, 'release.forbidden', 'an app manages only its own releases');
            return;
        }
        if (revoke && actor.staff) return;
        const need = manageRole(app.environment);
        if (!actor.role || RANK[actor.role] < RANK[need]) fail(403, 'release.forbidden', `managing ${app.environment} releases needs the ${need} role in the project (Network reports ${actor.role || 'no role'})`);
    }

    function event(type, rel, actor, extra = {}) {
        const [atype, aid] = actor.label.split(':');
        return outbox.emit({
            event_type: type,
            actor: { type: atype === 'app' ? 'app' : 'user', id: aid },
            subject: { type: 'app', id: rel.app_id },
            visibility: 'public',
            payload: {
                project_id: rel.project_id, release_id: rel.id, kind: rel.kind, subject_id: rel.subject_id, version: rel.version,
                environment: rel.environment, trust_tier: trust.get(rel.app_id).tier, ...extra,
            },
        }, { traceparent: actor.traceparent });
    }

    /**
     * Create a draft from a manifest. app: { id, project_id, environment, grants, revoked_at } as
     * Network reported it (or, for an app token, as its claims say).
     */
    function createDraft({ actor, app, kind, manifest, notes = '', eventTypes }) {
        if (app.revoked_at) fail(409, 'release.app_revoked', 'the app is revoked in Network');
        assertCanManage(actor, app);
        const result = validateManifest(kind, manifest, { app, viewerSubject: actor.kind === 'user' ? actor.subject : null, eventTypes });
        if (!result.valid) fail(422, 'manifest.invalid', 'the manifest does not validate', { validation: result });
        const subjectId = manifest.id;
        const exists = db.prepare('SELECT id FROM releases WHERE app_id = ? AND kind = ? AND subject_id = ? AND version = ?').get(app.id, kind, subjectId, manifest.version);
        if (exists) fail(409, 'release.exists', `version ${manifest.version} of ${subjectId} already has a release (${exists.id}); versions are immutable`);
        const cleanNotes = String(notes || '').slice(0, 2000);
        const manifestId = store.newId('mfs');
        const releaseId = store.newId('rel');
        const t = store.iso();
        db.transaction(() => {
            db.prepare(`INSERT INTO manifests (id, kind, app_id, project_id, subject_id, version, body, contracts_version, created_by, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(manifestId, kind, app.id, app.project_id, subjectId, manifest.version, JSON.stringify(manifest), contractsVersion, actor.label, t);
            db.prepare(`INSERT INTO releases (id, app_id, project_id, environment, kind, subject_id, name, version, manifest_id, status, compatibility, notes, created_by, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`)
                .run(releaseId, app.id, app.project_id, app.environment, kind, subjectId, String(manifest.name).slice(0, 80), manifest.version, manifestId,
                    JSON.stringify(manifest.compatibility || {}), cleanNotes, actor.label, t);
            writeLog(releaseId, 'created', actor.label, { version: manifest.version, kind, warnings: result.warnings.length });
        })();
        return { release: get(releaseId), validation: result };
    }

    function load(id) {
        const r = db.prepare('SELECT * FROM releases WHERE id = ?').get(String(id));
        if (!r) fail(404, 'release.not_found', 'no such release');
        return r;
    }

    function publish({ actor, releaseId, app }) {
        const r = load(releaseId);
        if (app.id !== r.app_id) fail(404, 'release.not_found', 'no such release');
        if (app.revoked_at) fail(409, 'release.app_revoked', 'the app is revoked in Network');
        assertCanManage(actor, { ...app, environment: r.environment });
        if (r.status !== 'draft') fail(409, 'release.not_draft', `release is ${r.status}`);
        let env;
        db.transaction(() => {
            db.prepare("UPDATE releases SET status = 'published', published_by = ?, published_at = ? WHERE id = ? AND status = 'draft'").run(actor.label, store.iso(), r.id);
            writeLog(r.id, 'published', actor.label);
            env = event('codes.app.published', r, actor, { compatibility: JSON.parse(r.compatibility || '{}') });
        })();
        return { release: get(r.id), event_id: env.event_id };
    }

    function deprecate({ actor, releaseId, app, reason, replacement }) {
        const r = load(releaseId);
        if (app.id !== r.app_id) fail(404, 'release.not_found', 'no such release');
        assertCanManage(actor, { ...app, environment: r.environment });
        if (r.status !== 'published') fail(409, 'release.not_published', `release is ${r.status}`);
        const why = String(reason || '').trim().slice(0, 500);
        if (!why) fail(422, 'release.invalid', 'say why the release is deprecated');
        let repl = null;
        if (replacement) {
            const rr = db.prepare('SELECT id, app_id, status FROM releases WHERE id = ?').get(String(replacement));
            if (!rr || rr.app_id !== r.app_id || rr.status !== 'published') fail(422, 'release.invalid', 'the replacement must be a published release of the same app');
            repl = rr.id;
        }
        let env;
        db.transaction(() => {
            db.prepare("UPDATE releases SET status = 'deprecated', deprecated_by = ?, deprecated_at = ?, deprecation_reason = ?, replacement = ? WHERE id = ?")
                .run(actor.label, store.iso(), why, repl, r.id);
            writeLog(r.id, 'deprecated', actor.label, { reason: why, replacement: repl });
            env = event('codes.app.deprecated', r, actor, { reason: why, replacement: repl });
        })();
        return { release: get(r.id), event_id: env.event_id };
    }

    function revoke({ actor, releaseId, app, reason }) {
        const r = load(releaseId);
        if (app && app.id !== r.app_id) fail(404, 'release.not_found', 'no such release');
        assertCanManage(actor, { ...(app || { id: r.app_id }), environment: r.environment }, { revoke: true });
        if (r.status === 'revoked') fail(409, 'release.revoked', 'release is already revoked');
        const why = String(reason || '').trim().slice(0, 500);
        if (!why) fail(422, 'release.invalid', 'say why the release is revoked');
        const wasPublic = r.status === 'published' || r.status === 'deprecated';
        // Staff revoking a release their own project role would not let them manage is moderation
        // (ADR-022): it goes to Network's audit log too. A member revoking their own release is not.
        const byStaff = actor.kind === 'user' && actor.staff && !(actor.role && RANK[actor.role] >= RANK[manageRole(r.environment)]);
        let env = null;
        db.transaction(() => {
            db.prepare("UPDATE releases SET status = 'revoked', revoked_by = ?, revoked_at = ?, revocation_reason = ? WHERE id = ?").run(actor.label, store.iso(), why, r.id);
            writeLog(r.id, 'revoked', actor.label, { reason: why, was: r.status });
            // A draft was never public: nobody downstream knows it, so there is nothing to announce.
            if (wasPublic) env = event('codes.app.revoked', r, actor, { reason: why });
            if (byStaff) {
                const [ckind, cid] = String(r.created_by).split(':');
                outbox.moderationAction({
                    action: 'release.revoked', target: { type: 'release', id: r.id, owner_subject: ckind === 'user' ? cid : null },
                    actorSubject: actor.subject, reason: why, details: { app_id: r.app_id, project_id: r.project_id, version: r.version, was: r.status },
                }, { traceparent: actor.traceparent });
            }
        })();
        return { release: get(r.id), event_id: env ? env.event_id : null };
    }

    /** Every release of a project (drafts included), each with its manifest and log: for the project export. */
    const listForProject = (projectId) => db.prepare('SELECT * FROM releases WHERE project_id = ? ORDER BY created_at, id').all(String(projectId))
        .map((r) => ({ ...view(r), manifest: manifestOf(r.manifest_id), log: log(r.id) }));

    /**
     * Codes' part of deleting a project (Network archives the project itself). Drafts were never
     * public, so they and their manifests are deleted (the append-only log records it). Published
     * and deprecated releases are revoked, not erased: people who installed them need the
     * revocation (compatibility policy), so each emits codes.app.revoked as any revocation does.
     * The caller has checked that the actor owns the project (or is staff).
     */
    function retireProject({ actor, projectId, reason = actor.staff && actor.role !== 'owner' ? 'project deleted by OpenVibe staff' : 'project deleted by its owner' }) {
        const rows = db.prepare("SELECT * FROM releases WHERE project_id = ? AND status != 'revoked' ORDER BY created_at, id").all(String(projectId));
        const out = { revoked: [], deletedDrafts: [] };
        for (const r of rows.filter((x) => x.status !== 'draft')) {
            revoke({ actor, releaseId: r.id, app: null, reason });
            out.revoked.push(r.id);
        }
        db.transaction(() => {
            for (const r of rows.filter((x) => x.status === 'draft')) {
                db.prepare("DELETE FROM releases WHERE id = ? AND status = 'draft'").run(r.id);
                const shared = db.prepare('SELECT COUNT(*) AS n FROM releases WHERE manifest_id = ?').get(r.manifest_id).n;
                if (!shared) db.prepare('DELETE FROM manifests WHERE id = ?').run(r.manifest_id);
                writeLog(r.id, 'deleted', actor.label, { reason, was: 'draft' });
                out.deletedDrafts.push(r.id);
            }
        })();
        return out;
    }

    return { get, manifestOf, listForApp, listForProject, recentPublic, log, createDraft, publish, deprecate, revoke, retireProject, manageRole };
}

module.exports = { createReleases, ReleaseError, manageRole, RANK };
