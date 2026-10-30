'use strict';

/**
 * Coding tasks on a person's own machine (run_tasks, plan T16): what the /run pages (server/http/run.js) and the
 * service API (server/http/tasks-api.js, codes.task.*) share.
 *
 *   createRunTasks({ store, run, config, log, sessions, outbox, runTokens, connections, attempts })
 *     start({ subject, project, args, via, key }) → the row: queued (Run took the job) or failed (Run's reason)
 *     refresh(row, { force })                     → the row, read from Run only as a fallback after 10 quiet minutes
 *     applyEvent(row, event)                      → a run.job.* delivery: state, timings, result, event, in one tx
 *     afterEnd(taskId)                            → the engine's decision after an attempt ended
 *     continueTask(row, { note, agent })          → the next attempt now (a switch when an agent is named)
 *     stopTask(row)                               → stop the running attempt; nothing carries it on
 *     latestProject(subject)                      → the project of the person's latest task, or null
 *     present(row)                                → codes.task@1
 *   TERMINAL, STATE_LABEL, STALE_MS
 *
 * Every state change writes its codes.task.* outbox row in the same transaction; a terminal state also back-fills
 * the session's missing lines and marks it complete. A task's result comes from the person's machine: present() passes
 * on only the contract's fields, each checked and cut to its limit.
 *
 * Stage C2: every Run job is one attempt on the task's timeline (server/domain/attempts.js). When an attempt ends,
 * the engine decides what happens next — done, a continue in the same session, a switch to another agent, a wrap-up or
 * an unfinished task — and this module carries the decision out. One ending starts at most one follow-up: the
 * follow-up's follow_up_of is unique, so two racing ticks never carry one job on twice.
 */
const { RunError } = require('./run-client');
const { chain, budget } = require('../../engine');
const { parseArgs } = require('../../harness/job');

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

/** The machine a job ran on: the worker's device id, or the hosted sandbox. */
function machineOf(job) {
    if (!job || typeof job !== 'object') return null;
    const node = job.placement && typeof job.placement === 'object' ? job.placement.node : null;
    if (typeof node === 'string' && node) return node.slice(0, 128);
    return typeof job.machine === 'string' && job.machine ? job.machine.slice(0, 128) : null;
}

/** The attempt's own state for a Run job's state. */
const ATTEMPT_STATE = { queued: 'queued', placed: 'queued', running: 'running', succeeded: 'done', failed: 'failed', cancelled: 'stopped', expired: 'failed' };

/** The reason an attempt ended: the engine's own words (engine/chain.js reason), plus the two it reads from the text. */
function reasonOf(state, text) {
    if (state === 'cancelled') return 'stopped';
    if (state === 'expired') return 'capacity';
    const s = String(text || '');
    if (/went quiet|hung|stale/i.test(s)) return 'hung';
    if (/prompt is too long|context length|maximum context|context window|too many tokens|input too long/i.test(s)) return 'context';
    const why = chain.reason(s);
    return why === 'unknown' ? 'error' : why;
}

/** What an attempt spent: its cost, its tokens, its steps and the session a resume needs (from the job's result log). */
function usageOf(result) {
    const d = asObject(result) || {};
    const log = Array.isArray(d.log) ? d.log : [];
    let tokens = 0; let steps = 0; let session = null; let model = null;
    for (const line of log) {
        if (!line || typeof line !== 'object') continue;
        if (line.t === 'usage') tokens += (Number(line.input_tokens) || 0) + (Number(line.output_tokens) || 0);
        else if (line.t === 'tool') steps++;
        else if (line.t === 'agent') {
            if (!session && line.session) session = String(line.session);
            if (!model && line.model) model = String(line.model);
        }
    }
    return {
        cost_usd: typeof d.cost_usd === 'number' && Number.isFinite(d.cost_usd) ? d.cost_usd : null,
        tokens: tokens || null,
        steps: steps || null,
        session: session || null,
        model: model || null,
    };
}

