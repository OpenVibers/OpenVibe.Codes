'use strict';

/**
 * Portable sessions a person carried here (plan §AD.22, conversation.import@1): `openvibe-codes import` uploads one, the
 * page lists them, and "Continue" starts a conductor that resumes it on one of the person's machines.
 *
 *   createSessionImports({ store, log })
 *     save(subject, gzipped)      → the import as the page shows it (the document is checked, never trusted)
 *     list(subject)               → their imports, newest first
 *     get(subject, id)            → one, with its preview
 *     data(subject, id)           → { gz } the document for the machine that resumes it
 *     MAX_BYTES
 *
 * Every query is scoped to the person: another person's import is not found, never forbidden.
 */
const zlib = require('zlib');
const crypto = require('crypto');
const portable = require('../../engine/portable');
const { FORMAT } = portable;

const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const ID = /^imp_[0-9A-HJKMNP-TV-Z]{26}$/;
const SESSION = /^[A-Za-z0-9._-]{4,100}$/;
// `handover`: a conversation an agent wrote down (any harness without a file to read: Markdown or plain text).
const HARNESSES = new Set(['claude-code', 'codex', 'opencode', 'gemini', 'handover']);
const LINK_RE = /^cdi_[A-Za-z0-9_-]{32}$/;
const LINK_MINUTES = 30;
const MAX_LIVE_LINKS = 10;
/** The upload, gzipped: a Claude Code tail of 6 MB is about 1 MB. */
const MAX_BYTES = 40 * 1024 * 1024;
/** The document once unpacked. */
const MAX_UNPACKED = 200 * 1024 * 1024;

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, n);

/** The document from the upload (gzip or plain JSON), checked: conversation.import@1 with what the page and a resume
 *  need, nothing executable. */
function readDocument(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw fail(422, 'import.empty', 'the upload is empty');
    if (buffer.length > MAX_BYTES) throw fail(413, 'import.too_large', `an import is at most ${MAX_BYTES / 1048576} MB compressed`);
    let text;
    try {
        text = (buffer[0] === 0x1f && buffer[1] === 0x8b ? zlib.gunzipSync(buffer, { maxOutputLength: MAX_UNPACKED }) : buffer).toString('utf8');
    } catch { throw fail(422, 'import.unreadable', 'the upload is not gzip or JSON'); }
    let doc;
    try { doc = JSON.parse(text); } catch { throw fail(422, 'import.not_json', 'the upload is not JSON'); }
    if (!doc || doc.format !== FORMAT) throw fail(422, 'import.format', `the document is not ${FORMAT}`);
    if (!HARNESSES.has(doc.harness)) throw fail(422, 'import.harness', `the harness is one of ${[...HARNESSES].join(', ')}`);
    if (!SESSION.test(String(doc.session_id || ''))) throw fail(422, 'import.session', 'the session id is not one an agent makes');
    const records = doc.resume && Array.isArray(doc.resume.records) ? doc.resume.records : null;
    if (records && !records.every((r) => r && typeof r === 'object' && !Array.isArray(r))) throw fail(422, 'import.records', 'every record is an object');
    const messages = (Array.isArray(doc.messages) ? doc.messages : []).slice(-40)
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
        .map((m) => ({ role: m.role, text: clip(m.text, 2000), ...(m.at ? { at: clip(m.at, 40) } : {}) }));
    return { doc, records, messages };
}

/**
 * The upload as a conversation.import@1 document: one already (the importer's), or a session file of any harness as
 * it is on disk (the /import page's drop: a Claude Code session from its last compaction, a Codex rollout, a Gemini CLI
 * session, an OpenCode export, a hand-over in Markdown), read by engine/portable.js's fromText.
 */
function asDocument(upload, { name = null } = {}) {
    if (!Buffer.isBuffer(upload) || !upload.length) throw fail(422, 'import.empty', 'the upload is empty');
    if (upload.length > MAX_BYTES) throw fail(413, 'import.too_large', `an import is at most ${MAX_BYTES / 1048576} MB compressed`);
    let text;
    try {
        text = (upload[0] === 0x1f && upload[1] === 0x8b ? zlib.gunzipSync(upload, { maxOutputLength: MAX_UNPACKED }) : upload).toString('utf8');
    } catch { throw fail(422, 'import.unreadable', 'the upload is not gzip or text'); }
    const head = text.slice(0, 4096);
    if (/"format"\s*:\s*"conversation\.import@1"/.test(head) && head.trimStart().startsWith('{"format"')) return upload;
    let doc;
    try { doc = portable.fromText(text, { name: name ? String(name).slice(0, 120) : null }); }
    catch (e) { throw fail(422, 'import.unreadable', `the file is not a session this can read: ${String((e && e.message) || e).slice(0, 200)}`); }
    return zlib.gzipSync(JSON.stringify(doc));
}

