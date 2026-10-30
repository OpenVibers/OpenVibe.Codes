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
 *
 * Every attempt that calls models through OpenVibe.AI runs on a run token of its own, carrying what is left of the
 * task's budget: the task's budget minus what the earlier attempts spent, as OpenVibe.AI counted it. When nothing
 * is left of it, the follow-up does not start and the task ends at its budget. An attempt on the person's own plan
 * (their CLI subscription on their machine) needs no token at all; the attempt's run_mode says which it was.
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

function createRunTasks({ store, run, config, log = console, sessions = null, outbox = null, runTokens = null, connections = null, attempts = null, proof = null, benchAttemptEnded = null, conductor = null }) {
    const db = store.db;
    const who = (row) => ({ subject: row.subject, project: row.project_id });
    // Lazily, so a caller that only reads tasks does not need the session/outbox modules (and there is no cycle).
    const sessionLines = sessions || require('./session-lines').createSessionLines({ store, config, log, media: require('../media').createMedia({ config, log }) });
    const taskOutbox = outbox || require('../events/outbox').createOutbox({ store, log });
    // The proof of a finished task (stage C8): the tests, the pages, the diff and the second model's opinion.
    const taskProof = proof || require('./proof').createProof({ store, config, log });
    const attemptStore = attempts || require('./attempts').createAttempts({ store, config, log });
    /**
     * The conductor's turns (server/domain/conductor.js). Wired by the app after both exist, because the conductor
     * starts Run jobs and this module is what applies their events: a constructor argument would be a cycle.
     */
    let conductorTurns = conductor;
    const setConductor = (turns) => { conductorTurns = turns; };
    /** An attempt's state when it ended: a limit reached is a budget-stop, never a plain failure. */
    const ENDED = new Set(['done', 'failed', 'stopped', 'budget-stopped', 'interrupted']);

    // ── The person's connections (Codes C3) ──
    // What they may run: the providers they keep a key for and the plans on their machines. It is read from
    // OpenVibe.AI (the keys) and from the machines' reports (the plans, empty until the machines report them).
    // The answer is cached for a minute, so a task that ends does not ask again for every attempt.
    const connectionCache = new Map();
    const CONNECTION_TTL_MS = 60_000;
    let harnessInfoCache = null;
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
     * The environment an attempt's harness gets (Codes C3): a run token that names the person, says where to send
     * its requests and carries the budget that is left for this attempt. A failure to mint one is not fatal: the
     * job runs as it did before, without the token.
     *
     * An attempt on the person's own plan (the CLI's own login on their machine) needs no token at all: the CLI
     * signs in itself, and nothing of it is metered by the task's budget. The attempt says which of the two it was.
     *
     * → { env, mode } with mode 'ai' (through OpenVibe.AI), 'plan' (the person's own subscription) or 'none'
     */
    async function attemptEnv({ subject, taskId, attemptId = null, agent = null, budget = null }) {
        if (!runTokens) return { env: null, mode: 'none' };
        try {
            const provider = providerFor(agent);
            const own = provider ? await hasOwnKey(subject, provider) : false;
            // The person's own key wins: it is the credential they chose, and the run is metered all the same.
            if (!own && await planFor(subject, agent)) return { env: null, mode: 'plan' };
            const minted = await runTokens.mint({ subject, task: taskId, attempt: attemptId, harness: agent, provider, ownKey: own, budget: budget || budgetFor(null) });
            return { env: minted.env, mode: 'ai' };
        } catch (e) {
            log.warn(`[Codes] no run token for task ${taskId}: ${String(e && e.message).slice(0, 200)}`);
            return { env: null, mode: 'none' };
        }
    }

    /**
     * The person's own plan for a harness: the CLI's own login on their machine (their Claude plan, their ChatGPT
     * plan, …). It is not OpenVibe.AI, so an attempt on it spends nothing the task's budget can run out of. Only a
     * CLI can sign in itself: an API harness always needs a token.
     */
    async function planFor(subject, agent) {
        const info = harnessInfo(agent);
        if (!info.provider || info.kind !== 'cli') return null;
        const conns = await personConnections(subject);
        if (!conns || !conns.plans || !conns.plans.length) return null;
        return conns.plans.find((p) => {
            if (!p || typeof p !== 'object') return false;
            const names = [p.provider, p.harness, p.id].filter(Boolean).map((v) => String(v).toLowerCase());
            return names.includes(info.provider.toLowerCase()) || names.includes(String(agent).toLowerCase());
        }) || null;
    }

    /**
     * The budget of one attempt: the task's limits (a benchmark's per-task limits) first, then the person's default
     * in Codes' settings, and nothing at all when neither says (an uncapped run is an uncapped run).
     */
    function budgetFor(limits) {
        const pick = (from, fallback) => {
            const n = Number(from);
            if (Number.isFinite(n) && n > 0) return n;
            const f = Number(fallback);
            return Number.isFinite(f) && f > 0 ? f : null;
        };
        const l = limits && typeof limits === 'object' ? limits : {};
        return {
            usd: pick(l.usd, config.budget && config.budget.usd),
            tokens: pick(l.tokens, config.budget && config.budget.tokens),
        };
    }

    /**
     * The attempt's run token and what it spent, per OpenVibe.AI: the budget the token carried and the counter of
     * what the run really spent (the numbers AI holds, not what the harness reported).
     */
    async function tokenSpend(attemptId) {
        if (!runTokens || !store || !store.db || !attemptId) return null;
        const row = await store.db.maybe('SELECT jti FROM codes_run_tokens WHERE attempt_id = $1 ORDER BY created_at DESC LIMIT 1', [attemptId]);
        if (!row || !row.jti) return null;
        return await runTokens.spend(row.jti);
    }

    /**
     * What the task's attempts spent through OpenVibe.AI: the sum of what AI counted for each of their run tokens
     * (GET /api/v1/run-budgets/:jti). An attempt on the person's own plan has no token and spends nothing here.
     */
    async function taskSpend(taskId) {
        const out = { usd: 0, tokens: 0, known: true };
        if (!runTokens || !taskId) return out;
        const tokens = await runTokens.forTask(taskId);
        for (const t of tokens) {
            const s = await runTokens.spend(t.jti);
            if (s) {
                out.usd += Number(s.spent_usd) || 0;
                out.tokens += Number(s.spent_tokens) || 0;
                continue;
            }
            // AI cannot say (its row goes with the token): what the harness reported is the next best thing.
            out.known = false;
            const a = t.attempt_id ? await attemptStore.get(t.attempt_id) : null;
            out.usd += Number(a && a.cost_usd) || 0;
            out.tokens += Number(a && a.tokens) || 0;
        }
        return out;
    }

    /**
     * The budget of the task and what is left of it: the task's budget (the first attempt's) minus what the earlier
     * attempts spent, as OpenVibe.AI counted it. A task with no budget at all has nothing to run out of.
     */
    async function remainingBudget(taskId) {
        const attempts = await attemptStore.list(taskId);
        const first = attempts[0] || null;
        const cap = {
            usd: first && first.budget_usd != null ? Number(first.budget_usd) : null,
            tokens: first && first.budget_tokens != null ? Number(first.budget_tokens) : null,
        };
        if (cap.usd == null && cap.tokens == null) {
            const fallback = budgetFor(null);   // a task written before the budgets: the person's default
            cap.usd = fallback.usd;
            cap.tokens = fallback.tokens;
        }
        if (cap.usd == null && cap.tokens == null) {
            return { cap, spent: { usd: 0, tokens: 0 }, left: { usd: null, tokens: null }, capped: false, exhausted: false };
        }
        const spent = await taskSpend(taskId);
        const left = {
            usd: cap.usd == null ? null : Math.max(0, Math.round((cap.usd - spent.usd) * 10000) / 10000),
            tokens: cap.tokens == null ? null : Math.max(0, cap.tokens - spent.tokens),
        };
        const exhausted = (cap.usd != null && left.usd <= 0) || (cap.tokens != null && left.tokens <= 0);
        return { cap, spent, left, capped: true, exhausted };
    }

    /** What a task that ran out of budget says, in plain words. */
    function budgetLeftNote(left) {
        const parts = [];
        if (left.cap.usd != null) parts.push(`$${(left.spent.usd || 0).toFixed(4)} of $${left.cap.usd.toFixed(2)}`);
        if (left.cap.tokens != null) parts.push(`${left.spent.tokens || 0} of ${left.cap.tokens} tokens`);
        return parts.length ? `stopped at its budget: ${parts.join(', ')} spent` : 'stopped at its budget';
    }

    /** Whether the run was refused for its budget (OpenVibe.AI said 402 ai.run_budget_reached). */
    function budgetRefused(result, error) {
        return /ai\.run_budget_reached/.test(budgetText(result, error));
    }

    /** Which budget ran out, as the refusal says it: the tokens or the dollars. */
    function budgetKind(result, error) {
        const text = budgetText(result, error);
        return /tokens? budget|tokens? of/i.test(text) ? 'tokens' : 'usd';
    }

    /** Everything the run said: the error and the session lines, as one text. */
    function budgetText(result, error) {
        const doc = asObject(result) || {};
        const lines = Array.isArray(doc.log) ? doc.log : [];
        return [String(error || ''), ...lines.map((l) => (l && l.text ? String(l.text) : ''))].join('\n');
    }

    /** The provider a harness runs on: the catalog's own word for it (anthropic, openai, deepseek, …). */
    function providerFor(agent) {
        return harnessInfo(agent).provider;
    }

    /** What the catalog says about a harness: its provider, and whether it is a CLI (which can sign in itself). */
    function harnessInfo(agent) {
        if (!harnessInfoCache) {
            harnessInfoCache = {};
            for (const offer of require('./harnesses').createHarnesses().list()) {
                harnessInfoCache[offer.id] = { provider: offer.provider || null, kind: (offer.address && offer.address.kind) || null };
            }
        }
        return harnessInfoCache[agent] || { provider: null, kind: null };
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
        let budgetAttempt = null;   // the attempt OpenVibe.AI refused for its budget (its spend is read after the write)
        const saved = await store.tx(async () => {
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
                    // A conductor's attempt outlives every turn: the same session is resumed by the next message, so
                    // its end is not the attempt's end — it waits for the person.
                    if (current.kind === 'conductor') {
                        await attemptStore.bind(attempt.id, {
                            state: 'waiting', session: usage.session, model: usage.model, machine: machineOf(next.job),
                            started_at: updated.started_at || null,
                        });
                    } else {
                        let why = reasonOf(state, updated.error);
                        const localHit = budgetHit(attempt, usage, why);
                        // OpenVibe.AI refused the run for its budget (402 ai.run_budget_reached): the attempt ends at its
                        // budget, not as a crash. Which budget ran out is in the refusal itself.
                        const refused = !localHit && budgetRefused(updated.result, updated.error);
                        const hit = localHit || (refused ? budgetKind(updated.result, updated.error) : null);
                        if (refused) why = 'budget';
                        if (refused) budgetAttempt = { id: attempt.id };
                        await attemptStore.end(attempt.id, {
                            state: hit ? 'budget-stopped' : (ATTEMPT_STATE[state] || 'failed'),
                            reason: hit ? 'budget' : why,
                            cost_usd: usage.cost_usd, tokens: usage.tokens, steps: usage.steps, session: usage.session,
                            model: usage.model, machine: machineOf(next.job),
                            budget_hit: hit,
                            finished_at: updated.finished_at || store.iso(),
                        });
                    }
                } else {
                    await attemptStore.bind(attempt.id, {
                        state: current.kind === 'conductor' ? 'running' : (ATTEMPT_STATE[state] || 'queued'),
                        started_at: updated.started_at || null, machine: machineOf(next.job),
                    });
                }
            }
            return updated;
        });
        // What the refused run really spent: OpenVibe.AI counted it (the harness may have stopped mid-turn).
        if (budgetAttempt) {
            const spend = await tokenSpend(budgetAttempt.id);
            if (spend) await attemptStore.spend(budgetAttempt.id, { cost_usd: spend.spent_usd, tokens: spend.spent_tokens });
        }
        if (TERMINAL.has(saved.state) && benchAttemptEnded && saved.actor_ref) {
            const meta = asObject(saved.actor_ref);
            if (meta && meta.bench) await benchAttemptEnded(saved).catch((e) => log.warn(`[Codes] benchmark publish failed for task ${saved.id}: ${String(e && e.message).slice(0, 200)}`));
        }
        return saved;
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
            [id, subject, project, args.repo || 'bench://', args.ref, args.prompt, args.agent, !!args.push, !!(args.push && args.push.pull_request), via, key, actorRefValue, at]);
            await taskOutbox.emitTask(inserted, null);
            return inserted;
        });
        // The task's first attempt: every Run job is one attempt, and this one is the task as it was asked.
        // The budget of the attempt: the task's limits (a benchmark's per-task limits) or the person's default.
        const budget = budgetFor(args.limits);
        const first = await attemptStore.create({
            task: inserted, agent: args.agent || null, model: args.model || null,
            why: args.agent ? `the first try, with ${attemptStore.nameOf(args.agent)}` : 'the first try, with the agent that fits the task',
            kind: 'first', state: 'queued', budget,
        });
        let job;
        try {
            // The job's harness runs with a short-lived run token that names the person (Codes C3): the environment
            // travels with the job's input and the machine's worker hands it to the harness.
            const funding = await attemptEnv({ subject, taskId: id, attemptId: first.attempt.id, agent: args.agent || null, budget });
            await attemptStore.bind(first.attempt.id, { run_mode: funding.mode });
            job = await run.submit({ subject, project, args: funding.env ? { ...args, env: funding.env } : args, key: id });
        } catch (e) {
            const why = e instanceof RunError ? `${e.code}: ${e.message}` : e.message;
            await attemptStore.end(first.attempt.id, { state: 'failed', reason: 'error', finished_at: store.iso() });
            return await store.tx(async () => {
                const failed = await db.one(`UPDATE run_tasks SET state = 'failed', error = $2, outcome = 'unfinished', outcome_note = $3, finished_at = $4::timestamptz, updated_at = $5
                    WHERE id = $1 RETURNING *`, [id, why, `the task could not start: ${why}`, store.iso(), store.now()]);
                await taskOutbox.emitTask(failed, 'queued');
                if (benchAttemptEnded && actorRef && asObject(actorRef).bench) {
                    await benchAttemptEnded(failed).catch((publishError) => log.warn(`[Codes] benchmark publish failed for task ${failed.id}: ${String(publishError && publishError.message).slice(0, 200)}`));
                }
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
        // The conductor's turns are its own: a turn that ended lands its message and the next one starts.
        if (row.kind === 'conductor') return conductorTurns ? conductorTurns.onTurnEnd(row.id, row.job_id) : row;
        const actorRef = asObject(row.actor_ref);
        if (actorRef && actorRef.bench) {
            const done = row.state === 'succeeded';
            // A benchmark attempt that ran out of money says so, with what it spent: it is not a crash.
            const ended = (await attemptStore.list(row.id)).slice(-1)[0] || null;
            const note = ended && ended.reason === 'budget' && ['usd', 'tokens'].includes(ended.budget_hit)
                ? attemptStore.budgetNote(ended)
                : (done ? 'benchmark attempt finished' : (row.error || 'benchmark attempt failed'));
            return await db.one('UPDATE run_tasks SET outcome = $2, outcome_note = $3, updated_at = $4 WHERE id = $1 RETURNING *',
                [row.id, done ? 'done' : 'unfinished', note, store.now()]);
        }
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
     *
     * The attempt gets a run token of its own, carrying what is left of the task's budget: the task's budget minus
     * what the earlier attempts spent, as OpenVibe.AI counted it. When nothing is left, the follow-up does not start
     * and the task ends there, at its budget.
     */
    async function startFollowUp(row, plan, ending) {
        const left = await remainingBudget(row.id);
        if (left.exhausted) {
            const stopped = await db.one(`UPDATE run_tasks SET outcome = 'unfinished', outcome_note = $2, updated_at = $3 WHERE id = $1 RETURNING *`,
                [row.id, budgetLeftNote(left), store.now()]);
            return { attempt: null, created: false, row: stopped, error: 'the task has no budget left' };
        }
        const { attempt, created } = await attemptStore.create({
            task: row, agent: plan.agent || null, model: plan.model || null, session: plan.session || null,
            why: plan.why || null, kind: plan.kind || 'manual', followUpOf: ending.id, state: 'queued', budget: left.left,
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
            // The follow-up runs on a run token of its own, with the budget that is left: a follow-up that spends
            // through AI is capped like any other attempt.
            const funding = await attemptEnv({ subject: row.subject, taskId: row.id, attemptId: attempt.id, agent: plan.agent || null, budget: left.left });
            await attemptStore.bind(attempt.id, { run_mode: funding.mode });
            job = await run.submit({ subject: row.subject, project: row.project_id, args: funding.env ? { ...args, env: funding.env } : args, key: attempt.id });
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
     *
     * One continuation at a time (the portal's liveContinuation, 10-30): while an attempt is still live — the automatic
     * continue after a crash, a wrap-up, another manual press — that attempt is returned, and no second one is started
     * beside it. Two sessions on one worktree would fight over the same files.
     */
    async function continueTask(row, { note = null, agent = null } = {}) {
        if (!row || !row.id) return { error: 'no such task' };
        const attempts = await attemptStore.list(row.id);
        const ending = attempts[attempts.length - 1];
        if (!ending) return { error: 'the task has no attempt to carry on' };
        const live = attempts.slice().reverse().find((a) => !ENDED.has(a.state));
        if (live) return { attempt: live, live: true, row };
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
        const before = await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [row.id]);
        if (!before) return { error: 'no such task' };
        if (!TERMINAL.has(before.state)) return { error: 'the task is still running' };
        if (before.outcome === 'stopped') return { error: 'the task was stopped on purpose' };
        // The next attempt gets a run token of its own, with what is left of the task's budget. When nothing is left
        // of it, the attempt does not start and the task ends at its budget.
        const left = await remainingBudget(row.id);
        if (left.exhausted) {
            const stopped = await db.one(`UPDATE run_tasks SET outcome = 'unfinished', outcome_note = $2, updated_at = $3 WHERE id = $1 RETURNING *`,
                [row.id, budgetLeftNote(left), store.now()]);
            return { error: 'the task has no budget left', row: stopped };
        }
        const locked = await store.tx(async () => {
            const current = await db.maybe('SELECT * FROM run_tasks WHERE id = $1 FOR UPDATE', [row.id]);
            if (!current) return { error: 'no such task' };
            if (!TERMINAL.has(current.state)) return { error: 'the task is still running' };
            if (current.outcome === 'stopped') return { error: 'the task was stopped on purpose' };
            const made = await attemptStore.create({
                task: current, agent: plan.agent, model: plan.model, session: null, why: plan.why, kind: plan.kind, state: 'queued', budget: left.left,
            });
            attempt = made.attempt;
            await db.one(`UPDATE run_tasks SET state = 'queued', outcome = NULL, outcome_note = NULL, error = NULL, job_id = NULL, finished_at = NULL, updated_at = $2 WHERE id = $1 RETURNING *`,
                [row.id, store.now()]);
            return { row: current };
        });
        if (locked.error) return { error: locked.error };
        let job;
        try {
            const funding = await attemptEnv({ subject: row.subject, taskId: row.id, attemptId: attempt.id, agent: plan.agent || null, budget: left.left });
            await attemptStore.bind(attempt.id, { run_mode: funding.mode });
            const args = followUpArgs(row, plan);
            job = await run.submit({ subject: row.subject, project: row.project_id, args: funding.env ? { ...args, env: funding.env } : args, key: attempt.id });
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
        latestProject, present, who, attempts: attemptStore, setConductor,
    };
}

module.exports = { createRunTasks, presentResult, TERMINAL, STATE_LABEL, STATES, RANK, STALE_MS, sessionLogOf, errorOf, asObject, ATTEMPT_STATE, reasonOf, usageOf };
