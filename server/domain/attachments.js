'use strict';

/**
 * The files a person attaches to a message (owner 2026-11-07: "full file support in the composer"). Any file that is not
 * an executable: images, PDFs, text and code, zips, documents. Codes keeps the bytes in its own database, owner-only,
 * and a message carries only their names and a route to read them (server/http/attachments-api.js).
 *
 *   createAttachments({ store })
 *     save(subject, file)                    one upload → its row ({ id, name, mime, size, image })
 *     saveMany(subject, files)               a whole message's uploads, refused as one when a limit is passed
 *     own(subject, id)                       the row, without bytes; null for another person
 *     get(subject, id)                       the row with its bytes (Buffer in `data`)
 *     remove(subject, id)                    an upload that is not attached yet
 *     pending(subject, ids)                  the uploads a JSON submit names, checked and unclaimed
 *     link(subject, rows, { taskId, attemptN, messageId })  claim them for one message
 *     forTask(taskId, attemptN)              one turn's files, in upload order
 *     forMessage(messageId)                  a conductor message's files
 *     present(row)                           { id, name, mime, size, image } (never the bytes)
 *     promptSection(files, folder)           the lines an agent gets: where each file is
 *
 * The limits are the owner's: at most 10 files, at most 20 MB each and 50 MB for one message. An executable is refused
 * by its extension AND by its magic bytes (a renamed .exe is still a PE), and the type stored is the one the bytes say,
 * never the one the client claimed.
 */
const path = require('path');
const { isUtf8 } = require('buffer');

const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_FILES = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 50 * 1024 * 1024;
const MAX_NAME = 120;
const SAFE_DIR = /^[A-Za-z0-9._-]{1,80}$/;

/** Tools and programs, never something an agent should open as an attachment. */
const BLOCKED_EXT = new Set([
    '.app', '.apk', '.bat', '.bin', '.cmd', '.com', '.deb', '.dll', '.dmg', '.elf', '.exe', '.jar', '.msi', '.pkg',
    '.ps1', '.rpm', '.scr', '.sh', '.so', '.dylib', '.vb', '.vbs', '.wsf', '.cpl', '.msc', '.gadget', '.hta',
]);

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

/** A filename that is one file in one folder: no path, no control characters, still its own extension. */
function safeName(raw) {
    const base = path.basename(String(raw || '').replace(/\\/g, '/')).slice(0, 200);
    const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
    const name = cleaned.slice(0, MAX_NAME) || 'file';
    return name === '.' || name === '..' ? 'file' : name;
}

/** The extension a name declares, lower-case ('' when none). */
const extOf = (name) => {
    const base = path.basename(String(name || ''));
    const i = base.lastIndexOf('.');
    return i > 0 ? base.slice(i).toLowerCase() : '';
};

const starts = (b, bytes) => b.length >= bytes.length && b.subarray(0, bytes.length).equals(Buffer.from(bytes));
const PE = (b) => b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a;                    // MZ
const ELF = (b) => starts(b, [0x7f, 0x45, 0x4c, 0x46]);                               // \x7fELF
const MACH = (b) => starts(b, [0xfe, 0xed, 0xfa, 0xce]) || starts(b, [0xfe, 0xed, 0xfa, 0xcf])
    || starts(b, [0xce, 0xfa, 0xed, 0xfe]) || starts(b, [0xcf, 0xfa, 0xed, 0xfe])
    || starts(b, [0xca, 0xfe, 0xba, 0xbe]);                                           // Mach-O / universal / Java class
const SHEBANG = (b) => starts(b, [0x23, 0x21]);                                       // #!
const DOS_SCRIPT = (b) => starts(b, [0x40, 0x65, 0x63, 0x68, 0x6f]);                  // @echo

