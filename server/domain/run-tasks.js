'use strict';

/**
 * Coding tasks on a person's own machine (run_tasks, plan T16): what the /run pages (server/http/run.js) and the
 * service API (server/http/tasks-api.js, codes.task.*) share.
 *
 *   createRunTasks({ store, run, config, log })
 *     start({ subject, project, args, via, key }) → the row: queued (Run took the job) or failed (Run's reason)
 *     refresh(row)                                → the row, updated from Run while its job has not ended
 *     latestProject(subject)                      → the project of the person's latest task, or null
 *     present(row)                                → codes.task@1
 *   TERMINAL, STATE_LABEL
 *
 * A task's result comes from the person's machine: present() passes on only the contract's fields, each checked and
 * cut to its limit.
 */
const { RunError } = require('./run-client');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const STATE_LABEL = {
    queued: 'Waiting for your machine', placed: 'Sent to your machine', running: 'Running', succeeded: 'Finished',
    failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired (no machine took it in time)',
};
const STATES = new Set(Object.keys(STATE_LABEL));

const iso = (ms) => new Date(Number(ms)).toISOString();
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const httpsUrl = (v) => {
    if (typeof v !== 'string' || v.length > 2000) return undefined;
    try { return new URL(v).protocol === 'https:' ? v : undefined; } catch { return undefined; }
};
const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

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

function createRunTasks({ store, run, config, log = console }) {
    const db = store.db;
    const who = (row) => ({ subject: row.subject, project: row.project_id });

    async function start({ subject, project, args, via = null, key = null }) {
        const id = store.newId('tsk');
        const at = store.now();
        await db.exec(`INSERT INTO run_tasks (id, subject, project_id, repo, ref, prompt, agent, push, pull_request, state, via, idempotency_key, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10, $11, $12, $12)`,
        [id, subject, project, args.repo, args.ref, args.prompt, args.agent, !!args.push, !!(args.push && args.push.pull_request), via, key, at]);
        try {
            const job = await run.submit({ subject, project, args, key: id });
            await db.exec('UPDATE run_tasks SET job_id = $2, state = $3, updated_at = $4 WHERE id = $1', [id, job.id, job.state, store.now()]);
        } catch (e) {
            const why = e instanceof RunError ? `${e.code}: ${e.message}` : e.message;
            await db.exec("UPDATE run_tasks SET state = 'failed', error = $2, updated_at = $3 WHERE id = $1", [id, why, store.now()]);
        }
        return db.one('SELECT * FROM run_tasks WHERE id = $1', [id]);
    }

    async function refresh(row) {
        if (!row.job_id || TERMINAL.has(row.state)) return row;
        let job;
        try { job = await run.read(row.job_id, who(row)); } catch (e) { log.warn(`[Codes] task ${row.id}: ${e.message}`); return row; }
        if (job.state === row.state && !TERMINAL.has(job.state)) return row;
        const error = job.error ? `${job.error.code}${job.error.detail ? `: ${job.error.detail}` : ''}` : null;
        const result = job.result && typeof job.result === 'object' ? job.result : null;
        return db.one('UPDATE run_tasks SET state = $2, result = $3, error = $4, updated_at = $5 WHERE id = $1 RETURNING *',
            [row.id, job.state, result ? JSON.stringify(result) : null, error, store.now()]);
    }

    async function latestProject(subject) {
        const row = await db.maybe('SELECT project_id FROM run_tasks WHERE subject = $1 ORDER BY created_at DESC LIMIT 1', [subject]);
        return row ? row.project_id : null;
    }

    function present(row) {
        const result = TERMINAL.has(row.state) ? presentResult(typeof row.result === 'string' ? JSON.parse(row.result) : row.result) : undefined;
        return drop({
            id: row.id, state: STATES.has(row.state) ? row.state : 'failed', repo: String(row.repo).slice(0, 300), ref: row.ref || null,
            agent: row.agent || null, url: `${config.baseUrl}/run/tasks/${row.id}`, created_at: iso(row.created_at), updated_at: iso(row.updated_at),
            error: row.error ? String(row.error).slice(0, 1000) : null, result,
        });
    }

    return { start, refresh, latestProject, present, who };
}

module.exports = { createRunTasks, presentResult, TERMINAL, STATE_LABEL };
