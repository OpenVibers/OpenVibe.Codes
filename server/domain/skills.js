'use strict';

/**
 * The Codes skills hub (the Compute plan §5, E6): skills, rules, MCP servers, commands and hooks kept per person and
 * per project, versioned, and shared through openvibe-sdk/share — the same four audiences (public, link, people,
 * private), the same access check and the same members table as a run task.
 *
 * A record's content lives only in codes_skill_versions; codes_skills names the newest version and what is shown in
 * the gallery. Every save is a new immutable version, and a rollback copies an old version into a new one, so the Node
 * that synced version 3 can still name exactly what it wrote.
 *
 * Only public records are in the gallery. A link record is readable by its id, a people record by the owner and its
 * members, and a private record by the owner alone; a record that is not readable is a generic 404, never a hint that
 * it exists.
 */

const KINDS = ['skill', 'rule', 'mcp', 'command', 'hook'];
const AUDIENCES = ['public', 'link', 'people', 'private'];
const TOOLS = ['claude-code', 'codex', 'opencode', 'command-code', 'minimax-code', 'aider', 'agents'];
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const ID = /^skl_[0-9A-HJKMNP-TV-Z]{26}$/;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_BODY = 131072;
const MAX_TITLE = 120;
const MAX_SUMMARY = 500;
const SERVICE = 'codes';
const KIND = 'skill';

class SkillError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'SkillError';
        this.status = status;
        this.code = code;
    }
}

const fail = (status, code, message) => { throw new SkillError(status, code, message); };
const cleanText = (v) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : '');
const refOf = (id) => ({ service: SERVICE, kind: KIND, id: String(id) });

/** Validate what a create or a new version carries; the caller supplies the fields that a version may omit. */
function check(input, { create = false, base = null } = {}) {
    const errors = [];
    const b = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const out = {};

    const title = b.title === undefined && base ? base.title : cleanText(b.title);
    if (!title) errors.push('title is required');
    else if (title.length > MAX_TITLE) errors.push(`title is at most ${MAX_TITLE} characters`);
    else out.title = title;

    const summary = b.summary === undefined && base ? base.summary : cleanText(b.summary);
    if (summary.length > MAX_SUMMARY) errors.push(`summary is at most ${MAX_SUMMARY} characters`);
    else out.summary = summary;

    const body = b.body === undefined && base ? base.body : (typeof b.body === 'string' ? b.body.replace(/\r\n/g, '\n') : '');
    if (!body.trim()) errors.push('body is required');
    else if (body.length > MAX_BODY) errors.push(`body is at most ${MAX_BODY} characters`);
    else out.body = body;

    const audience = b.audience === undefined ? (base ? base.audience : 'private') : b.audience;
    if (!AUDIENCES.includes(audience)) errors.push(`audience is one of ${AUDIENCES.join(', ')}`);
    else out.audience = audience;

    const tools = b.tools === undefined ? (base ? base.tools : []) : b.tools;
    if (!Array.isArray(tools) || tools.length > 8 || tools.some((t) => !TOOLS.includes(t)) || new Set(tools).size !== tools.length) {
        errors.push(`tools is up to eight of ${TOOLS.join(', ')}`);
    } else out.tools = tools;

    if (create) {
        const kind = b.kind;
        if (!KINDS.includes(kind)) errors.push(`kind is one of ${KINDS.join(', ')}`);
        else out.kind = kind;
        const slug = typeof b.slug === 'string' ? b.slug.trim() : '';
        if (!SLUG.test(slug)) errors.push('slug is lowercase letters, digits and hyphens (at most 64)');
        else out.slug = slug;
    }
    return { ok: errors.length === 0, errors, value: out };
}