/** What the bytes themselves say. Nothing here trusts the MIME the browser sent. */
function magicMime(buffer, name) {
    if (!buffer.length) return 'application/octet-stream';
    if (starts(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (starts(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (starts(buffer, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
    if (buffer.length >= 12 && starts(buffer, [0x52, 0x49, 0x46, 0x46]) && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
    if (starts(buffer, [0x00, 0x00, 0x00]) && buffer.subarray(4, 8).toString() === 'ftyp' && /avif|avis|heic|heix|mif1|msf1/.test(buffer.subarray(8, 16).toString())) return buffer.subarray(8, 12).toString().startsWith('avi') ? 'image/avif' : 'image/heic';
    if (starts(buffer, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf';           // %PDF
    if (starts(buffer, [0x50, 0x4b, 0x03, 0x04]) || starts(buffer, [0x50, 0x4b, 0x05, 0x06]) || starts(buffer, [0x50, 0x4b, 0x07, 0x08])) {
        const ext = extOf(name);
        if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        if (ext === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        if (ext === '.pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        if (ext === '.epub') return 'application/epub+zip';
        return 'application/zip';
    }
    if (starts(buffer, [0x1f, 0x8b])) return 'application/gzip';
    if (starts(buffer, [0x42, 0x5a, 0x68])) return 'application/x-bzip2';
    if (starts(buffer, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return 'application/x-7z-compressed';
    if (starts(buffer, [0x52, 0x61, 0x72, 0x21])) return 'application/vnd.rar';
    if (starts(buffer, [0x7f, 0x45, 0x4c, 0x46])) return 'application/x-elf';
    if (PE(buffer)) return 'application/x-msdownload';
    if (MACH(buffer)) return 'application/x-mach-binary';
    if (SHEBANG(buffer) || DOS_SCRIPT(buffer)) return 'application/x-executable';
    // Text and code: valid UTF-8 with no NUL in what we read is text (a 20 MB code file is still text).
    const sample = buffer.length > 8192 ? buffer.subarray(0, 8192) : buffer;
    if (!sample.includes(0) && isUtf8(buffer)) {
        const ext = extOf(name);
        return {
            '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv', '.html': 'text/html', '.htm': 'text/html',
            '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
            '.ts': 'text/typescript', '.tsx': 'text/typescript', '.jsx': 'text/javascript', '.py': 'text/x-python',
            '.rb': 'text/x-ruby', '.go': 'text/x-go', '.rs': 'text/x-rust', '.java': 'text/x-java', '.c': 'text/x-c',
            '.h': 'text/x-c', '.cpp': 'text/x-c++', '.hpp': 'text/x-c++', '.sql': 'text/plain', '.yml': 'text/yaml',
            '.yaml': 'text/yaml', '.toml': 'text/plain', '.xml': 'application/xml', '.svg': 'image/svg+xml',
            '.txt': 'text/plain', '.log': 'text/plain',
        }[ext] || 'text/plain';
    }
    return 'application/octet-stream';
}

/**
 * One upload checked: a name in one folder, a size under the cap, no executable by extension or bytes, and the MIME
 * the bytes say. Throws a 413/422 with a code the composer can show.
 */
function inspect(file) {
    const rawName = String((file && file.name) || 'file');
    const name = safeName(rawName);
    const ext = extOf(rawName);
    if (BLOCKED_EXT.has(ext)) throw fail(422, 'attachment.executable', `${name}: programs and scripts cannot be attached`);
    const buffer = Buffer.isBuffer(file && file.buffer) ? file.buffer : Buffer.alloc(0);
    if (!buffer.length) throw fail(422, 'attachment.empty', `${name} is empty`);
    if (buffer.length > MAX_FILE_BYTES) throw fail(413, 'attachment.too_large', `${name} is larger than 20 MB`);
    if (PE(buffer) || ELF(buffer) || MACH(buffer) || SHEBANG(buffer) || DOS_SCRIPT(buffer)) {
        throw fail(422, 'attachment.executable', `${name} is a program or script, and cannot be attached`);
    }
    const mime = magicMime(buffer, name);
    if (mime === 'application/x-elf' || mime === 'application/x-msdownload' || mime === 'application/x-mach-binary' || mime === 'application/x-executable') {
        throw fail(422, 'attachment.executable', `${name} is a program or script, and cannot be attached`);
    }
    return { name, mime, size: buffer.length, buffer };
}

/** The files a whole message carries, checked together: at most 10 and at most 50 MB. */
function inspectMany(files) {
    const list = Array.isArray(files) ? files.filter(Boolean) : [];
    if (list.length > MAX_FILES) throw fail(422, 'attachment.too_many', `a message carries at most ${MAX_FILES} files`);
    const out = list.map(inspect);
    const total = out.reduce((n, f) => n + f.size, 0);
    if (total > MAX_MESSAGE_BYTES) throw fail(413, 'attachment.message_too_large', 'the files of one message are larger than 50 MB together');
    return out;
}

const imageMime = (mime) => /^image\/(png|jpeg|gif|webp|avif|heic)$/.test(String(mime || ''));

function createAttachments({ store, log = console }) {
    const db = store.db;

    const requireUser = (subject) => {
        if (!USER.test(String(subject || ''))) throw fail(400, 'subject.required', 'attachments belong to a signed-in person');
        return subject;
    };

    /** The SQL row as the API and the page see it: never the bytes. */
    const present = (row) => row && {
        id: row.id, name: row.name, mime: row.mime, size: row.size == null ? null : Number(row.size), image: imageMime(row.mime),
    };

    async function insert(subject, one) {
        const f = inspect(one);
        const row = await db.one(
            `INSERT INTO codes_attachments (id, subject, name, mime, size, data, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id, subject, name, mime, size, created_at`,
            [store.newId('fil'), subject, f.name, f.mime, f.size, f.buffer],
        );
        return row;
    }

    /** One upload: checked and stored, owned by the person, not attached to anything yet. */
    async function save(subject, file) {
        requireUser(subject);
        return present(await insert(subject, file));
    }

    /** A message's uploads (a no-JS multipart form or a batch): all refused or all stored. */
    async function saveMany(subject, files) {
        requireUser(subject);
        const list = inspectMany(files);
        const rows = [];
        await store.tx(async () => {
            for (const f of list) rows.push(await insert(subject, f));
        });
        return rows.map(present);
    }

    async function own(subject, id) {
        if (!USER.test(String(subject || '')) || !/^fil_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id || ''))) return null;
        return await db.maybe('SELECT id, subject, task_id, attempt_n, message_id, name, mime, size, created_at, linked_at FROM codes_attachments WHERE id = $1 AND subject = $2', [id, subject]);
    }

    async function get(subject, id) {
        if (!USER.test(String(subject || '')) || !/^fil_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id || ''))) return null;
        return await db.maybe('SELECT * FROM codes_attachments WHERE id = $1 AND subject = $2', [id, subject]);
    }

    /** An upload the person changed their mind about: only while it is not attached to a message. */
    async function remove(subject, id) {
        const row = await own(subject, id);
        if (!row) throw fail(404, 'attachment.not_found', 'no such attachment of yours');
        if (row.task_id || row.message_id) throw fail(409, 'attachment.in_use', 'this file is already on a message');
        await db.exec('DELETE FROM codes_attachments WHERE id = $1 AND subject = $2', [id, subject]);
        return { removed: true };
    }

    /** The uploads a JSON submit names: theirs, still unclaimed, 10 at most and 50 MB together. */
    async function pending(subject, ids) {
        requireUser(subject);
        const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
        if (wanted.length > MAX_FILES) throw fail(422, 'attachment.too_many', `a message carries at most ${MAX_FILES} files`);
        if (!wanted.length) return [];
        const rows = [];
        for (const id of wanted) rows.push(await own(subject, id));
        if (rows.some((r) => !r)) throw fail(404, 'attachment.not_found', 'an attached file is not yours, or no longer here');
        if (rows.some((r) => r.task_id || r.message_id)) throw fail(409, 'attachment.in_use', 'an attached file is already on another message');
        const total = rows.reduce((n, r) => n + Number(r.size || 0), 0);
        if (total > MAX_MESSAGE_BYTES) throw fail(413, 'attachment.message_too_large', 'the files of one message are larger than 50 MB together');
        return rows;
    }

    /**
     * Claim uploads for one message. The WHERE keeps a file from being claimed twice even when two sends race; a row
     * that lost the race throws, and the caller's transaction rolls back.
     */
    async function link(subject, rows, { taskId = null, attemptN = null, messageId = null } = {}) {
        requireUser(subject);
        const list = Array.isArray(rows) ? rows : [];
        if (!list.length) return [];
        if (list.length > MAX_FILES) throw fail(422, 'attachment.too_many', `a message carries at most ${MAX_FILES} files`);
        if (messageId != null && !SAFE_DIR.test(String(messageId))) throw fail(500, 'attachment.folder_invalid', 'the attachment folder is not a safe name');
        const out = [];
        for (const row of list) {
            const claimed = await db.maybe(
                `UPDATE codes_attachments SET task_id = $3, attempt_n = $4, message_id = $5, linked_at = now()
                  WHERE id = $1 AND subject = $2 AND task_id IS NULL AND message_id IS NULL
                  RETURNING id, subject, task_id, attempt_n, message_id, name, mime, size, created_at, linked_at`,
                [row.id, subject, taskId, attemptN, messageId],
            );
            if (!claimed) throw fail(409, 'attachment.in_use', 'an attached file is already on another message');
            out.push(claimed);
        }
        return out;
    }

    /** One turn's files, oldest first: what the page lists under the message. */
    async function forTask(taskId, attemptN) {
        const rows = await db.many(
            'SELECT id, name, mime, size, message_id FROM codes_attachments WHERE task_id = $1 AND attempt_n = $2 ORDER BY created_at ASC, id ASC',
            [taskId, attemptN],
        );
        return rows.map(present);
    }

    async function forMessage(messageId) {
        const rows = await db.many(
            'SELECT id, name, mime, size, message_id FROM codes_attachments WHERE message_id = $1 ORDER BY created_at ASC, id ASC',
            [messageId],
        );
        return rows.map(present);
    }

    /** The bytes of one stored file by its id, for a route that has already checked who owns the task. */
    async function byId(id) {
        if (!/^fil_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id || ''))) return null;
        const row = await db.maybe('SELECT * FROM codes_attachments WHERE id = $1', [id]);
        if (!row) return null;
        return { id: row.id, name: row.name, mime: row.mime, buffer: Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data || '') };
    }

    /** The bytes of one message's file, owner-checked, for the download routes. */
    async function bytesForMessage(taskId, messageId, index, subject = null) {
        if (!/^msg_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(messageId || ''))) return null;
        const rows = await db.many(
            `SELECT * FROM codes_attachments WHERE task_id = $1 AND message_id = $2 ${subject ? 'AND subject = $3' : ''} ORDER BY created_at ASC, id ASC`,
            subject ? [taskId, messageId, subject] : [taskId, messageId],
        );
        const row = rows[Number(index)];
        if (!row) return null;
        return { name: row.name, mime: row.mime, buffer: Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data || '') };
    }

    return {
        save, saveMany, own, get, byId, remove, pending, link, forTask, forMessage, bytesForMessage, present,
        MAX_FILES, MAX_FILE_BYTES, MAX_MESSAGE_BYTES,
    };
}

/** The section of a turn's prompt that names the attachments and where they are. */
function promptSection(files, folder) {
    const list = Array.isArray(files) ? files.filter((f) => f && f.name) : [];
    if (!list.length) return '';
    const dir = SAFE_DIR.test(String(folder || '')) ? String(folder) : 'message';
    const lines = list.slice(0, MAX_FILES).map((f) => `- \`.openvibe/attachments/${dir}/${f.name}\`${f.mime ? ` (${f.mime}${f.size ? `, ${f.size} bytes` : ''})` : ''}`);
    return `\n\n---\n## Files the owner attached\n\n${lines.join('\n')}\n\nThey are files in this workspace; read them.`;
}

module.exports = {
    createAttachments, inspect, inspectMany, safeName, magicMime, promptSection,
    MAX_FILES, MAX_FILE_BYTES, MAX_MESSAGE_BYTES, BLOCKED_EXT, SAFE_DIR, imageMime,
};
