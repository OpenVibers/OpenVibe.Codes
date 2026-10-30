'use strict';

/**
 * A coding task's session in PostgreSQL (codes_session_lines): the job lines the session view reads, written as the
 * Run stream carries them, back-filled from the machine's final result log, and replayed by GET
 * /run/tasks/:id/session.json. The stream's own order is the seq, so a reconnect that replays the same events is a
 * no-op on (task_id, seq); a line is clipped to 64 KB with a marker and there is no total cap.
 *
 *   createSessionLines({ store, config, log })
 *     append(taskId, lines)                one INSERT … ON CONFLICT DO NOTHING per line
 *     recorder(taskId)                     push(text) / flush(): parses Run's output|state|end SSE frames
 *     backfill(row, result)                adds the final log's lines the stream missed, in content order
 *     backfillAndComplete(row, result)     backfill, then set run_tasks.session_complete_at
 *     linesForRow(row)                     the table's bodies, else the old result.log (tasks before this change)
 *     replay(row, { after, limit })        a page for the session.json route
 *     retention                            { runOnce, start, stop } (CODES_SESSION_RETENTION_DAYS, default 90)
 */
const { TERMINAL, sessionLogOf } = require('./run-tasks');
const redact = require('./redact');

const MAX_BODY_BYTES = 64 * 1024;
const CLIP_MARKER = '… [clipped]';
const PAGE_LIMIT = 500;
const SEQ_STRIDE = 250_000;     // one stream event's lines fit inside this (a 64 KB chunk has < 66k newlines); the
                                // column is bigint, so any event seq Run sends fits (an integer would stop at ~8 600)
const STATE_END_INDEX = 0;
const PARTIAL_LINE_INDEX = SEQ_STRIDE - 1;

