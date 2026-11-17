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
    const records = readFrom(file, lastBoundaryOffset(file)).filter(inChain);
    if (!records.length) throw new Error('the session has no conversation to carry');
    const withCwd = records.find((r) => typeof r.cwd === 'string');
    const last = records[records.length - 1];
    const sessionId = String((last && last.sessionId) || path.basename(file, '.jsonl'));
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
    const items = readFrom(file, 0);
    const meta = items.find((i) => i && i.type === 'session_meta') || {};
    const payload = meta.payload || {};
    const said = [];
    for (const i of items) {
        const p = i && i.payload;
        if (!p || i.type !== 'response_item' || p.type !== 'message' || !['user', 'assistant'].includes(p.role)) continue;
        const text = (Array.isArray(p.content) ? p.content : []).map((c) => c && (c.text || '')).join('\n').trim();
        if (text && !text.startsWith('<')) said.push({ role: p.role, text: text.slice(0, MAX_TEXT), at: i.timestamp || null });
    }
    const firstAsk = said.find((m) => m.role === 'user');
    return {
        format: FORMAT,
        harness: 'codex',
        session_id: String(payload.id || path.basename(file, '.jsonl')),
        title: String((firstAsk && firstAsk.text.split('\n')[0]) || 'An imported Codex session').slice(0, 200),
        source: { cwd: payload.cwd || null, git_branch: (payload.git && payload.git.branch) || null, version: payload.cli_version || null },
        started_at: payload.timestamp || null,
        updated_at: (items[items.length - 1] || {}).timestamp || null,
        counts: { records: items.length, messages: said.length },
        messages: said.slice(-MAX_PREVIEW),
        resume: null,
    };
}

module.exports = { FORMAT, slug, claudeSessionFile, claudeTail, lastBoundaryOffset, portable, placeClaude, codexSession, textOf };
