'use strict';

/**
 * A coding task's attempts (codes_attempts): the timeline of one task.
 *
 * A continue, a switch to another agent and a wrap-up are attempts on one task's timeline, never new tasks with
 * cryptic names (the portal's "-c1"/"-r2" confusion of 10-30). Every Run job is one attempt: the attempt carries the
 * job, the agent, the machine and the harness session a resume needs.
 *
 * The engine decides what happens next (engine/chain.js outcome/nextStep, engine/budget.js wrapUp): this module turns
 * its decision into a plan — a follow-up attempt, or the task's outcome in plain words. It never starts a Run job
 * itself (server/domain/run-tasks.js does that, outside a transaction) and it never decides twice for one ending:
 * the follow-up's follow_up_of is unique, so one ending can start only one follow-up.
 *
 *   createAttempts({ store, config, log, harnesses })
 *     list(taskId)                    the attempts of a task, in order
 *     get(id)                         one attempt
 *     create({ task, …, followUpOf })  one attempt; the same followUpOf answers the same attempt (the fence)
 *     bind(id, { job_id, state })     the Run job of an attempt
 *     end(id, { state, reason, … })   an attempt ended: its state, its reason, its cost
 *     decide({ task, attempts, ending, result })  the engine's decision, as a plan
 *     present(attempt)                the attempt as the API shows it
 */

const { chain, budget, router } = require('../../engine');

/** Codes' harness ids and the engine's short runner ids for the same harness. */
const RUNNER_OF = { 'claude-code': 'claude', codex: 'cx', 'command-code': 'cc', opencode: 'oc', deepseek: 'dsh', 'minimax-code': 'mm' };
const HARNESS_OF = { claude: 'claude-code', cx: 'codex', cc: 'command-code', oc: 'opencode', dsh: 'deepseek', mm: 'minimax-code' };

/** The order a runner switch tries the harnesses in (the ladder's order, flattened). Never Claude: a sub-task is never
 *  an Anthropic one (Codes C9b's rule), so the conductor's session stays the only Anthropic work. */
const FALLBACK_ORDER = ['cx', 'mm', 'cc', 'oc', 'dsh'];

/** Which harnesses may take which kind of task, cheapest first (the engine's ladder, Codes' harnesses). Claude Code is
 *  absent on purpose: it is the conductor's own session, never a sub-task's. */
const TIER_ORDER = {
    basic: ['opencode', 'command-code', 'minimax-code', 'deepseek'],
    research: ['codex', 'minimax-code', 'deepseek', 'opencode'],
    standard: ['minimax-code', 'codex', 'command-code', 'opencode', 'deepseek'],
    hard: ['codex', 'minimax-code', 'deepseek'],
    design: ['codex', 'minimax-code', 'opencode', 'deepseek'],
};
const TIER_EFFORT = { basic: 'low', research: 'medium', standard: 'high', hard: 'high', design: 'high' };

/** The attempt's own states, and the reasons it may have ended. */
const STATES = ['queued', 'running', 'done', 'failed', 'stopped', 'budget-stopped', 'interrupted'];
const REASONS = ['limit', 'auth', 'capacity', 'refused', 'error', 'budget', 'stopped', 'hung', 'context', 'turns'];
const KINDS = ['first', 'continue', 'switch', 'wrap-up', 'restart', 'manual'];

/** The engine's own words for a reason: the timeline reads like a person wrote it. */
const REASON_TEXT = chain.REASON_TEXT;

/**
 * The text the engine classifies a reason from. The engine reads the reason of a failed attempt out of what it said
 * (engine/chain.js reason), so the text has to say the same thing our reason column says.
 */
const ERROR_TEXT = {
    limit: 'usage limit reached',
    auth: 'authentication failed: log in again',
    capacity: 'the model was at capacity',
    refused: 'turned off in the agent portal',
    error: 'the work failed',
    budget: 'stopped at its limit',
    stopped: 'stopped on purpose',
    context: 'the context window is too big',
    hung: 'it went quiet for too long',
    turns: 'the harness reached max_turns',
};

/** The engine's status for our state (the two vocabularies are the same, except 'queued' and 'running'). */
const ENGINE_STATE = {
    queued: 'queued', running: 'running', done: 'done', failed: 'failed',
    stopped: 'stopped', 'budget-stopped': 'budget-stopped', interrupted: 'interrupted',
};

/** The attempt's state for a task's state (a task from before the attempts still has one). */
const TASK_STATE = {
    queued: 'queued', placed: 'queued', running: 'running', succeeded: 'done',
    failed: 'failed', cancelled: 'stopped', expired: 'failed',
};

