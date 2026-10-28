'use strict';

/**
 * Coding tasks on a person's own machine (run_tasks, plan T16): what the /run pages (server/http/run.js) and the
 * service API (server/http/tasks-api.js, codes.task.*) share.
 *
 *   createRunTasks({ store, run, config, log, sessions, outbox })
 *     start({ subject, project, args, via, key }) → the row: queued (Run took the job) or failed (Run's reason)
 *     refresh(row, { force })                     → the row, read from Run only as a fallback after 10 quiet minutes
 *     applyEvent(row, event)                      → a run.job.* delivery: state, timings, result, event, in one tx
 *     latestProject(subject)                      → the project of the person's latest task, or null
 *     present(row)                                → codes.task@1
 *   TERMINAL, STATE_LABEL, STALE_MS
 *
 * Every state change writes its codes.task.* outbox row in the same transaction; a terminal state also back-fills
 * the session's missing lines and marks it complete. A task's result comes from the person's machine: present() passes
 * on only the contract's fields, each checked and cut to its limit.
 */
const { RunError } = require('./run-client');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const STATE_LABEL = {
    queued: 'Waiting for your machine', placed: 'Sent to your machine', running: 'Running', succeeded: 'Finished',
    failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired (no machine took it in time)',
};
const STATES = new Set(Object.keys(STATE_LABEL));
const RANK = { queued: 0, placed: 1, running: 2, succeeded: 3, failed: 3, cancelled: 3, expired: 3 };
/** A non-terminal task is read from Run at most once after this long without an event (the fallback, not polling). */
const STALE_MS = 10 * 60_000;

const iso = (ms) => new Date(Number(ms)).toISOString();
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const httpsUrl = (v) => {
    if (typeof v !== 'string' || v.length > 2000) return undefined;
    try { return new URL(v).protocol === 'https:' ? v : undefined; } catch { return undefined; }
};
const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const asObject = (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); return p && typeof p === 'object' && !Array.isArray(p) ? p : null; } catch { return null; } }
    return null;
};

/** The job's result document (harness/job.js) as codes.task@1's `result`, or undefined. */
function presentResult(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return undefined;
    const files = Array.isArray(d.files) ? d.files.slice(0, 2000).filter((f) => f && typeof f.path === 'string' && f.path)
        .map((f) => ({ path: f.path.slice(0, 500), added: count(f.added), removed: count(f.removed) })) : undefined;
    const p = d.push && typeof d.push === 'object' ? drop({
        pushed: d.push.pushed === true, branch: str(d.push.branch, 200), branch_url: httpsUrl(d.push.branch_url),
        pull_request: httpsUrl(d.push.pull_request), pull_request_error: str(d.push.pull_request_error, 500), reason: str(d.push.reason, 500),
    }) : undefined;
    return drop({
        ok: d.ok === true,
        agents: Array.isArray(d.agents) ? d.agents.filter((a) => typeof a === 'string').slice(0, 20).map((a) => a.slice(0, 41)) : undefined,
        summary: str(d.summary, 4000),
        files,
        patch: str(d.patch, 262144),
        patch_truncated: d.patch_truncated === true || (typeof d.patch === 'string' && d.patch.length > 262144) ? true : undefined,
        push: p,
        cost_usd: typeof d.cost_usd === 'number' && Number.isFinite(d.cost_usd) && d.cost_usd >= 0 ? d.cost_usd : undefined,
        duration_ms: Number.isInteger(d.duration_ms) && d.duration_ms >= 0 ? d.duration_ms : undefined,
        error: str(d.error, 1000),
    });
}

// The job lines a session log may hold (harness/job.js, lines 1.1; openvibe-shared/agent-session.js reads them).
const LINE_KINDS = new Set(['agent', 'text', 'tool', 'tool_progress', 'tool_result', 'handoff', 'note', 'usage', 'done', 'step']);
/**
 * The session a finished task's result keeps (`log`), for its page: the lines whose kind is known, at most 4000, each a
 * plain object no larger than 20 KB. Not part of codes.task@1 (the API passes the result's contract fields only).
 */