function createSessionImports({ store, log = console }) {
    const db = store.db;
    const requireUser = (subject) => {
        if (!USER.test(String(subject || ''))) throw fail(400, 'subject.required', 'imports belong to a signed-in person');
        return subject;
    };
    const present = (row, { preview = false } = {}) => row && {
        id: row.id,
        harness: row.harness,
        session_id: row.session_id,
        title: row.title,
        source_cwd: row.source_cwd || null,
        resumable: !!row.resumable,
        messages: Number(row.messages) || 0,
        records: Number(row.records) || 0,
        size: Number(row.size) || 0,
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        ...(preview ? { preview: Array.isArray(row.preview) ? row.preview : (typeof row.preview === 'string' ? JSON.parse(row.preview) : []) } : {}),
    };

    async function save(subject, upload, { name = null } = {}) {
        requireUser(subject);
        const buffer = asDocument(upload, { name });
        const { doc, records, messages } = readDocument(buffer);
        const gz = buffer[0] === 0x1f && buffer[1] === 0x8b ? buffer : zlib.gzipSync(buffer);
        const row = await db.one(
            `INSERT INTO codes_session_imports (id, subject, harness, session_id, title, source_cwd, resumable, messages, records, size, preview, data)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
             RETURNING id, subject, harness, session_id, title, source_cwd, resumable, messages, records, size, preview, created_at`,
            [store.newId('imp'), subject, doc.harness, doc.session_id, clip(doc.title || 'An imported session', 200) || 'An imported session',
                doc.source && doc.source.cwd ? clip(doc.source.cwd, 1000) : null, doc.harness === 'claude-code' && !!records && records.length > 0,
                Number(doc.counts && doc.counts.messages) || messages.length, records ? records.length : 0, gz.length, JSON.stringify(messages), gz],
        );
        log.info(`[Codes] session import ${row.id} (${doc.harness}, ${gz.length} bytes) by ${subject}`);
        return present(row, { preview: true });
    }

    async function list(subject, { limit = 50 } = {}) {
        requireUser(subject);
        const rows = await db.many(
            `SELECT id, subject, harness, session_id, title, source_cwd, resumable, messages, records, size, created_at
               FROM codes_session_imports WHERE subject = $1 ORDER BY created_at DESC LIMIT $2`,
            [subject, Math.min(200, Math.max(1, Number(limit) || 50))],
        );
        return rows.map((r) => present(r));
    }

    async function get(subject, id) {
        requireUser(subject);
        if (!ID.test(String(id || ''))) return null;
        const row = await db.maybe(
            `SELECT id, subject, harness, session_id, title, source_cwd, resumable, messages, records, size, preview, created_at
               FROM codes_session_imports WHERE id = $1 AND subject = $2`, [id, subject]);
        return present(row, { preview: true });
    }

    async function data(subject, id) {
        requireUser(subject);
        if (!ID.test(String(id || ''))) return null;
        const row = await db.maybe('SELECT data FROM codes_session_imports WHERE id = $1 AND subject = $2', [id, subject]);
        return row ? { gz: Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data || '') } : null;
    }

    async function remove(subject, id) {
        requireUser(subject);
        if (!ID.test(String(id || ''))) return { removed: false };
        await db.exec('DELETE FROM codes_session_imports WHERE id = $1 AND subject = $2', [id, subject]);
        return { removed: true };
    }

    // ── One-time import links (migration 0048): one upload of one session into the person's account ──────────────
    const hashOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

    /** A new link: { token, expires_at }. The token is shown once; only its hash is kept. */
    async function createLink(subject) {
        requireUser(subject);
        const live = await db.one('SELECT count(*)::int AS n FROM codes_session_import_links WHERE subject = $1 AND used_at IS NULL AND expires_at > now()', [subject]);
        if (live.n >= MAX_LIVE_LINKS) throw fail(429, 'import.links', `at most ${MAX_LIVE_LINKS} unused links at a time: use one, or wait ${LINK_MINUTES} minutes`);
        await db.exec("DELETE FROM codes_session_import_links WHERE subject = $1 AND expires_at < now() - interval '7 days'", [subject]);
        const token = `cdi_${crypto.randomBytes(24).toString('base64url')}`;
        const expires = new Date(Date.now() + LINK_MINUTES * 60_000);
        await db.exec('INSERT INTO codes_session_import_links (token_hash, subject, expires_at) VALUES ($1, $2, $3)', [hashOf(token), subject, expires.toISOString()]);
        return { token, expires_at: expires.toISOString() };
    }

    /** Claims a link for one upload: its person, or null (unknown, used or expired). Atomic: two uploads race, one wins. */
    async function claimLink(token) {
        if (!LINK_RE.test(String(token || ''))) return null;
        const row = await db.maybe(
            'UPDATE codes_session_import_links SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING subject',
            [hashOf(token)]);
        return row ? row.subject : null;
    }

    /** After the upload: the import it made, or the link back for another try when the upload was refused. */
    async function settleLink(token, importId) {
        if (importId) await db.exec('UPDATE codes_session_import_links SET import_id = $2 WHERE token_hash = $1', [hashOf(token), importId]);
        else await db.exec('UPDATE codes_session_import_links SET used_at = NULL WHERE token_hash = $1 AND import_id IS NULL', [hashOf(token)]);
    }

    return { save, list, get, data, remove, createLink, claimLink, settleLink, MAX_BYTES };
}

module.exports = { createSessionImports, readDocument, ID, MAX_BYTES, LINK_RE, LINK_MINUTES };
