'use strict';

/**
 * Portable sessions (plan §AD.22, conversation.import@1): a coding agent's saved session, made small enough to carry,
 * and placed on another machine so the agent there resumes it with its own `--resume`.
 *
 * The owner, 2026-11-17: "finish implementing the session/conversation import system so I can run this via openvibe
 * codes rather than here". Claude Code keeps a session as JSONL in `<config>/projects/<cwd slug>/<id>.jsonl`, with no
 * export of its own. The file holds every request too (this session's was 3.79 GB), but resuming needs only the
 * conversation since its last compaction (1,736 lines, about 6 MB): the compaction's boundary, its summary, and every
 * message after it. Records outside the conversation's chain (request records, blobs, links, mode switches: the ones
 * with no `uuid`) stay behind.
 *
 *   claudeSessionFile({ configDir, cwd, session })   → the newest session for a folder, or a named one
 *   claudeTail(file)                                 → { meta, records }: the resumable tail of a session file
 *   portable(records, meta, { title })               → conversation.import@1
 *   placeClaude(doc, { configDir, cwd })             → the file written: the records with the folder moved to cwd
 *   codexSession(file)                               → conversation.import@1 to read (Codex resumes through its own
 *                                                      index, so a Codex session is shown and handed over, not resumed)
 *   slug(cwd)                                        → Claude Code's folder name for a working directory
 *
 * Claude Code's format is its own and changes between versions: only what a resume needs is relied on (one JSON object
 * a line; `type`, `uuid`, `parentUuid`, `sessionId`, `cwd`; a `system` record with `subtype: "compact_boundary"`).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORMAT = 'conversation.import@1';
/** A record a resume reads is one in the conversation's chain: it has a `uuid` (user, assistant, system, attachment,
 * summary …). Records without one (request records, blobs, links, mode switches) are bookkeeping the new machine makes
 * again. Dropping a chained record would cut the chain the resume walks back along `parentUuid`. */
const inChain = (r) => r && typeof r.uuid === 'string';
const MAX_PREVIEW = 40;
const MAX_TEXT = 2000;

/** Claude Code's folder name for a working directory: every character that is not a letter or digit becomes '-'; a
 * name over 200 characters is cut and given a hash of the whole path. */
function slug(cwd) {
    const name = String(cwd).replace(/[^A-Za-z0-9]/g, '-');
    if (name.length <= 200) return name;
    const hash = crypto.createHash('sha256').update(String(cwd)).digest('hex').slice(0, 8);
    return `${name.slice(0, 200)}-${hash}`;
}

/** The newest `*.jsonl` session for a folder (or the one named `session`), or null. */
function claudeSessionFile({ configDir, cwd, session = null } = {}) {
    const dir = path.join(configDir, 'projects', slug(cwd));
    if (session) {
        if (!/^[A-Za-z0-9-]{8,80}$/.test(String(session))) throw new Error('a session id is letters, digits and dashes');
        const file = path.join(dir, `${session}.jsonl`);
        return fs.existsSync(file) ? file : null;
    }
    let best = null;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return null; }
    for (const name of names) {
        if (!/^[A-Za-z0-9-]+\.jsonl$/.test(name)) continue;
        const file = path.join(dir, name);
        const st = fs.statSync(file);
        if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs };
    }
    return best && best.file;
}

/**
 * Where the last compaction starts in a file, read backwards in chunks (a session file can be gigabytes): the byte
 * offset of the last line that is a `system` record with `subtype: "compact_boundary"`, or 0 when the session was never
 * compacted. A line that only mentions the word (a message about it) is checked and passed over.
 */
function lastBoundaryOffset(file, { chunk = 4 * 1024 * 1024 } = {}) {
    const fd = fs.openSync(file, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        const needle = Buffer.from('"compact_boundary"');
        let end = size;
        while (end > 0) {
            const start = Math.max(0, end - chunk);
            // The chunk plus the rest of its last line, so a line cut by the chunk edge is read whole.
            let tailEnd = end;
            const probe = Buffer.alloc(Math.min(1024 * 1024, size - end));
            if (probe.length) {
                fs.readSync(fd, probe, 0, probe.length, end);
                const nl = probe.indexOf(0x0a);
                tailEnd = end + (nl >= 0 ? nl : probe.length);
            }
            const hay = Buffer.alloc(tailEnd - start);
            fs.readSync(fd, hay, 0, hay.length, start);
            let at = hay.length;
            while ((at = hay.lastIndexOf(needle, at - 1)) >= 0) {
                const lineStart = hay.lastIndexOf(0x0a, at) + 1;
                let lineEnd = hay.indexOf(0x0a, at);
                if (lineEnd < 0) lineEnd = hay.length;
                if (lineStart === 0 && start > 0) break;      // the line begins in an earlier chunk: read it from there
                try {
                    const r = JSON.parse(hay.subarray(lineStart, lineEnd).toString('utf8'));
                    if (r && r.type === 'system' && r.subtype === 'compact_boundary') return start + lineStart;
                } catch { /* not a whole record */ }
                if (lineStart === 0) break;
                at = lineStart;
            }
            // The next window ends where this one's first whole line begins: the line that crosses `start` is read whole
            // there, and nothing after it is read twice.
            const firstNl = hay.indexOf(0x0a);
            const next = start === 0 ? 0 : firstNl >= 0 ? start + firstNl + 1 : start;
            end = next >= end ? start : next;
        }
        return 0;
    } finally {
        fs.closeSync(fd);
    }
}

