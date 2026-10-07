'use strict';
/**
 * Codes' authority resource index (ADR-048 section 3; capability codes.resource.read):
 *
 *   GET /api/v1/resources[?project=&kind=&cursor=&limit=]  → common.resource-list-result@1
 *   GET /api/v1/resources/:ovrn                            → common.resource-summary@1
 *
 * It pages the resources OpenVibe.Codes owns — its validated app and mod manifests (codes.manifest, mfs_)
 * and its releases (codes.release, rel_) — as common.resource-summary@1, the shape OpenVibe.Services fans
 * out over and merges (openvibe-sdk/resources' createResourceIndex). Trust tiers are per-app metadata and
 * playground runs are audit records, neither a resource; Codes hosts no repositories, so no codes.repo
 * kind (ADR-048's catalog).
 *
 * Tenancy: `?project=prj_…` is the caller's tenancy boundary. With it, only that project's resources
 * answer; a resource of another project is never returned. Without it the first-party caller (the
 * capability is first-party) sees every Codes-owned resource, which is what an authority-wide fan-out
 * needs.
 *
 * OVRN: a summary's ovrn is computed with openvibe-contracts' contracts.resources.nameOf, the one
 * formatter, so it is present exactly when the resource is a nameable resource. Both kinds here are
 * nameable (ADR-048: codes.manifest is mfs_, codes.release is rel_): a manifest is named
 * ovrn:codes:<prj_…>:manifest/mfs_…, a release ovrn:codes:<prj_…>:release/rel_…. That is also what
 * GET /api/v1/resources/:ovrn can read: only a resource whose computed ovrn equals the one asked for
 * answers.
 *
 * Field mapping (`only fields the schema allows`; common.resource-summary@1):
 *   codes.manifest — name: the name in the stored manifest body (both manifest schemas require `name`;
 *     the row is written only after it validated), state: 'valid' (a manifest row is immutable — it is
 *     written once, after validation, and has no lifecycle of its own). owner: created_by when it is a
 *     user:usr_… subject; an app:app_… actor has none.
 *   codes.release  — name: releases.name, state: releases.status (draft|published|deprecated|revoked).
 *     owner: created_by likewise.
 */
const contracts = require('openvibe-contracts');
const { asyncRouter } = require('../http/router');

const SERVICE = 'codes';
const RESOURCE_READ = 'codes.resource.read';
const MANIFEST_KIND = 'codes.manifest';
const RELEASE_KIND = 'codes.release';
const KINDS = [MANIFEST_KIND, RELEASE_KIND];
const PROJECT_ID_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** The stored subject (user:usr_… / app:app_…) as an identity.subject-ref, or null. Only a person owns. */
function userOwner(subject) {
    const ref = contracts.ids.parseSubject(subject);
    return ref && ref.type === 'user' ? ref : null;
}

/** A manifest body's own `name` (both schemas require it), or null when the row holds none. */
function manifestName(body) {
    try { const name = JSON.parse(body).name; return typeof name === 'string' && name ? name : null; } catch { return null; }
}

/** common.resource-summary@1 for a manifests row. A manifest's project is its tenancy boundary. */
function manifestSummary(m) {
    const owner = userOwner(m.created_by);
    const name = manifestName(m.body);
    return {
        id: m.id, kind: MANIFEST_KIND, service: SERVICE, project_id: m.project_id,
        ...(owner ? { owner } : {}),
        ...(name ? { name } : {}),
        state: 'valid', created_at: m.created_at,
    };
}

/** common.resource-summary@1 for a releases row; its state is the release's own status. */
function releaseSummary(r) {
    const owner = userOwner(r.created_by);
    return {
        id: r.id, kind: RELEASE_KIND, service: SERVICE, project_id: r.project_id,
        ...(owner ? { owner } : {}),
        name: r.name, state: r.status, created_at: r.created_at,
    };
}

/** The summary's ovrn: both kinds are nameable, so contracts.resources.nameOf always composes one. */
function ovrnOf(summary) {
    return contracts.resources.nameOf(summary);
}

/** The summary with its ovrn attached when it has one. */
function named(summary) {
    const ovrn = ovrnOf(summary);
    return ovrn ? { ...summary, ovrn } : summary;
}