function sessionLogOf(row) {
    let d = row && row.result;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return null; } }
    if (!d || !Array.isArray(d.log)) return null;
    const lines = d.log.filter((l) => l && typeof l === 'object' && !Array.isArray(l) && LINE_KINDS.has(l.t) && JSON.stringify(l).length <= 20000).slice(0, 4000);
    return lines.length ? lines : null;
}

function errorOf(job) {
    if (!job || !job.error) return null;
    if (typeof job.error === 'string') return job.error.slice(0, 1000);
    return `${job.error.code || 'run.error'}${job.error.detail ? `: ${job.error.detail}` : ''}`.slice(0, 1000);
}

function createRunTasks({ store, run, config, log = console, sessions = null, outbox = null }) {
    const db = store.db;
    const who = (row) => ({ subject: row.subject, project: row.project_id });
    // Lazily, so a caller that only reads tasks does not need the session/outbox modules (and there is no cycle).
    const sessionLines = sessions || require('./session-lines').createSessionLines({ store, config, log });
    const taskOutbox = outbox || require('../events/outbox').createOutbox({ store, log });

    /**
     * One state change: update the row, write its codes.task.* outbox row in the same transaction, and on a terminal
     * state reconcile the session with the result and mark it complete. A late or out-of-order state never moves a
     * task backwards, and a terminal state is final.
     */
    async function recordState(row, next) {
        const state = STATES.has(next && next.state) ? next.state : null;
        if (!state || !row || !row.id) return row;
        return await store.tx(async () => {
            const current = await db.maybe('SELECT * FROM run_tasks WHERE id = $1 FOR UPDATE', [row.id]);
            if (!current) return row;
            if (RANK[state] < RANK[current.state]) return current;
            if (TERMINAL.has(current.state) && current.state !== state) return current;
            const changed = current.state !== state;
            const startedAt = next.startedAt || (next.job && next.job.timings && next.job.timings.started_at) || null;
            const finishedAt = next.finishedAt || (next.job && next.job.timings && next.job.timings.finished_at) || (TERMINAL.has(state) ? store.iso() : null);
            const result = next.result === undefined ? null : next.result;
            const error = next.error === undefined ? null : next.error;
            const updated = await db.one(
                `UPDATE run_tasks SET state = $2,
                    result = COALESCE($3::jsonb, result),
                    error = COALESCE($4, error),
                    started_at = COALESCE($5::timestamptz, started_at),
                    finished_at = COALESCE($6::timestamptz, finished_at),
                    updated_at = $7
                 WHERE id = $1 RETURNING *`,
                [current.id, state, result == null ? null : JSON.stringify(result), error, startedAt, finishedAt, store.now()],
            );
            if (changed) await taskOutbox.emitTask(updated, current.state);
            if (TERMINAL.has(updated.state) && !updated.session_complete_at) {
                await sessionLines.backfillAndComplete(updated, updated.result);
            }
            return updated;
        });
    }

    async function start({ subject, project, args, via = null, key = null, actorRef = null }) {
        const id = store.newId('tsk');
        const at = store.now();
        const actorRefValue = actorRef && typeof actorRef === 'object' && !Array.isArray(actorRef) ? JSON.stringify(actorRef) : null;
        await store.tx(async () => {
            const inserted = await db.one(`INSERT INTO run_tasks (id, subject, project_id, repo, ref, prompt, agent, push, pull_request, state, via, idempotency_key, actor_ref, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10, $11, $12::jsonb, $13, $13) RETURNING *`,
            [id, subject, project, args.repo, args.ref, args.prompt, args.agent, !!args.push, !!(args.push && args.push.pull_request), via, key, actorRefValue, at]);
            await taskOutbox.emitTask(inserted, null);
            return inserted;
        });
        let job;
        try {
            job = await run.submit({ subject, project, args, key: id });
        } catch (e) {
            const why = e instanceof RunError ? `${e.code}: ${e.message}` : e.message;
            return await store.tx(async () => {
                const failed = await db.one(`UPDATE run_tasks SET state = 'failed', error = $2, finished_at = $3::timestamptz, updated_at = $4
                    WHERE id = $1 RETURNING *`, [id, why, store.iso(), store.now()]);
                await taskOutbox.emitTask(failed, 'queued');
                return failed;
            });
        }
        return await store.tx(async () => {
            const state = STATES.has(job.state) ? job.state : 'queued';
            const startedAt = job.timings && job.timings.started_at ? job.timings.started_at : null;
            const updated = await db.one(`UPDATE run_tasks SET job_id = $2, state = $3, started_at = COALESCE($4::timestamptz, started_at), updated_at = $5
                WHERE id = $1 RETURNING *`, [id, job.id, state, startedAt, store.now()]);
            await taskOutbox.emitTask(updated, 'queued');
            return updated;
        });
    }

    /** A Run job document (run.job-read-result@1) as the task row. */
    async function applyJob(row, job) {
        if (!job || !STATES.has(job.state)) return row;
        const result = TERMINAL.has(job.state) ? (asObject(job.result) || null) : undefined;
        return await recordState(row, {
            state: job.state,
            result,
            error: TERMINAL.has(job.state) ? errorOf(job) : undefined,
            startedAt: job.timings && job.timings.started_at,
            finishedAt: job.timings && job.timings.finished_at,
            job,
        });
    }

    /**
     * Read Run once when a task has been non-terminal for more than 10 minutes without an event (the single fallback
     * for a missing delivery, not page-view polling). force reads now, for a cancel or an explicit check.
     */
    async function refresh(row, { force = false } = {}) {
        if (!row.job_id || TERMINAL.has(row.state)) return row;
        if (!force && store.now() - Number(row.updated_at) < STALE_MS) return row;
        let job;
        try { job = await run.read(row.job_id, who(row)); } catch (e) { log.warn(`[Codes] task ${row.id}: ${e.message}`); return row; }
        return await applyJob(row, job);
    }

    /** A run.job.* delivery: the event's state/timings and the result read once from Run, in the caller's tx. */
    async function applyEvent(row, { state, job = null, error = null, timings = null } = {}) {
        if (!STATES.has(state)) return row;
        const result = TERMINAL.has(state) ? (job && asObject(job.result)) || null : undefined;
        const why = error || errorOf(job);
        return await recordState(row, {
            state,
            result,
            error: TERMINAL.has(state) ? why : undefined,
            startedAt: timings && timings.started_at,
            finishedAt: timings && timings.finished_at,
        });
    }

    async function latestProject(subject) {
        const row = await db.maybe('SELECT project_id FROM run_tasks WHERE subject = $1 ORDER BY created_at DESC LIMIT 1', [subject]);
        return row ? row.project_id : null;
    }

    function present(row) {
        const result = TERMINAL.has(row.state) ? presentResult(asObject(row.result)) : undefined;
        return drop({
            id: row.id, state: STATES.has(row.state) ? row.state : 'failed', repo: String(row.repo).slice(0, 300), ref: row.ref || null,
            agent: row.agent || null, url: `${config.baseUrl}/run/tasks/${row.id}`, created_at: iso(row.created_at), updated_at: iso(row.updated_at),
            error: row.error ? String(row.error).slice(0, 1000) : null, result,
        });
    }

    return { start, refresh, applyJob, applyEvent, recordState, latestProject, present, who };
}

module.exports = { createRunTasks, presentResult, TERMINAL, STATE_LABEL, STATES, RANK, STALE_MS, sessionLogOf, errorOf, asObject };