/** At most this much is read for a session that was never compacted. */
const MAX_UNCOMPACTED = 256 * 1024 * 1024;

/** The records from a byte offset to the end, one JSON object a line (a broken line is skipped). */
function readFrom(file, offset) {
    const fd = fs.openSync(file, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        if (size - offset > MAX_UNCOMPACTED) throw new Error(`the session is ${Math.round((size - offset) / 1048576)} MB since its last compaction: compact it first (/compact), then import it`);
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        const out = [];
        for (const line of buf.toString('utf8').split('\n')) {
            if (!line.trim()) continue;
            try { out.push(JSON.parse(line)); } catch { /* a line cut by a crash: not conversation */ }
        }
        return out;
    } finally {
        fs.closeSync(fd);
    }
}

/** The resumable tail of a Claude Code session file: { meta, records }. */
function claudeTail(file) {
    return tailOf(readFrom(file, lastBoundaryOffset(file)), path.basename(file, '.jsonl'));
}

/** The lines of a JSONL text as records (a broken line is skipped). */
function linesOf(text) {
    const out = [];
    for (const line of String(text).split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* a line cut by a crash, or by the page's slice: not conversation */ }
    }
    return out;
}

/**
 * The resumable tail of a Claude Code session given as text (an upload: the whole file, or the page's slice of it from
 * its last compaction): the records from the last compaction boundary on. → { meta, records }
 */
function claudeTailText(text, { name = null } = {}) {
    const all = linesOf(text);
    let from = 0;
    for (let i = all.length - 1; i >= 0; i--) {
        if (all[i] && all[i].type === 'system' && all[i].subtype === 'compact_boundary') { from = i; break; }
    }
    return tailOf(all.slice(from), name ? String(name).replace(/\.jsonl$/, '') : null);
}

function tailOf(all, fallbackId) {
    const records = all.filter(inChain);
    if (!records.length) throw new Error('the session has no conversation to carry');
    const withCwd = records.find((r) => typeof r.cwd === 'string');
    const last = records[records.length - 1];
    const sessionId = String((last && last.sessionId) || fallbackId || 'session');
    return {
        meta: {
            harness: 'claude-code',
            session_id: sessionId,
            cwd: withCwd ? withCwd.cwd : null,
            git_branch: (records.find((r) => r.gitBranch) || {}).gitBranch || null,
            version: (records.find((r) => r.version) || {}).version || null,
            started_at: records[0].timestamp || null,
            updated_at: last.timestamp || null,
        },
        records,
    };
}

/** The words of one message: its text blocks (tool calls and results are named, not copied). */
function textOf(message) {
    if (!message) return '';
    const c = message.content;
    if (typeof c === 'string') return c;
    if (!Array.isArray(c)) return '';
    return c.map((b) => (b && b.type === 'text' ? b.text : b && b.type === 'tool_use' ? `[${b.name}]` : '')).filter(Boolean).join('\n');
}

/** conversation.import@1 from a session's records. */
function portable(records, meta, { title = null } = {}) {
    const said = records.filter((r) => (r.type === 'user' || r.type === 'assistant') && r.message)
        .map((r) => ({ role: r.type, text: textOf(r.message).trim().slice(0, MAX_TEXT), at: r.timestamp || null }))
        .filter((m) => m.text && !m.text.startsWith('<'));
    const firstAsk = said.find((m) => m.role === 'user');
    return {
        format: FORMAT,
        harness: meta.harness,
        session_id: meta.session_id,
        title: String(title || (firstAsk && firstAsk.text.split('\n')[0]) || 'An imported session').slice(0, 200),
        source: { cwd: meta.cwd, git_branch: meta.git_branch, version: meta.version },
        started_at: meta.started_at,
        updated_at: meta.updated_at,
        counts: { records: records.length, messages: said.length },
        messages: said.slice(-MAX_PREVIEW),
        resume: { harness: meta.harness, records },
    };
}