/** One joined row, as codes.skill@1. */
function present(row) {
    const tools = Array.isArray(row.tools) ? row.tools : (typeof row.tools === 'string' ? JSON.parse(row.tools) : []);
    return {
        id: row.id,
        owner_subject: row.owner_subject,
        kind: row.kind,
        slug: row.slug,
        title: row.title,
        summary: row.summary || '',
        audience: row.audience || 'private',
        official: !!row.official,
        tools,
        version: Number(row.version),
        body: row.body,
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
}

const COLUMNS = 's.id, s.owner_subject, s.kind, s.slug, s.title, s.official, s.latest_version AS version, '
    + "v.summary, v.body, v.tools, COALESCE(sh.audience, 'private') AS audience, s.created_at, s.updated_at";
const FROM = 'FROM codes_skills s JOIN codes_skill_versions v ON v.skill_id = s.id AND v.version = s.latest_version '
    + "LEFT JOIN shares sh ON sh.service = 'codes' AND sh.kind = 'skill' AND sh.resource_id = s.id";

function createSkills({ store, sharing, log = console }) {
    const db = store.db;
    const iso = store.iso;
    // The SDK's sharing model; app.js always builds it. Without it a record is owner-only, never public.
    const shares = sharing && sharing.shares;
    const shareViewer = sharing && sharing.shareViewer;
    const asShareViewer = (viewer) => (shareViewer ? shareViewer(viewer) : null);

    function owned(row, subject) {
        if (!row || row.owner_subject !== subject) fail(404, 'skill.not_found', 'no such skill of yours');
        return row;
    }

    /** Whether this viewer may read the record: openvibe-sdk/share decides (owner, public, link, people). */
    async function allowed(row, viewer) {
        if (!row) return false;
        if (viewer && viewer.subject && viewer.subject === row.owner_subject) return true;
        if (!shares) return false;
        try { return await shares.canView(asShareViewer(viewer), refOf(row.id)); } catch (err) {
            if (err && err.status === 404) return false;
            throw err;
        }
    }

    async function load(id) {
        if (!ID.test(String(id || ''))) return null;
        return db.maybe(`SELECT ${COLUMNS} ${FROM} WHERE s.id = $1`, [id]);
    }

    async function get(id, viewer) {
        const row = await load(id);
        return (await allowed(row, viewer)) ? present(row) : null;
    }

    async function create({ subject, input }) {
        const checkIn = check(input, { create: true });
        if (!checkIn.ok) fail(422, 'skill.invalid', checkIn.errors.join('; '));
        const v = checkIn.value;
        const id = store.newId('skl');
        const at = iso();
        try {
            await store.tx(async () => {
                await db.exec('INSERT INTO codes_skills (id, owner_subject, kind, slug, title, tools, latest_version, created_at, updated_at) '
                    + 'VALUES ($1,$2,$3,$4,$5,$6::jsonb,1,$7,$7)', [id, subject, v.kind, v.slug, v.title, JSON.stringify(v.tools), at]);
                await db.exec('INSERT INTO codes_skill_versions (skill_id, version, summary, body, tools, audience, created_by, note, created_at) '
                    + 'VALUES ($1,1,$2,$3,$4::jsonb,$5,$6,$7,$8)', [id, v.summary, v.body, JSON.stringify(v.tools), v.audience, subject, 'created', at]);
            });
        } catch (err) {
            if (err && (err.code === '23505' || /duplicate key/i.test(String(err.message || '')))) {
                fail(409, 'skill.slug_taken', `you already have a ${v.kind} called ${v.slug}`);
            }
            throw err;
        }
        if (!shares) {
            await db.exec('DELETE FROM codes_skills WHERE id = $1', [id]);
            fail(503, 'skill.sharing_unavailable', 'sharing is not configured on this service');
        }
        try {
            await shares.register(refOf(id), { owner_subject: { type: 'user', id: subject }, audience: v.audience });
        } catch (err) {
            await db.exec('DELETE FROM codes_skills WHERE id = $1', [id]).catch(() => {});
            throw err;
        }
        return get(id, { subject });
    }

    /** A new version of an owned record; the row's title, tools and timestamp follow it. Audience is separate. */
    async function addVersion({ subject, id, input, note = 'edited' }) {
        const row = owned(await load(id), subject);
        const checkIn = check({ ...(input || {}), audience: row.audience }, { base: present(row) });
        if (!checkIn.ok) fail(422, 'skill.invalid', checkIn.errors.join('; '));
        const v = checkIn.value;
        const version = Number(row.version) + 1;
        const at = iso();
        await store.tx(async () => {
            await db.exec('INSERT INTO codes_skill_versions (skill_id, version, summary, body, tools, audience, created_by, note, created_at) '
                + 'VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)', [id, version, v.summary, v.body, JSON.stringify(v.tools), v.audience, subject, String(note).slice(0, 200), at]);
            await db.exec('UPDATE codes_skills SET title = $2, tools = $3::jsonb, latest_version = $4, updated_at = $5 WHERE id = $1',
                [id, v.title, JSON.stringify(v.tools), version, at]);
        });
        return get(id, { subject });
    }

    /** Copy an old version into a new one; history is never rewritten. */
    async function rollback({ subject, id, version }) {
        const row = owned(await load(id), subject);
        const n = Number(version);
        if (!Number.isInteger(n) || n < 1) fail(422, 'skill.invalid', 'version is a positive integer');
        const old = await db.maybe('SELECT * FROM codes_skill_versions WHERE skill_id = $1 AND version = $2', [id, n]);
        if (!old) fail(404, 'skill.version_not_found', 'no such version of this skill');
        return addVersion({ subject, id, input: { title: row.title, summary: old.summary, body: old.body, tools: old.tools }, note: `rolled back to ${n}` });
    }

    /** The audience is the SDK's share row; the version history records which audience a body was saved under. */
    async function setAudience({ subject, id, audience }) {
        owned(await load(id), subject);
        if (!AUDIENCES.includes(audience)) fail(422, 'skill.invalid', `audience is one of ${AUDIENCES.join(', ')}`);
        if (!shares) fail(503, 'skill.sharing_unavailable', 'sharing is not configured on this service');
        await shares.setAudience(asShareViewer({ subject }), refOf(id), audience);
        const at = iso();
        const record = await db.maybe(`SELECT ${COLUMNS} ${FROM} WHERE s.id = $1`, [id]);
        const version = Number(record.version) + 1;
        await store.tx(async () => {
            await db.exec('INSERT INTO codes_skill_versions (skill_id, version, summary, body, tools, audience, created_by, note, created_at) '
                + 'VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)', [id, version, record.summary, record.body, JSON.stringify(record.tools),
                audience, subject, `audience ${audience}`, at]);
            await db.exec('UPDATE codes_skills SET latest_version = $2, updated_at = $3 WHERE id = $1', [id, version, at]);
        });
        return get(id, { subject });
    }

    async function members(id, viewer) {
        owned(await load(id), viewer && viewer.subject);
        if (!shares) return [];
        const snap = await shares.get(asShareViewer(viewer), refOf(id));
        return (snap.members || []).map((m) => ({ subject: m.subject, role: m.role, created_at: m.added_at }));
    }

    async function addMember({ subject, id, memberSubject }) {
        owned(await load(id), subject);
        if (!SUBJECT.test(String(memberSubject || ''))) fail(422, 'skill.invalid', 'member is a usr_… subject');
        if (!shares) fail(503, 'skill.sharing_unavailable', 'sharing is not configured on this service');
        await shares.addMembers(asShareViewer({ subject }), refOf(id), [{ type: 'user', id: memberSubject }]);
        return members(id, { subject });
    }

    async function removeMember({ subject, id, memberSubject }) {
        owned(await load(id), subject);
        if (!shares) fail(503, 'skill.sharing_unavailable', 'sharing is not configured on this service');
        await shares.removeMember(asShareViewer({ subject }), refOf(id), { type: 'user', id: memberSubject });
        return members(id, { subject });
    }

    async function listVersions(id, viewer) {
        const row = await load(id);
        if (!(await allowed(row, viewer))) return null;
        return (await db.many('SELECT skill_id, version, summary, body, tools, audience, created_by, note, created_at FROM codes_skill_versions WHERE skill_id = $1 ORDER BY version DESC', [id]))
            .map((v) => ({
                skill_id: v.skill_id,
                version: Number(v.version),
                summary: v.summary,
                body: v.body,
                tools: Array.isArray(v.tools) ? v.tools : JSON.parse(v.tools || '[]'),
                audience: v.audience,
                created_by: v.created_by,
                created_at: v.created_at instanceof Date ? v.created_at.toISOString() : String(v.created_at),
                ...(v.note ? { note: v.note } : {}),
            }));
    }

    /** Public records only: the gallery, search and other sites never see link, people or private ones. */
    async function gallery({ kind, tool, q, limit = 60 } = {}) {
        const where = ["sh.audience = 'public'"];
        const params = [];
        if (kind && KINDS.includes(kind)) { params.push(kind); where.push(`s.kind = $${params.length}`); }
        if (tool && TOOLS.includes(tool)) { params.push(JSON.stringify([tool])); where.push(`v.tools @> $${params.length}::jsonb`); }
        const text = cleanText(q);
        if (text) { params.push(`%${text.slice(0, 80)}%`); where.push(`(s.title ILIKE $${params.length} OR s.summary ILIKE $${params.length})`); }
        params.push(Math.max(1, Math.min(100, Number(limit) || 60)));
        const rows = await db.many(`SELECT ${COLUMNS} ${FROM} WHERE ${where.join(' AND ')} ORDER BY s.official DESC, s.updated_at DESC, s.slug LIMIT $${params.length}`, params);
        return rows.map(present);
    }

    async function mine(subject) {
        const rows = await db.many(`SELECT ${COLUMNS} ${FROM} WHERE s.owner_subject = $1 ORDER BY s.updated_at DESC, s.slug`, [subject]);
        return rows.map(present);
    }

    async function assign({ subject, id, project = '' }) {
        const row = await load(id);
        if (!(await allowed(row, { subject }))) fail(404, 'skill.not_found', 'no such skill');
        const scope = String(project || '');
        if (scope && !PROJECT.test(scope)) fail(422, 'skill.invalid', 'project is a slug');
        await db.exec('INSERT INTO codes_skill_assignments (subject, project, skill_id) VALUES ($1, $2, $3) ON CONFLICT (subject, project, skill_id) DO NOTHING', [subject, scope, id]);
        return present(row);
    }

    async function unassign({ subject, id, project = '' }) {
        const scope = String(project || '');
        await db.exec('DELETE FROM codes_skill_assignments WHERE subject = $1 AND project = $2 AND skill_id = $3', [subject, scope, id]);
    }

    /** What the Node syncs: the person's picks, plus this project's picks, at their newest versions. */
    async function manifest({ subject, project = '' }) {
        const scope = String(project || '');
        const rows = await db.many(`SELECT ${COLUMNS} ${FROM}
            WHERE s.id IN (SELECT skill_id FROM codes_skill_assignments WHERE subject = $1 AND (project = '' OR project = $2))
            ORDER BY s.slug`, [subject, scope]);
        return { generated_at: iso(), skills: rows.map(present) };
    }

    async function assignments(subject, project = '') {
        return (await db.many('SELECT skill_id, project, created_at FROM codes_skill_assignments WHERE subject = $1 AND project = $2 ORDER BY created_at', [subject, String(project || '')]))
            .map((r) => ({ skill_id: r.skill_id, project: r.project, created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at) }));
    }

    return { create, get, listVersions, gallery, mine, addVersion, rollback, setAudience, members, addMember, removeMember, assign, unassign, manifest, assignments };
}

module.exports = { createSkills, SkillError, KINDS, AUDIENCES, TOOLS, MAX_BODY, MAX_TITLE, MAX_SUMMARY };