const iso = (v) => {
    if (!v) return null;
    const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const runnerOf = (agent) => RUNNER_OF[agent] || (agent || 'auto');
const wordsOf = (reason) => REASON_TEXT[reason] || REASON_TEXT.error;

/**
 * What an attempt that stopped at its budget says, in plain words: which budget it reached and what it spent.
 * The dollars and the tokens are what OpenVibe.AI counted for the run token.
 */
function budgetNote(a) {
    if (!a) return 'stopped at its budget';
    const usd = a.cost_usd == null ? null : Number(a.cost_usd);
    const tokens = a.tokens == null ? null : Number(a.tokens);
    const limitUsd = a.budget_usd == null ? null : Number(a.budget_usd);
    const limitTokens = a.budget_tokens == null ? null : Number(a.budget_tokens);
    const parts = [];
    if (limitUsd != null) parts.push(`$${usd == null ? 0 : usd.toFixed(4)} of $${limitUsd.toFixed(2)}`);
    if (limitTokens != null) parts.push(`${tokens == null ? 0 : tokens} of ${limitTokens} tokens`);
    return parts.length ? `stopped at its budget: ${parts.join(', ')} spent` : 'stopped at its budget';
}

function createAttempts({ store, config = {}, log = console, harnesses = null }) {
    const db = store.db;
    const catalog = harnesses || require('./harnesses').createHarnesses();
    // How many automatic continues one task may have before it needs a person (CODES_TASK_MAX_CONTINUES, two).
    const wanted = config.task ? config.task.maxContinues : undefined;
    const maxContinues = Number.isFinite(Number(wanted)) ? Math.max(0, Number(wanted)) : 2;

    const nameOf = (agent) => {
        const offer = agent ? catalog.get(agent) : null;
        return offer ? offer.name : (agent || 'the agent');
    };

    /** The attempts of a task, in order. A task written before the attempts (or by another path) still has a first one. */
    async function list(taskId) {
        if (!taskId) return [];
        const rows = await db.many('SELECT * FROM codes_attempts WHERE task_id = $1 ORDER BY n ASC', [taskId]);
        if (rows.length) return rows;
        const task = await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [taskId]);
        if (!task) return [];
        await db.exec(
            `INSERT INTO codes_attempts (id, task_id, n, agent, job_id, state, why, kind, started_at, finished_at, created_at)
             VALUES ($1, $2, 1, $3, $4, $5, $6, 'first', $7::timestamptz, $8::timestamptz, $9::timestamptz)
             ON CONFLICT DO NOTHING`,
            [store.newId('att'), task.id, task.agent || null, task.job_id || null, TASK_STATE[task.state] || 'failed',
                'the first attempt of this task', task.started_at || null, task.finished_at || null, store.iso()],
        );
        return await db.many('SELECT * FROM codes_attempts WHERE task_id = $1 ORDER BY n ASC', [taskId]);
    }

    /** One attempt. */
    async function get(id) {
        if (!id) return null;
        return await db.maybe('SELECT * FROM codes_attempts WHERE id = $1', [id]);
    }

    /** The attempt a job belongs to, or null. */
    async function byJob(jobId) {
        if (!jobId) return null;
        return await db.maybe('SELECT * FROM codes_attempts WHERE job_id = $1', [jobId]);
    }

    /**
     * One attempt. The fence: follow_up_of is unique, so an ending that starts a follow-up twice answers the same
     * attempt the second time and starts no second job. created tells the caller which of the two it was.
     */
    async function create({ task, agent = null, model = null, machine = null, session = null, why = null, kind = 'first', followUpOf = null, state = 'queued', budget = null }) {
        if (!task || !task.id) throw new Error('an attempt belongs to a task');
        for (let tries = 0; tries < 5; tries++) {
            const n = await db.one('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM codes_attempts WHERE task_id = $1', [task.id]);
            const id = store.newId('att');
            const inserted = await db.maybe(
                `INSERT INTO codes_attempts (id, task_id, n, agent, model, machine, session, state, why, kind, follow_up_of, budget_usd, budget_tokens, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz)
                 ON CONFLICT DO NOTHING RETURNING *`,
                [id, task.id, n.n, agent, model, machine, session, state, why, kind, followUpOf,
                    budget && Number(budget.usd) > 0 ? Number(budget.usd) : null,
                    budget && Number(budget.tokens) > 0 ? Math.round(Number(budget.tokens)) : null, store.iso()],
            );
            if (inserted) {
                await db.exec('UPDATE run_tasks SET attempts_count = $2 WHERE id = $1', [task.id, n.n]);
                return { attempt: inserted, created: true };
            }
            // Someone else wrote it: the same follow-up answers the same attempt.
            const seen = followUpOf ? await db.maybe('SELECT * FROM codes_attempts WHERE follow_up_of = $1', [followUpOf]) : null;
            if (seen) return { attempt: seen, created: false };
        }
        throw new Error('the attempt could not be written');
    }

    /** The Run job of an attempt. The session is set for a conductor's attempt, which outlives each turn's job. */
    async function bind(id, { job_id = null, state = null, started_at = null, machine = null, model = null, session = null, run_mode = null } = {}) {
        return await db.one(
            `UPDATE codes_attempts SET job_id = COALESCE($2, job_id),
                state = COALESCE($3, state),
                machine = COALESCE($4, machine),
                model = COALESCE($5, model),
                started_at = COALESCE($6::timestamptz, started_at),
                session = COALESCE($7, session),
                run_mode = COALESCE($8, run_mode)
             WHERE id = $1 RETURNING *`,
            [id, job_id, state, machine, model, started_at, session, run_mode],
        );
    }

    /** An attempt ended: its state, why, what it cost. */
    async function end(id, { state = 'failed', reason = null, why = null, cost_usd = null, tokens = null, steps = null, session = null, model = null, machine = null, budget_hit = null, finished_at = null } = {}) {
        return await db.one(
            `UPDATE codes_attempts SET state = $2,
                reason = COALESCE($3, reason),
                why = COALESCE($4, why),
                cost_usd = COALESCE($5::numeric, cost_usd),
                tokens = COALESCE($6, tokens),
                steps = COALESCE($7, steps),
                session = COALESCE($8, session),
                model = COALESCE($9, model),
                machine = COALESCE($10, machine),
                budget_hit = COALESCE($11, budget_hit),
                finished_at = COALESCE($12::timestamptz, finished_at)
             WHERE id = $1 RETURNING *`,
            [id, state, reason, why, cost_usd == null ? null : String(cost_usd), tokens, steps, session, model, machine, budget_hit, finished_at || store.iso()],
        );
    }

    /** What an attempt really spent, counted by OpenVibe.AI (a run refused for its budget stops mid-turn). */
    async function spend(id, { cost_usd = null, tokens = null } = {}) {
        return await db.one(
            `UPDATE codes_attempts SET cost_usd = COALESCE($2::numeric, cost_usd), tokens = COALESCE($3, tokens) WHERE id = $1 RETURNING *`,
            [id, cost_usd == null ? null : String(cost_usd), tokens],
        );
    }

    /** The engine's own vocabulary for Codes' harnesses: the ladder, the health, the catalogs and the fleet it routes
     *  with. Claude Code is off here: a sub-task is never an Anthropic one (the conductor's session is the exception). */
    function routing(fleet = null) {
        const subagents = {}; const models = {}; const runners = [];
        for (const [harnessId, runner] of Object.entries(RUNNER_OF)) {
            const offer = catalog.get(harnessId);
            if (!offer) continue;
            subagents[runner] = { enabled: harnessId !== 'claude-code', max: 4, model: null };
            models[runner] = (offer.agents || []).map((a) => a.model).filter(Boolean);
            runners.push(runner);
        }
        const health = {};
        for (const r of runners) health[r] = { state: 'ok' };
        const ladder = {};
        for (const tier of router.TIERS) {
            ladder[tier] = (TIER_ORDER[tier] || []).map((id) => {
                const runner = RUNNER_OF[id];
                // No model: each harness runs its own default (the offer's model is the harness's own label, not a
                // model id to pass on the command line). A caller that names a model still gets it through args.model.
                return [runner, null, TIER_EFFORT[tier]];
            }).filter(([runner]) => subagents[runner]);
        }
        return {
            cfg: { subagents, budget: config.budget || {}, fallback: { order: FALLBACK_ORDER.filter((r) => subagents[r] && subagents[r].enabled) } },
            health, counts: {}, models, runners, ladder, fleet,
        };
    }

    /**
     * The next agent for a task, from the engine's router (engine/router.js): the tier of the brief decides the
     * ladder, and the first harness of it that may take the task takes it. The agent that just stopped is skipped.
     */
    function nextAgent(prompt, ctx, exclude) {
        const usable = (runner) => {
            const sub = ctx.cfg.subagents[runner];
            if (!sub || !sub.enabled) return false;
            if ((ctx.counts[runner] || 0) >= sub.max) return false;
            const h = ctx.health[runner];
            if (!h || h.state !== 'ok') return false;
            // The fleet: no job goes to an agent whose window is full or that is not signed in on any machine.
            return router.roomFor(ctx.fleet, runner);
        };
        const picked = router.pick(prompt, ctx);
        const tier = picked ? picked.tier : router.classify(prompt).tier;
        const ladder = ctx.ladder[tier] || [];
        const shape = (runner, model, effort) => ({
            runner,
            agent: HARNESS_OF[runner] || null,
            model: model || null,
            effort: router.fitEffort(runner, effort),
            tier,
            why: picked ? picked.why : `${tier} → ${runner}`,
        });
        if (picked && picked.runner !== exclude && usable(picked.runner)) return shape(picked.runner, picked.model, picked.effort);
        for (const [runner, model, effort] of ladder) {
            if (runner === exclude || !usable(runner)) continue;
            const m = model && ctx.models[runner] && !ctx.models[runner].includes(model) ? null : model;
            return shape(runner, m, effort);
        }
        return null;
    }

    /** One attempt as the engine sees it. */
    function engineAttempt(a, all, facts = null) {
        const n = Number(a.n) || 1;
        const reason = a.reason && REASONS.includes(a.reason) ? a.reason : null;
        const next = all.find((x) => x.follow_up_of && x.follow_up_of === a.id);
        const prev = all.find((x) => Number(x.n) === n - 1);
        const created = a.created_at ? Date.parse(String(a.created_at)) : 0;
        return {
            key: a.id,
            runner: runnerOf(a.agent),
            name: n === 1 ? 'a' : `a-r${n}`,
            runnerName: nameOf(a.agent),
            status: ENGINE_STATE[a.state] || 'failed',
            // The order the engine reads the chain in: the attempt's place, never a tie.
            updated: created + n,
            attempt: n,
            error: reason ? ERROR_TEXT[reason] : null,
            // The engine reads the reason of a failed attempt out of what it said; Codes' attempts carry their own
            // reason, and the engine only reads the runners it knows, so it is passed on.
            reason: reason || null,
            next: next ? next.id : null,
            prev: prev ? prev.id : null,
            parent: a.follow_up_of || null,
            stopped: a.state === 'stopped',
            budget: reason === 'budget' ? { hit: a.budget_hit || 'steps' } : undefined,
            wrapUp: a.kind === 'wrap-up',
            hung: reason === 'hung',
            facts: {
                session: a.session || null,
                apiError: (facts && facts.apiError) || (reason ? ERROR_TEXT[reason] : null),
                hasFinal: !!(facts && facts.hasFinal),
                finalText: (facts && facts.finalText) || '',
            },
        };
    }

    /**
     * What the job's log says about the attempt: its last words (the engine reads them to know whether the agent
     * said it was done) and the error it ended with.
     */
    function factsOf(result) {
        const d = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
        const log = Array.isArray(d.log) ? d.log : [];
        let hasFinal = false; let finalText = ''; let apiError = '';
        for (const line of log) {
            if (!line || typeof line !== 'object') continue;
            if (line.t === 'done') {
                hasFinal = true;
                if (line.text) finalText = String(line.text);
                if (line.ok === false && !apiError) apiError = finalText || 'the agent ended without an answer';
            } else if (line.t === 'note' && line.level === 'error' && !apiError) {
                apiError = String(line.text || '');
            }
        }
        return { hasFinal, finalText, apiError };
    }

    /** The note a continued attempt gets: it keeps the work, it does not redo it. */
    function continuationNote(ending, words) {
        return `\n\n---\n## Continuation (written by openvibe.codes)\n\nAn earlier attempt${ending.agent ? ` on ${nameOf(ending.agent)}` : ''} ${words}. Keep the work it finished, do not redo it, and continue from where it stopped. If the task is already complete, check it and report that.\n`;
    }

    /** The note a new agent gets: what changed, what it said, where it stopped. */
    function handoverNote(ending, result, words) {
        const d = result && typeof result === 'object' ? result : {};
        const files = Array.isArray(d.files) ? d.files.map((f) => f && f.path).filter(Boolean).slice(0, 20) : [];
        const summary = clip(d.summary || '', 1200);
        return `\n\n---\n## Hand-over (written by openvibe.codes)\n\n${nameOf(ending.agent)} ${words}. Before it stopped it:\n`
            + `- changed: ${files.length ? files.join(', ') : 'nothing yet'}\n`
            + `- said: ${summary || 'nothing'}\n`
            + `- stopped at: ${words}\n\n`
            + 'Keep the work it did, do not redo it, and finish the task.\n';
    }

    /**
     * What happens after an attempt ends: the engine decides, this turns the decision into a plan.
     *
     * @param {object} what
     * @param {object} what.task the task row
     * @param {object[]} what.attempts every attempt of the task, in order
     * @param {object} what.ending the attempt that ended
     * @param {object} [what.result] the job's result (what it changed and what it said)
     * @returns {object} the plan: an outcome ('done', 'unfinished', 'stopped') or a follow-up attempt
     */
    function decide({ task, attempts, ending, result = null, fleet = null }) {
        const ctx = routing(fleet);
        const upto = (attempts || []).filter((a) => Number(a.n) <= Number(ending.n));
        const facts = factsOf(result);
        const engineAttempts = upto.map((a) => engineAttempt(a, upto, a.id === ending.id ? facts : null));
        const out = chain.outcome(engineAttempts, ctx);
        const step = out.step || { action: 'none' };
        const reason = ending.reason || out.reason || 'error';
        const words = wordsOf(reason);
        const continues = upto.filter((a) => a.kind === 'continue').length;

        // An attempt that ran out of money (OpenVibe.AI refused it) ends the task there: no wrap-up turn buys
        // another request the budget will not pay for, and no other agent takes over with the same cap.
        if (reason === 'budget' && ['usd', 'tokens'].includes(ending.budget_hit)) {
            return { outcome: 'unfinished', note: budgetNote(ending) };
        }
        if (step.action === 'done') return { outcome: 'done', note: 'the task finished' };
        if (step.action === 'stop') return { outcome: 'stopped', note: 'the task was stopped on purpose' };
        if (step.action === 'wait') return { outcome: null, note: null };

        if (step.action === 'wrap-up') {
            const hit = step.hit || 'steps';
            return {
                kind: 'wrap-up', agent: ending.agent, model: ending.model, session: ending.session || null,
                prompt: String(task.prompt || '') + budget.wrapUpPrompt(hit),
                why: `one last turn to land the work after the ${hit} limit`,
            };
        }

        if (step.action === 'continue') {
            if (continues >= maxContinues) {
                return { outcome: 'unfinished', note: `the task was carried on ${continues} times already; it needs a person` };
            }
            return {
                kind: 'continue', agent: ending.agent, model: ending.model, session: step.session || ending.session || null,
                prompt: String(task.prompt || '') + continuationNote(ending, words),
                why: `carried on in the same conversation: ${words}`,
            };
        }

        if (step.action === 'restart') {
            return {
                kind: 'restart', agent: ending.agent, model: ending.model, session: null,
                prompt: String(task.prompt || '') + continuationNote(ending, words),
                why: `started again with a fresh session: ${words}`,
            };
        }

        if (step.action === 'switch') {
            const choice = nextAgent(task.prompt, ctx, runnerOf(ending.agent));
            const agent = choice ? choice.agent : (step.runner ? HARNESS_OF[step.runner] : null);
            if (!agent) return { outcome: 'unfinished', note: `no other agent could take it: ${step.why || words}` };
            return {
                kind: 'switch', agent, model: choice ? choice.model : (step.model || null), session: null,
                prompt: String(task.prompt || '') + handoverNote(ending, result, words),
                why: `${nameOf(agent)} took over: ${words}`,
            };
        }

        return { outcome: 'unfinished', note: `${step.why || 'the task stopped'}. What is left is in the session.` };
    }

    /** An attempt as the API and the page show it. */
    function present(a) {
        if (!a) return null;
        return {
            id: a.id,
            n: Number(a.n) || 0,
            agent: a.agent || null,
            model: a.model || null,
            machine: a.machine || null,
            job_id: a.job_id || null,
            session: a.session || null,
            state: a.state,
            reason: a.reason || null,
            why: a.why || null,
            kind: a.kind || 'first',
            cost_usd: a.cost_usd == null ? null : Number(a.cost_usd),
            tokens: a.tokens == null ? null : Number(a.tokens),
            steps: a.steps == null ? null : Number(a.steps),
            started_at: iso(a.started_at),
            finished_at: iso(a.finished_at),
            created_at: iso(a.created_at),
            end_why: a.reason ? wordsOf(a.reason) : null,
        };
    }

    return {
        STATES, REASONS, KINDS, REASON_TEXT, RUNNER_OF, HARNESS_OF,
        list, get, byJob, create, bind, end, spend, decide, present, routing, nextAgent, nameOf, wordsOf, budgetNote,
    };
}

module.exports = { createAttempts, RUNNER_OF, HARNESS_OF, STATES, REASONS, KINDS, REASON_TEXT, ERROR_TEXT, budgetNote };