/** Moves a path under the session's old folder to the new one. */
function moved(value, from, to) {
    if (typeof value !== 'string' || !from) return value;
    if (value === from) return to;
    return value.startsWith(`${from}/`) ? to + value.slice(from.length) : value;
}

/**
 * Writes a portable Claude Code session where the agent on this machine finds it: `<configDir>/projects/<slug(cwd)>/
 * <session>.jsonl`, each record's folder moved from the old machine's to `cwd`. → the file's path.
 */
function placeClaude(doc, { configDir, cwd }) {
    if (!doc || doc.format !== FORMAT || doc.harness !== 'claude-code' || !doc.resume || !Array.isArray(doc.resume.records)) {
        throw new Error('not a portable Claude Code session');
    }
    if (!/^[A-Za-z0-9-]{8,80}$/.test(String(doc.session_id))) throw new Error('the session id is not one Claude Code makes');
    if (!path.isAbsolute(cwd)) throw new Error('the folder must be an absolute path');
    const from = doc.source && doc.source.cwd;
    const dir = path.join(configDir, 'projects', slug(cwd));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${doc.session_id}.jsonl`);
    const lines = doc.resume.records.map((r) => JSON.stringify({ ...r, ...(typeof r.cwd === 'string' ? { cwd: moved(r.cwd, from, cwd) } : {}) }));
    fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
    return file;
}

/** A Codex rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) as conversation.import@1 to read. */
function codexSession(file) {
    return codexDoc(readFrom(file, 0), path.basename(file, '.jsonl'));
}

/** A Codex rollout given as text. */
function codexSessionText(text, { name = null } = {}) {
    return codexDoc(linesOf(text), name ? String(name).replace(/\.jsonl$/, '') : 'codex');
}

function codexDoc(items, fallbackId) {
    const meta = items.find((i) => i && i.type === 'session_meta') || {};
    const payload = meta.payload || {};
    const said = [];
    for (const i of items) {
        const p = i && i.payload;
        if (!p || i.type !== 'response_item' || p.type !== 'message' || !['user', 'assistant'].includes(p.role)) continue;
        const text = (Array.isArray(p.content) ? p.content : []).map((c) => c && (c.text || '')).join('\n').trim();
        if (text && !text.startsWith('<')) said.push({ role: p.role, text: text.slice(0, MAX_TEXT), at: i.timestamp || null });
    }
    return handover('codex', said, {
        session_id: payload.id || fallbackId, title: 'An imported Codex session',
        source: { cwd: payload.cwd || null, git_branch: (payload.git && payload.git.branch) || null, version: payload.cli_version || null },
        started_at: payload.timestamp || null, updated_at: (items[items.length - 1] || {}).timestamp || null, records: items.length,
    });
}

// ── Sessions that are read and handed over (every harness but Claude Code) ─────────────────────────────────────────
// Only Claude Code's own --resume takes a carried session whole. Any other agent's conversation travels as its
// messages: the page shows them, and "Continue" starts a conductor that gets the whole conversation as a hand-over
// file to read first (server/http/c4.js). `transcript` is every message (each clipped), `messages` the last ones.

const MAX_TRANSCRIPT_TEXT = 8000;
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const SAFE_ID = /[^A-Za-z0-9._-]/g;

/** conversation.import@1 to read and hand over, from a harness's messages ({ role, text, at }). */
function handover(harness, said, { session_id, title, source = {}, started_at = null, updated_at = null, records = null }) {
    const clean = said.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: String(m.text || '').trim(), at: m.at || null })).filter((m) => m.text);
    const firstAsk = clean.find((m) => m.role === 'user');
    const transcript = [];
    let bytes = 0;
    for (let i = clean.length - 1; i >= 0; i--) {         // the newest first, so a cut keeps the end of the conversation
        const m = { ...clean[i], text: clean[i].text.slice(0, MAX_TRANSCRIPT_TEXT) };
        bytes += m.text.length + 40;
        if (bytes > MAX_TRANSCRIPT_BYTES) break;
        transcript.unshift(m);
    }
    let id = String(session_id || '').replace(SAFE_ID, '-').slice(0, 100);
    if (id.length < 4) id = `${harness}-${crypto.createHash('sha256').update(JSON.stringify(clean.slice(0, 3))).digest('hex').slice(0, 16)}`;
    return {
        format: FORMAT,
        harness,
        session_id: id,
        title: String((firstAsk && firstAsk.text.split('\n')[0].replace(/^#+\s*/, '')) || title).slice(0, 200),
        source: { cwd: source.cwd || null, git_branch: source.git_branch || null, version: source.version || null },
        started_at, updated_at,
        counts: { records: records == null ? clean.length : records, messages: clean.length },
        messages: clean.slice(-MAX_PREVIEW).map((m) => ({ ...m, text: m.text.slice(0, MAX_TEXT) })),
        transcript,
        resume: null,
    };
}

/** The words of a Gemini message's content: a string, a Part, or a list of Parts ({ text }). */
function geminiText(content) {
    if (typeof content === 'string') return content;
    const parts = Array.isArray(content) ? content : content && typeof content === 'object' ? (Array.isArray(content.parts) ? content.parts : [content]) : [];
    return parts.map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' && !p.thought ? p.text : p && p.functionCall ? `[${p.functionCall.name}]` : '')).filter(Boolean).join('\n');
}

/**
 * A Gemini CLI conversation as conversation.import@1 to read: its saved session (`~/.gemini/tmp/<project hash>/chats/
 * session-*.json`: { sessionId, startTime, lastUpdated, messages: [{ type: user|gemini|…, content }] }) or a checkpoint
 * that `/chat save` wrote (a list of { role: user|model, parts }).
 */
function geminiSession(value, { name = null } = {}) {
    let said = [];
    let meta = {};
    if (Array.isArray(value)) {
        said = value.filter((c) => c && (c.role === 'user' || c.role === 'model'))
            .map((c) => ({ role: c.role === 'model' ? 'assistant' : 'user', text: geminiText(c.parts) }));
    } else if (value && Array.isArray(value.messages)) {
        meta = value;
        said = value.messages.filter((m) => m && (m.type === 'user' || m.type === 'gemini' || m.type === 'model'))
            .map((m) => ({ role: m.type === 'user' ? 'user' : 'assistant', text: geminiText(m.content), at: m.timestamp || null }));
    } else throw new Error('not a Gemini CLI session');
    return handover('gemini', said.filter((m) => m.text && !m.text.startsWith('<')), {
        session_id: meta.sessionId || (name ? String(name).replace(/\.json$/, '') : null), title: 'An imported Gemini CLI session',
        started_at: meta.startTime || null, updated_at: meta.lastUpdated || null,
    });
}

/** The newest Gemini CLI session for a folder (its project hash is the folder's sha256), else the newest anywhere. */
function geminiSessionFile({ home, cwd }) {
    const tmp = path.join(home, '.gemini', 'tmp');
    const newest = (dirs) => {
        let best = null;
        for (const dir of dirs) {
            let names = [];
            try { names = fs.readdirSync(dir); } catch { continue; }
            for (const n of names) {
                if (!/^session-.*\.json$/.test(n)) continue;
                const file = path.join(dir, n);
                const st = fs.statSync(file);
                if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs };
            }
        }
        return best;
    };
    const own = newest([path.join(tmp, crypto.createHash('sha256').update(String(cwd)).digest('hex'), 'chats')]);
    if (own) return own;
    let projects = [];
    try { projects = fs.readdirSync(tmp); } catch { return null; }
    return newest(projects.map((d) => path.join(tmp, d, 'chats')));
}

/** An OpenCode session as `opencode export <session>` writes it: { info, messages: [{ info: { role }, parts }] }. */
function opencodeExport(value) {
    if (!value || !Array.isArray(value.messages)) throw new Error('not an OpenCode export');
    const info = value.info || {};
    const said = value.messages.map((m) => {
        const role = (m && m.info && m.info.role) || (m && m.role);
        const parts = (m && Array.isArray(m.parts)) ? m.parts : [];
        const text = parts.map((p) => (p && p.type === 'text' && typeof p.text === 'string' && !p.synthetic ? p.text : p && p.type === 'tool' ? `[${p.tool || 'tool'}]` : '')).filter(Boolean).join('\n');
        const at = m && m.info && m.info.time && m.info.time.created ? new Date(m.info.time.created).toISOString() : null;
        return { role: role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : null, text, at };
    }).filter((m) => m.role && m.text);
    return handover('opencode', said, {
        session_id: info.id, title: info.title || 'An imported OpenCode session', source: { cwd: info.directory || null, version: info.version || null },
        started_at: info.time && info.time.created ? new Date(info.time.created).toISOString() : null,
        updated_at: info.time && info.time.updated ? new Date(info.time.updated).toISOString() : null,
    });
}

/**
 * A hand-over any agent can write (Markdown or plain text): turns under headings or prefixes that name the speaker
 * ("## User" / "## Assistant", "User:" / "Assistant:", "Human:", "AI:" …); text with none is one hand-over message.
 */
function handoverText(text, { name = null } = {}) {
    const body = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!body) throw new Error('the hand-over is empty');
    const said = [];
    const NAMES = 'user|human|owner|assistant|ai|agent|claude|codex|gemini|model';
    const heading = new RegExp(`^#{1,6}\\s*(${NAMES})\\s*:?\\s*$`, 'i');           // "## User"
    const bold = new RegExp(`^\\*\\*(${NAMES})\\*\\*\\s*:?\\s*(.*)$`, 'i');      // "**Assistant:** text"
    const prefix = new RegExp(`^(${NAMES})\\s*:\\s*(.*)$`, 'i');                  // "User: text"
    let cur = null;
    for (const line of body.split('\n')) {
        const t = line.trim();
        const m = heading.exec(t) || bold.exec(t) || prefix.exec(t);
        if (m) {
            if (cur) said.push(cur);
            const who = m[1].toLowerCase();
            cur = { role: ['user', 'human', 'owner'].includes(who) ? 'user' : 'assistant', text: m[2] || '' };
        } else if (cur) cur.text += `\n${line}`;
        else cur = { role: 'user', text: line };
    }
    if (cur) said.push(cur);
    const turns = said.length > 1 ? said : [{ role: 'user', text: body }];
    const doc = handover('handover', turns, { session_id: name ? `handover-${String(name).replace(/\.(md|txt|markdown)$/i, '')}` : null, title: 'A conversation handed over' });
    if (said.length <= 1) doc.title = String(body.split('\n').find((l) => l.trim()) || 'A conversation handed over').replace(/^#+\s*/, '').slice(0, 200);
    return doc;
}

/**
 * Any session file's text, recognised by what it holds: a conversation.import@1 document, a Claude Code session
 * (JSONL with uuid and sessionId), a Codex rollout (JSONL with session_meta), a Gemini CLI session or checkpoint, an
 * OpenCode export, else a hand-over in Markdown or plain text. → conversation.import@1
 */
function fromText(text, { name = null, title = null } = {}) {
    const body = String(text || '');
    const trimmed = body.trim();
    let doc = null;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        let value;
        try { value = JSON.parse(trimmed); } catch { value = undefined; }
        if (value !== undefined) {
            if (value && value.format === FORMAT) doc = value;
            else if (value && !Array.isArray(value) && value.info && Array.isArray(value.messages)) doc = opencodeExport(value);
            else if (Array.isArray(value) || (value && Array.isArray(value.messages))) doc = geminiSession(value, { name });
        }
    }
    if (!doc && (trimmed.startsWith('{'))) {
        const first = linesOf(body.slice(0, 2 * 1024 * 1024)).slice(0, 50);
        if (first.some((r) => r && r.type === 'session_meta')) doc = codexSessionText(body, { name });
        else if (first.some((r) => r && typeof r.uuid === 'string' && typeof r.sessionId === 'string')) {
            const { meta, records } = claudeTailText(body, { name });
            doc = portable(records, meta);
        }
    }
    if (!doc) doc = handoverText(body, { name });
    if (title) doc.title = String(title).slice(0, 200);
    return doc;
}