function createRunTasks({ store, run, config, log = console, sessions = null, outbox = null, runTokens = null, connections = null, attempts = null, proof = null }) {
    const db = store.db;
    const who = (row) => ({ subject: row.subject, project: row.project_id });
    // Lazily, so a caller that only reads tasks does not need the session/outbox modules (and there is no cycle).
    const sessionLines = sessions || require('./session-lines').createSessionLines({ store, config, log });
    const taskOutbox = outbox || require('../events/outbox').createOutbox({ store, log });
    // The proof of a finished task (stage C8): the tests, the pages, the diff and the second model's opinion.
    const taskProof = proof || require('./proof').createProof({ store, config, log });
    const attemptStore = attempts || require('./attempts').createAttempts({ store, config, log });
    /** An attempt's state when it ended: a limit reached is a budget-stop, never a plain failure. */
    const ENDED = new Set(['done', 'failed', 'stopped', 'budget-stopped', 'interrupted']);

    // ── The person's connections (Codes C3) ──
    // What they may run: the providers they keep a key for and the plans on their machines. It is read from
    // OpenVibe.AI (the keys) and from the machines' reports (the plans, empty until the machines report them).
    // The answer is cached for a minute, so a task that ends does not ask again for every attempt.
    const connectionCache = new Map();
    const CONNECTION_TTL_MS = 60_000;
    let providerMap = null;
    async function personConnections(subject) {
        if (!connections || !subject) return null;
        const hit = connectionCache.get(subject);
        if (hit && hit.until > store.now()) return hit.value;
        let value = null;
        try {
            const out = await connections.list(subject);
            value = { providers: (out.keys || []).map((k) => k.provider), plans: out.plans || [] };
        } catch (e) {
            log.warn(`[Codes] the connections of ${subject} could not be read: ${String(e && e.message).slice(0, 200)}`);
            value = null;
        }
        connectionCache.set(subject, { value, until: store.now() + CONNECTION_TTL_MS });
        return value;
    }

    /**
     * The environment the job's harness gets (Codes C3): a run token that names the person and says where to
     * send its requests. A failure to mint one is not fatal: the job runs as it did before, without the token.
     */
    async function harnessEnv({ subject, taskId, attemptId = null, agent = null }) {
        if (!runTokens) return null;
        try {
            const provider = providerFor(agent);
            const own = provider ? await hasOwnKey(subject, provider) : false;
            const minted = await runTokens.mint({ subject, task: taskId, attempt: attemptId, harness: agent, provider, ownKey: own });
            return minted.env;
        } catch (e) {
            log.warn(`[Codes] no run token for task ${taskId}: ${String(e && e.message).slice(0, 200)}`);
            return null;
        }
    }

    /** The provider a harness runs on: the catalog's own word for it (anthropic, openai, deepseek, …). */
    function providerFor(agent) {
        if (!agent) return null;
        if (!providerMap) {
            providerMap = {};
            for (const offer of require('./harnesses').createHarnesses().list()) providerMap[offer.id] = offer.provider;
        }
        return providerMap[agent] || null;
    }

    /** Whether the person keeps their own key for this provider. */
    async function hasOwnKey(subject, provider) {
        const conns = await personConnections(subject);
        if (!conns) return false;
        return conns.providers.includes(provider);
    }


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
            // Every Run job is one attempt: the attempt of this job follows the job.
            const attempt = await attemptStore.byJob(current.job_id);
            if (TERMINAL.has(updated.state) && !updated.session_complete_at) {
                await sessionLines.backfillAndComplete(updated, updated.result, attempt ? Number(attempt.n) : null);
            }
            if (attempt) {
                if (TERMINAL.has(state)) {
                    const usage = usageOf(updated.result);
                    const why = reasonOf(state, updated.error);
                    const hit = budgetHit(attempt, usage, why);
                    await attemptStore.end(attempt.id, {
                        state: hit ? 'budget-stopped' : (ATTEMPT_STATE[state] || 'failed'),
                        reason: hit ? 'budget' : why,
                        cost_usd: usage.cost_usd, tokens: usage.tokens, steps: usage.steps, session: usage.session,
                        model: usage.model, machine: machineOf(next.job),
                        finished_at: updated.finished_at || store.iso(),
                    });
                } else {
                    await attemptStore.bind(attempt.id, {
                        state: ATTEMPT_STATE[state] || 'queued', started_at: updated.started_at || null, machine: machineOf(next.job),
                    });
                }
            }
            return updated;
        });
    }

    /**
     * The limit an attempt reached, if any (engine/budget.js): steps, minutes or dollars. A provider's own limit
     * (usage limit, signed out) is not the owner's budget and never buys a wrap-up turn.
     */
    function budgetHit(attempt, usage, reason) {
        if (!['error', 'hung', 'context'].includes(reason)) return null;
        const limits = budget.limitsFor(config, attempt.agent, null);
        if (!limits.steps && !limits.minutes && !limits.usd) return null;
        const started = attempt.started_at ? Date.parse(String(attempt.started_at)) : 0;
        const finished = attempt.finished_at ? Date.parse(String(attempt.finished_at)) : 0;
        const minutes = finished > started ? (finished - started) / 60000 : null;
        return budget.evaluate({ steps: usage.steps || 0, minutes, usd: usage.cost_usd }, limits).hit;
    }

    async function start({ subject, project, args, via = null, key = null, actorRef = null }) {
        const id = store.newId('tsk');
        const at = store.now();
        const actorRefValue = actorRef && typeof actorRef === 'object' && !Array.isArray(actorRef) ? JSON.stringify(actorRef) : null;
        let inserted;
        await store.tx(async () => {
            inserted = await db.one(`INSERT INTO run_tasks (id, subject, project_id, repo, ref, prompt, agent, push, pull_request, state, via, idempotency_key, actor_ref, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10, $11, $12::jsonb, $13, $13) RETURNING *`,
            [id, subject, project, args.repo, args.ref, args.prompt, args.agent, !!args.push, !!(args.push && args.push.pull_request), via, key, actorRefValue, at]);
            await taskOutbox.emitTask(inserted, null);
            return inserted;
        });
        // The task's first attempt: every Run job is one attempt, and this one is the task as it was asked.
        const first = await attemptStore.create({
            task: inserted, agent: args.agent || null, model: args.model || null,
            why: args.agent ? `the first try, with ${attemptStore.nameOf(args.agent)}` : 'the first try, with the agent that fits the task',
            kind: 'first', state: 'queued',
        });
        let job;
        try {
            // The job's harness runs with a short-lived run token that names the person (Codes C3): the environment
            // travels with the job's input and the machine's worker hands it to the harness.
            const env = await harnessEnv({ subject, taskId: id, agent: args.agent || null });
            job = await run.submit({ subject, project, args: env ? { ...args, env } : args, key: id });
        } catch (e) {
            const why = e instanceof RunError ? `${e.code}: ${e.message}` : e.message;
            await attemptStore.end(first.attempt.id, { state: 'failed', reason: 'error', finished_at: store.iso() });
            return await store.tx(async () => {
                const failed = await db.one(`UPDATE run_tasks SET state = 'failed', error = $2, outcome = 'unfinished', outcome_note = $3, finished_at = $4::timestamptz, updated_at = $5
                    WHERE id = $1 RETURNING *`, [id, why, `the task could not start: ${why}`, store.iso(), store.now()]);
                await taskOutbox.emitTask(failed, 'queued');
                return failed;
            });
        }
        await attemptStore.bind(first.attempt.id, { job_id: job.id, state: 'queued' });
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
        const updated = await recordState(row, {
            state: job.state,
            result,
            error: TERMINAL.has(job.state) ? errorOf(job) : undefined,
            startedAt: job.timings && job.timings.started_at,
            finishedAt: job.timings && job.timings.finished_at,
            job,
        });
        // The attempt ended: the engine decides, and the row carries the outcome (or the next attempt).
        return (await afterEnd(updated.id)) || updated;
    }

    /**
     * Read Run once when a task has been non-terminal for more than 10 minutes without an event (the single fallback
     * for a missing delivery, not page-view polling). force reads now, for a cancel or an explicit check.
     */
    async function refresh(row, { force = false } = {}) {
        if (!row.job_id) return row;
        if (TERMINAL.has(row.state)) {
            // The task has ended. Its decision (the outcome, or the attempt that follows) is made once, when the
            // attempt ended; if that failed, it is made here, as the fallback reads Run after 10 quiet minutes.
            if (!row.outcome && (force || store.now() - Number(row.updated_at) >= STALE_MS)) {
                return (await afterEnd(row.id)) || row;
            }
            return row;
        }
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

    /**
     * An attempt ended: the engine decides what happens next (server/domain/attempts.js) and this carries the
     * decision out — a follow-up attempt, or the task's outcome in plain words.
     *
     * Calling it twice for one ending changes nothing: the follow-up's follow_up_of is unique, so the second call
     * finds the attempt the first one wrote and starts no second job (the portal's 10-30 bug, where two racing ticks
     * carried one job on twice).
     */
    async function afterEnd(taskId) {
        const row = await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [taskId]);
        if (!row) return null;
        if (!TERMINAL.has(row.state)) return row;
        if (row.outcome === 'stopped') return row;      // a person stopped it: nothing carries it on
        const attempts = await attemptStore.list(row.id);
        const ending = attempts[attempts.length - 1];
        if (!ending || !ENDED.has(ending.state)) return row;
        // The proof this attempt's machine collected: the items are kept, and each one is an event on the stream.
        const collected = await recordProof(row, ending);
        const plan = await attemptStore.decide({ task: row, attempts, ending, result: row.result });
        if (plan.outcome) {
            // The outcome in plain words: what the engine decided, and what the proof says about it.
            const outcome = taskProof.outcomeOf(collected, { state: plan.outcome, note: plan.note });
            return await db.one('UPDATE run_tasks SET outcome = $2, outcome_note = $3, updated_at = $4 WHERE id = $1 RETURNING *',
                [row.id, outcome.state, outcome.note, store.now()]);
        }
        if (!plan.kind) return row;
        const done = await startFollowUp(row, plan, ending);
        return done.row || row;
    }

    /**
     * The proof this attempt's machine collected: the items are kept, and each one is an event on the task's stream.
     *
     * The machine collects it in the clone it worked in (harness/job.js), so the tests that ran and the pages that were
     * shot are about that machine's work. A task from before this change has no proof, and says nothing about one.
     *
     * @param {object} row the task
     * @param {object} ending the attempt that ended
     * @returns {Promise<object[]>} the items as they are stored
     */
    async function recordProof(row, ending) {
        const result = asObject(row.result) || {};
        const items = Array.isArray(result.proof && result.proof.items) ? result.proof.items : [];
        if (!items.length) return [];
        const attemptN = ending ? Number(ending.n) : null;
        const recorded = await taskProof.record(row.id, attemptN, items);
        if (recorded.lines.length) await sessionLines.append(row.id, recorded.lines, attemptN);
        return recorded.rows;
    }

    /**
     * The next attempt: a Run job for the task with the engine's plan in it. The attempt is written first and the job
     * second, so the fence (follow_up_of) is in place before anything is started.
     */
    async function startFollowUp(row, plan, ending) {
        const { attempt, created } = await attemptStore.create({
            task: row, agent: plan.agent || null, model: plan.model || null, session: plan.session || null,
            why: plan.why || null, kind: plan.kind || 'manual', followUpOf: ending.id, state: 'queued',
        });
        // Someone else already started the follow-up of this ending: no second job.
        if (!created) return { attempt, created: false, row };
        let args;
        try {
            args = followUpArgs(row, plan);
        } catch (e) {
            await attemptStore.end(attempt.id, { state: 'failed', reason: 'error', finished_at: store.iso() });
            const failed = await db.one(`UPDATE run_tasks SET outcome = 'unfinished', outcome_note = $2, updated_at = $3 WHERE id = $1 RETURNING *`,
                [row.id, `the next attempt could not be prepared: ${e.message}`, store.now()]);
            return { attempt, created: true, row: failed, error: e.message };
        }
        let job;
        try {
            job = await run.submit({ subject: row.subject, project: row.project_id, args, key: attempt.id });
        } catch (e) {
            const why = e instanceof RunError ? `${e.code}: ${e.message}` : e.message;
            await attemptStore.end(attempt.id, { state: 'failed', reason: 'error', finished_at: store.iso() });
            const failed = await db.one(`UPDATE run_tasks SET outcome = 'unfinished', outcome_note = $2, updated_at = $3 WHERE id = $1 RETURNING *`,
                [row.id, `the next attempt could not start: ${why}`, store.now()]);
            return { attempt, created: true, row: failed, error: why };
        }
        await attemptStore.bind(attempt.id, { job_id: job.id, state: 'queued' });
        const updated = await db.one(
            `UPDATE run_tasks SET job_id = $2, state = 'queued', outcome = NULL, outcome_note = NULL, error = NULL,
                finished_at = NULL, updated_at = $3 WHERE id = $1 RETURNING *`,
            [row.id, job.id, store.now()]);
        await taskOutbox.emitTask(updated, row.state);
        return { attempt, created: true, job, row: updated };
    }

    /**
     * The next attempt now: the owner carries the task on (with a note), or switches to another agent. The task's row
     * is locked while the attempt is written, so two presses start one attempt and not two.
     */
    async function continueTask(row, { note = null, agent = null } = {}) {
        if (!row || !row.id) return { error: 'no such task' };
        const attempts = await attemptStore.list(row.id);
        const ending = attempts[attempts.length - 1];
        if (!ending) return { error: 'the task has no attempt to carry on' };
        const text = note ? String(note).trim().slice(0, 4000) : '';
        const plan = agent
            ? {
                kind: 'switch', agent, model: null, session: null,
                prompt: `${row.prompt}\n\n---\n## Hand-over (written by openvibe.codes)\n\n${attemptStore.nameOf(agent)} takes over from ${attemptStore.nameOf(ending.agent)}, which ${attemptStore.wordsOf(ending.reason || 'error')}. Keep the work that was done, do not redo it, and finish the task.\n`,
                why: `${attemptStore.nameOf(agent)} took over at the owner's request`,
            }
            : {
                kind: 'manual', agent: ending.agent, model: ending.model, session: null,
                prompt: `${row.prompt}${text ? `\n\n---\n## A note from the owner\n\n${text}\n` : ''}`,
                why: text ? `carried on by the owner: ${text.slice(0, 200)}` : 'carried on by the owner',
            };
        let attempt = null;
        const locked = await store.tx(async () => {
            const current = await db.maybe('SELECT * FROM run_tasks WHERE id = $1 FOR UPDATE', [row.id]);
            if (!current) return { error: 'no such task' };
            if (!TERMINAL.has(current.state)) return { error: 'the task is still running' };
            if (current.outcome === 'stopped') return { error: 'the task was stopped on purpose' };
            const made = await attemptStore.create({
                task: current, agent: plan.agent, model: plan.model, session: null, why: plan.why, kind: plan.kind, state: 'queued',
            });
            attempt = made.attempt;
            await db.one(`UPDATE run_tasks SET state = 'queued', outcome = NULL, outcome_note = NULL, error = NULL, job_id = NULL, finished_at = NULL, updated_at = $2 WHERE id = $1 RETURNING *`,
                [row.id, store.now()]);
            return { row: current };
        });
        if (locked.error) return { error: locked.error };
        let job;
        try {
            job = await run.submit({ subject: row.subject, project: row.project_id, args: followUpArgs(row, plan), key: attempt.id });
        } catch (e) {
            const why = e instanceof RunError ? `${e.code}: ${e.message}` : e.message;
            await attemptStore.end(attempt.id, { state: 'failed', reason: 'error', finished_at: store.iso() });
            const failed = await db.one(`UPDATE run_tasks SET state = 'failed', error = $2, outcome = 'unfinished', outcome_note = $3, finished_at = $4::timestamptz, updated_at = $5 WHERE id = $1 RETURNING *`,
                [row.id, why, `the next attempt could not start: ${why}`, store.iso(), store.now()]);
            return { error: why, row: failed, attempt };
        }
        await attemptStore.bind(attempt.id, { job_id: job.id, state: 'queued' });
        const updated = await db.one('UPDATE run_tasks SET job_id = $2, updated_at = $3 WHERE id = $1 RETURNING *', [row.id, job.id, store.now()]);
        await taskOutbox.emitTask(updated, row.state);
        return { attempt, job, row: updated };
    }

    /** The job's arguments for a follow-up: the task's own repository, the plan's prompt and the session to resume. */
    function followUpArgs(row, plan) {
        return parseArgs(JSON.stringify({
            repo: row.repo, ref: row.ref || null, prompt: plan.prompt || row.prompt,
            agent: plan.agent || null, permission: 'edit',
            ...(row.push ? { push: { pull_request: !!row.pull_request } } : {}),
            ...(plan.session ? { resume: plan.session } : {}),
        }));
    }

    /**
     * Stop the running attempt: the outcome is stopped and nothing carries it on. The task's row is locked, so a stop
     * and a follow-up never race.
     */
    async function stopTask(row) {
        if (!row || !row.id) return { error: 'no such task' };
        const attempts = await attemptStore.list(row.id);
        const running = attempts.slice().reverse().find((a) => !ENDED.has(a.state));
        if (row.job_id && !TERMINAL.has(row.state)) {
            try { await run.cancel(row.job_id, who(row)); } catch (e) { log.warn(`[Codes] stop ${row.id}: ${e.message}`); }
        }
        const stopped = await store.tx(async () => {
            const current = await db.maybe('SELECT * FROM run_tasks WHERE id = $1 FOR UPDATE', [row.id]);
            if (!current) return { error: 'no such task' };
            if (TERMINAL.has(current.state) && current.outcome) return { error: 'the task has already ended', row: current };
            const updated = await db.one(
                `UPDATE run_tasks SET state = 'cancelled', outcome = 'stopped', outcome_note = $2,
                    finished_at = COALESCE(finished_at, $3::timestamptz), updated_at = $4 WHERE id = $1 RETURNING *`,
                [row.id, 'the task was stopped on purpose', store.iso(), store.now()]);
            await taskOutbox.emitTask(updated, current.state);
            return { row: updated };
        });
        if (stopped.error) return stopped;
        if (running) await attemptStore.end(running.id, { state: 'stopped', reason: 'stopped', finished_at: store.iso() });
        return { row: stopped.row, attempt: running || null };
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

    return {
        start, refresh, applyJob, applyEvent, recordState, afterEnd, continueTask, stopTask, proof: taskProof,
        latestProject, present, who, attempts: attemptStore,
    };
}

module.exports = { createRunTasks, presentResult, TERMINAL, STATE_LABEL, STATES, RANK, STALE_MS, sessionLogOf, errorOf, asObject, ATTEMPT_STATE, reasonOf, usageOf };