const iso = (ms) => new Date(Number(ms)).toISOString();
const atIso = (value) => {
    const t = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** Every string in a JSON value, with the object/key that owns it, longest first. */
function stringSlots(value, out = [], seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return out;
    seen.add(value);
    if (Array.isArray(value)) {
        value.forEach((v, i) => (typeof v === 'string' ? out.push({ parent: value, key: i, value: v }) : stringSlots(v, out, seen)));
        return out;
    }
    for (const key of Object.keys(value)) {
        if (typeof value[key] === 'string') out.push({ parent: value, key, value: value[key] });
        else stringSlots(value[key], out, seen);
    }
    return out;
}

/**
 * A body no larger than 64 KB: the longest strings are cut and end in the marker. A body that cannot be made small
 * (thousands of short keys) becomes the small marker line instead, so a line never fails to store.
 */
function clipBody(body) {
    let value = body;
    if (value == null) value = { t: 'text', text: '' };
    else if (typeof value !== 'object') value = { t: 'text', text: String(value) };
    let json;
    try { json = JSON.stringify(value); } catch { return { t: 'note', level: 'warning', text: CLIP_MARKER, clipped: true }; }
    if (!json) json = '{}';
    if (Buffer.byteLength(json) <= MAX_BODY_BYTES) return value;
    let clone;
    try { clone = JSON.parse(json); } catch { return { t: 'note', level: 'warning', text: CLIP_MARKER, clipped: true }; }
    const slots = stringSlots(clone).sort((a, b) => b.value.length - a.value.length);
    let current = Buffer.byteLength(JSON.stringify(clone));
    for (let pass = 0; pass < 12 && current > MAX_BODY_BYTES; pass++) {
        let changed = false;
        for (const slot of slots) {
            if (current <= MAX_BODY_BYTES) break;
            const text = slot.parent[slot.key];
            if (typeof text !== 'string' || !text.length) continue;
            const over = current - MAX_BODY_BYTES;
            const perChar = Math.max(1, Buffer.byteLength(text) / text.length);
            const cut = Math.max(1, Math.ceil(over / perChar) + CLIP_MARKER.length);
            slot.parent[slot.key] = `${text.slice(0, Math.max(0, text.length - cut))}${CLIP_MARKER}`;
            current = Buffer.byteLength(JSON.stringify(clone));
            changed = true;
        }
        if (!changed) break;
    }
    if (current > MAX_BODY_BYTES) {
        const t = typeof clone.t === 'string' ? clone.t.slice(0, 40) : 'note';
        return { t, level: 'warning', text: CLIP_MARKER, clipped: true };
    }
    return clone;
}

/** The session line a raw stdout line becomes: the job's own JSON object when it parses, else the text itself. */
function lineOf(raw) {
    let body;
    try { body = JSON.parse(raw); } catch { body = null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'text', body: { t: 'text', text: raw } };
    const kind = typeof body.t === 'string' ? body.t : (typeof body.kind === 'string' ? body.kind : 'output');
    return { kind, body };
}

function createSessionLines({ store, config = {}, log = console }) {
    const db = store.db;
    const retentionDays = Math.max(1, Number(config.sessions && config.sessions.retentionDays) || 90);

    /** Insert lines in order; an existing (task_id, seq) wins, so a replay never duplicates. → rows inserted. */
    async function append(taskId, lines) {
        if (!taskId || !Array.isArray(lines) || !lines.length) return 0;
        const clean = [];
        for (const line of lines) {
            const seq = Number(line && line.seq);
            if (!Number.isSafeInteger(seq) || seq < 1) continue;
            const at = atIso(line.at) || store.iso();
            const kind = String(line.kind || 'text').slice(0, 64) || 'text';
            // The transcript normaliser: a run token (Codes C3) that an agent printed is redacted here, before the
            // line is kept, so it never reaches the transcript, the page or the log.
            clean.push({ seq, at, kind, body: clipBody(redact.scrubValue(line.body)) });
        }
        let inserted = 0;
        for (let i = 0; i < clean.length; i += 200) {
            const chunk = clean.slice(i, i + 200);
            const values = [];
            const params = [];
            chunk.forEach((line, j) => {
                const b = j * 5;
                values.push(`($${b + 1}, $${b + 2}, $${b + 3}::timestamptz, $${b + 4}, $${b + 5}::jsonb)`);
                params.push(taskId, line.seq, line.at, line.kind, JSON.stringify(line.body));
            });
            inserted += await db.exec(
                `INSERT INTO codes_session_lines (task_id, seq, at, kind, body) VALUES ${values.join(', ')}
                 ON CONFLICT (task_id, seq) DO NOTHING`, params);
        }
        return inserted;
    }

    /** All rows of a task in stream order. */
    async function allRows(taskId) {
        return await db.many('SELECT seq, at, kind, body FROM codes_session_lines WHERE task_id = $1 ORDER BY seq ASC', [taskId]);
    }

    /**
     * A recorder for the SSE proxy: push the decoded upstream text as it arrives, then flush. Output frames are split
     * into the job's JSON lines; state and end frames become their own lines. The stream's seq is the base, so the
     * same event replayed after a reconnect maps to the same rows.
     */
    function recorder(taskId) {
        let frameBuffer = '';
        let outputBuffer = '';
        let fallbackSeq = 0;
        let lastBase = 0;
        let ended = false;

        function baseOf(event) {
            const n = Number(event && event.seq);
            if (Number.isSafeInteger(n) && n >= 1 && n * SEQ_STRIDE <= Number.MAX_SAFE_INTEGER) lastBase = n * SEQ_STRIDE;
            else lastBase = (++fallbackSeq) * SEQ_STRIDE;
            return lastBase;
        }
        function recordsOf(frame) {
            const lines = String(frame).split('\n');
            let type = '';
            const data = [];
            for (const line of lines) {
                if (line.startsWith('event:')) type = line.slice(6).trim();
                else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            }
            if (!data.length) return [];
            let event;
            try { event = JSON.parse(data.join('\n')); } catch { return []; }
            if (!event || typeof event !== 'object') return [];
            const at = atIso(event.at) || store.iso();
            const kind = type || event.type;
            if (kind === 'output') {
                outputBuffer += String(event.chunk == null ? '' : event.chunk);
                const parts = outputBuffer.split('\n');
                outputBuffer = parts.pop();
                const base = baseOf(event);
                const out = [];
                parts.forEach((raw, i) => {
                    if (!raw.trim()) return;
                    const line = lineOf(raw);
                    out.push({ seq: base + i, at, kind: line.kind, body: line.body });
                });
                return out;
            }
            if (kind === 'state' || kind === 'end') {
                if (kind === 'end') ended = true;
                const state = event.state == null ? null : String(event.state);
                return [{ seq: baseOf(event) + STATE_END_INDEX, at, kind, body: { t: kind, state } }];
            }
            return [];
        }
        function drainFrames(out) {
            for (;;) {
                const i = frameBuffer.indexOf('\n\n');
                if (i < 0) break;
                const frame = frameBuffer.slice(0, i);
                frameBuffer = frameBuffer.slice(i + 2);
                out.push(...recordsOf(frame));
            }
        }
        return {
            async push(text) {
                frameBuffer = `${frameBuffer}${String(text == null ? '' : text)}`.replace(/\r\n/g, '\n');
                const out = [];
                drainFrames(out);
                if (out.length) await append(taskId, out);
            },
            async flush() {
                const out = [];
                drainFrames(out);
                if (frameBuffer.trim()) out.push(...recordsOf(frameBuffer));
                frameBuffer = '';
                if (outputBuffer !== '') {
                    const line = lineOf(outputBuffer);
                    out.push({ seq: (lastBase || 0) + PARTIAL_LINE_INDEX, at: store.iso(), kind: line.kind, body: line.body });
                    outputBuffer = '';
                }
                if (out.length) await append(taskId, out);
            },
            ended: () => ended,
        };
    }

    /**
     * Add the final log's lines the stream missed, in content order. Existing harness lines are matched by their
     * JSON, so a reconnect or a second result never adds a line twice; the new seqs sit after the streamed output and
     * before the terminal state/end line.
     */
    async function backfill(row, result) {
        if (!row || !row.id) return 0;
        const rows = await allRows(row.id);
        const harness = rows.filter((r) => r && r.body && typeof r.body === 'object' && !Array.isArray(r.body)
            && typeof r.body.t === 'string' && r.kind !== 'state' && r.kind !== 'end');
        const existing = harness.map((r) => JSON.stringify(r.body));
        const log = sessionLogOf({ result: result === undefined ? row.result : result }) || [];
        let cursor = 0;
        const missing = [];
        for (const body of log) {
            const text = JSON.stringify(body);
            let found = -1;
            for (let i = cursor; i < existing.length; i++) { if (existing[i] === text) { found = i; break; } }
            if (found >= 0) cursor = found + 1;
            else missing.push(body);
        }
        if (!missing.length) return 0;
        const used = new Set(rows.map((r) => Number(r.seq)));
        let start = harness.reduce((max, r) => Math.max(max, Number(r.seq) || 0), 0) + 1;
        while (used.has(start)) start++;
        const at = atIso(row.finished_at) || (row.updated_at ? iso(row.updated_at) : store.iso());
        return await append(row.id, missing.map((body, i) => ({
            seq: start + i, at, kind: typeof body.t === 'string' ? body.t : 'text', body,
        })));
    }

    async function complete(taskId) {
        return await db.exec(
            'UPDATE run_tasks SET session_complete_at = COALESCE(session_complete_at, $2::timestamptz) WHERE id = $1',
            [taskId, store.iso()],
        );
    }

    async function backfillAndComplete(row, result) {
        const inserted = await backfill(row, result);
        await complete(row.id);
        return inserted;
    }

    /** The bodies the session view replays: the table first, the old result.log for a task from before this change. */
    async function linesForRow(row) {
        if (!row || !row.id) return [];
        const rows = await allRows(row.id);
        const session = rows.filter((r) => r.kind !== 'state' && r.kind !== 'end').map((r) => r.body);
        if (session.length) return session;
        return sessionLogOf(row) || [];
    }

    /** One replay page (at most 500 lines after `after`), from the table or the old result.log. */
    async function replay(row, { after = 0, limit = PAGE_LIMIT } = {}) {
        const from = Math.max(0, Number.isSafeInteger(Number(after)) ? Number(after) : 0);
        const max = Math.min(PAGE_LIMIT, Math.max(1, Number.isSafeInteger(Number(limit)) ? Number(limit) : PAGE_LIMIT));
        const rows = await allRows(row.id);
        let lines;
        let source;
        if (rows.length) {
            source = 'session';
            lines = rows.filter((r) => Number(r.seq) > from).map((r) => ({ seq: Number(r.seq), at: r.at, kind: r.kind, body: r.body }));
        } else {
            source = 'result.log';
            const at = row.created_at ? iso(row.created_at) : store.iso();
            lines = (sessionLogOf(row) || []).map((body, i) => ({ seq: i + 1, at, kind: typeof body.t === 'string' ? body.t : 'text', body }))
                .filter((line) => line.seq > from);
        }
        const page = lines.slice(0, max);
        return {
            task_id: row.id,
            source,
            after: from,
            lines: page,
            next_after: page.length ? page[page.length - 1].seq : from,
            has_more: lines.length > max,
            complete: row.session_complete_at != null || TERMINAL.has(row.state),
        };
    }

    /** Delete the lines of tasks that finished more than CODES_SESSION_RETENTION_DAYS ago (default 90). */
    async function retentionOnce() {
        const cutoff = new Date(store.now() - retentionDays * 86_400_000).toISOString();
        return await db.exec(
            `DELETE FROM codes_session_lines WHERE task_id IN (
                SELECT id FROM run_tasks
                WHERE state = ANY($1)
                  AND COALESCE(finished_at, to_timestamp(updated_at / 1000.0)) < $2::timestamptz
            )`, [[...TERMINAL], cutoff]);
    }

    let running = false;
    let timer = null;
    const retention = {
        days: retentionDays,
        runOnce: async () => {
            if (running) return 0;
            running = true;
            try { return await retentionOnce(); } catch (err) { log.warn(`[Codes] session retention failed: ${err.message}`); return 0; } finally { running = false; }
        },
        start() {
            if (timer || config.drill) return false;
            const jobs = require('../utils/jobs');
            const every = jobs.every('codes-session-retention', (Number(config.sessions && config.sessions.retentionIntervalMs) || 86_400_000), () => retention.runOnce(), { initialDelayMs: 60_000, jitterMs: 60_000, log });
            timer = every;
            return true;
        },
        stop() { if (timer) timer(); timer = null; },
    };

    return {
        MAX_BODY_BYTES, retentionDays, append, allRows, recorder, backfill, backfillAndComplete, complete,
        linesForRow, replay, retention, clipBody,
    };
}

module.exports = { createSessionLines, clipBody, lineOf, MAX_BODY_BYTES, CLIP_MARKER, PAGE_LIMIT, SEQ_STRIDE };
