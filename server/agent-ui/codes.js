'use strict';
const { createRunStream } = require('./service');
const { TERMINAL } = require('../domain/run-tasks');
const { scrubValue } = require('../domain/redact');
const { scrub } = require('../../harness/events');
const { scrub: scrubJob } = require('../../harness/job');
function clean(v) {
    if (typeof v === 'string') return scrubJob(scrub(v));
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(scrubValue(v)).map(([k, x]) => [k, /^(password|secret|authorization|api_key|access_token)$/i.test(k) ? '[redacted]' : clean(x)]));
    return v;
}
function createCodesRuns({ store, fallback }) {
    const stream = createRunStream({ store, product: 'codes', clean, fallback, read: async (id, after, selected) => {
        const row = await store.db.maybe('SELECT * FROM run_tasks WHERE id = $1', [id]);
        const lines = await store.db.many("SELECT seq, at, body, attempt_n, full_output FROM codes_session_lines WHERE task_id = $1 AND seq > $2 AND kind NOT IN ('state', 'end') AND ($3::integer IS NULL OR attempt_n = $3) ORDER BY seq LIMIT 500", [id, after, selected.run_attempt || null]);
        const pending = await store.db.maybe("SELECT id FROM codes_attempts WHERE task_id = $1 AND state IN ('queued', 'running') LIMIT 1", [id]);
        const attempt = selected.run_attempt ? await store.db.maybe('SELECT state FROM codes_attempts WHERE task_id = $1 AND n = $2', [id, selected.run_attempt]) : null;
        return { items: lines.map((l) => ({ seq: l.seq, at: l.at, line: { ...(typeof l.body === 'string' ? JSON.parse(l.body) : l.body), attempt: l.attempt_n, ...(l.full_output != null ? { output: l.full_output } : {}) } })),
            ended: lines.length < 500 && row && !!row.session_complete_at && (attempt ? ['done', 'failed', 'stopped', 'budget-stopped', 'interrupted'].includes(attempt.state) : TERMINAL.has(row.state) && !pending),
            ok: attempt ? attempt.state === 'done' : row && row.state === 'succeeded', endedAt: row && row.updated_at };
    } });
    const resolve = async (row, n) => {
        const attempt = n ? await store.db.maybe('SELECT n, created_at FROM codes_attempts WHERE task_id = $1 AND n = $2', [row.id, n])
            : await store.db.maybe('SELECT n, created_at FROM codes_attempts WHERE task_id = $1 ORDER BY n DESC LIMIT 1', [row.id]);
        if (n && !attempt) return null;
        return attempt ? { ...row, run_id: `${row.id}~${attempt.n}`, run_attempt: Number(attempt.n), started_at: attempt.created_at } : row;
    };
    return { ...stream, resolve };
}
module.exports = { createCodesRuns, clean };