/** A stable (kind, id) ordering, so a cursor can be a position in it. */
const order = (x, y) => (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/** The summaries matching the filters: `project` scopes tenancy, `kind` picks one kind. Sorted by (kind, id). */
// Scope: codes.resource.read is first-party (resourceConstraints none), so its holder sees every project and
// ?project= only narrows. If it is ever granted to a non-first-party principal, derive the scope from that
// principal's grants here instead of trusting the query.
async function collect(db, { project = null, kind = null } = {}) {
    const out = [];
    if (!kind || kind === MANIFEST_KIND) {
        const rows = project
            ? await db.prepare('SELECT id, project_id, body, created_by, created_at FROM manifests WHERE project_id = ? ORDER BY id').all(project)
            : await db.prepare('SELECT id, project_id, body, created_by, created_at FROM manifests ORDER BY id').all();
        for (const m of rows) out.push(named(manifestSummary(m)));
    }
    if (!kind || kind === RELEASE_KIND) {
        const rows = project
            ? await db.prepare('SELECT id, project_id, name, status, created_by, created_at FROM releases WHERE project_id = ? ORDER BY id').all(project)
            : await db.prepare('SELECT id, project_id, name, status, created_by, created_at FROM releases ORDER BY id').all();
        for (const r of rows) out.push(named(releaseSummary(r)));
    }
    return out.sort(order);
}

/** A cursor is an opaque base64url [kind, id] position; only one this index issued decodes to that. */
const encodeCursor = (s) => Buffer.from(JSON.stringify([s.kind, s.id])).toString('base64url');
function decodeCursor(raw) {
    let v;
    try { v = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')); } catch { return null; }
    return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' ? v : null;
}
const afterCursor = (s, [kind, id]) => s.kind > kind || (s.kind === kind && s.id > id);

/** The query as filters, or { error } for a value that cannot be honoured. An unknown kind is kept (it matches nothing). */
function filtersOf(query) {
    const project = typeof query.project === 'string' && query.project !== '' ? query.project : null;
    if (project && !PROJECT_ID_RE.test(project)) return { error: 'project must be a prj_ id' };
    const kind = typeof query.kind === 'string' && query.kind !== '' ? query.kind : null;
    let limit = DEFAULT_LIMIT;
    if (typeof query.limit === 'string' && query.limit !== '') {
        if (!/^\d+$/.test(query.limit) || Number(query.limit) < 1 || Number(query.limit) > MAX_LIMIT) return { error: `limit must be an integer 1-${MAX_LIMIT}` };
        limit = Number(query.limit);
    }
    let cursor = null;
    if (typeof query.cursor === 'string' && query.cursor !== '') {
        cursor = decodeCursor(query.cursor);
        if (!cursor) return { error: 'cursor is not one this index issued' };
    }
    return { project, kind, limit, cursor };
}

/** The Codes store (the app's own database), as server/app.js keeps it. */
const dbOf = (req) => req.app.locals.ctx.store.db;

/**
 * router({ guard }) — guard is the middleware chain that enforces codes.resource.read
 * (server/http/api.js's createCapabilityAccess(...).checked('codes.resource.read')), mounted at
 * /api/v1/resources by server/app.js.
 */
function router({ guard }) {
    const open = (res) => res.set('Cache-Control', 'private, max-age=60');
    const bad = (res, detail) => contracts.http.sendProblem(res, 400, 'resources.bad_query', { detail });
    const unknown = (res, name) => contracts.http.sendProblem(res, 404, 'resources.unknown_resource', { detail: `no resource named ${name}` });

    /** One common.resource-list-result@1 page: the filtered, sorted summaries from the cursor, then `limit` of them. */
    async function page(req, res) {
        const f = filtersOf(req.query);
        if (f.error) return bad(res, f.error);
        const all = await collect(dbOf(req), f);
        const rest = f.cursor ? all.filter((s) => afterCursor(s, f.cursor)) : all;
        const resources = rest.slice(0, f.limit);
        const next_cursor = rest.length > f.limit ? encodeCursor(resources[resources.length - 1]) : null;
        open(res).json({ resources, next_cursor });
    }

    /** GET /api/v1/resources/:ovrn: the summary whose computed ovrn is exactly the one asked for. */
    async function one(req, res) {
        const name = String(req.params.ovrn);
        const parsed = contracts.resources.parse(name);
        const db = dbOf(req);
        let summary = null;
        if (parsed && parsed.service === SERVICE) {
            if (parsed.type === 'manifest') {
                const row = await db.prepare('SELECT id, project_id, body, created_by, created_at FROM manifests WHERE id = ?').get(parsed.id);
                if (row) summary = named(manifestSummary(row));
            } else if (parsed.type === 'release') {
                const row = await db.prepare('SELECT id, project_id, name, status, created_by, created_at FROM releases WHERE id = ?').get(parsed.id);
                if (row) summary = named(releaseSummary(row));
            }
        }
        if (!summary || summary.ovrn !== name) return unknown(res, name);
        open(res).json(summary);
    }

    const r = asyncRouter();
    r.get('/', ...guard, page);
    r.get('/:ovrn', ...guard, one);
    return r;
}

module.exports = {
    router, SERVICE, RESOURCE_READ, KINDS, MANIFEST_KIND, RELEASE_KIND, DEFAULT_LIMIT, MAX_LIMIT,
    manifestSummary, releaseSummary, ovrnOf, collect, encodeCursor,
};