/** The newest Codex rollout, preferring one that ran in `cwd`; null when there is none. */
function codexSessionFile({ home, cwd = null }) {
    const root = path.join(home, '.codex', 'sessions');
    const files = [];
    const walk = (dir, depth) => {
        let names = [];
        try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const d of names) {
            const p = path.join(dir, d.name);
            if (d.isDirectory() && depth < 3) walk(p, depth + 1);
            else if (d.isFile() && /^rollout-.*\.jsonl$/.test(d.name)) files.push({ file: p, mtimeMs: fs.statSync(p).mtimeMs });
        }
    };
    walk(root, 0);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (cwd) {
        for (const f of files.slice(0, 20)) {
            try {
                const fd = fs.openSync(f.file, 'r');
                const head = Buffer.alloc(64 * 1024);
                const n = fs.readSync(fd, head, 0, head.length, 0);
                fs.closeSync(fd);
                const meta = linesOf(head.subarray(0, n).toString('utf8')).find((r) => r && r.type === 'session_meta');
                if (meta && meta.payload && meta.payload.cwd === cwd) return f;
            } catch { /* unreadable: the next */ }
        }
    }
    return files[0] || null;
}

module.exports = {
    FORMAT, slug, claudeSessionFile, claudeTail, claudeTailText, lastBoundaryOffset, portable, placeClaude, codexSession, codexSessionText,
    codexSessionFile, geminiSession, geminiSessionFile, opencodeExport, handoverText, fromText, handover, textOf, linesOf,
};
