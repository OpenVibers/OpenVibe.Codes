'use strict';

/**
 * The per-task budget: how far one task may go before it is ended cleanly.
 *
 * Three limits, all optional: steps (tool calls), minutes (wall clock since the task started) and dollars (what the
 * task's own feed reported). A limit that is not set is no limit: an unknown price means no USD limit, never a zero
 * budget. The defaults come from the config, the runner may have its own, and a single task may override them.
 *
 * When a limit is reached the task stops politely and says so ("budget-stopped"), it is not a failure. Steps and
 * minutes buy one wrap-up turn, so the work already done lands (a commit, a push, a report) instead of sitting in a
 * worktree. Dollars stay a hard stop: the owner's money does not get a farewell turn.
 *
 * Everything here is pure: the caller passes the numbers it already has.
 */

/** The states a task goes through. */
const STATES = ['queued', 'running', 'done', 'failed', 'budget-stopped'];

/** The limits a task runs under: the config's defaults, then the runner's own, then the task's override. */
function limitsFor(cfg, runner, override) {
    const b = (cfg && cfg.budget) || {};
    const per = (b.perRunner && b.perRunner[runner]) || {};
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
    const out = {
        steps: num(per.steps != null ? per.steps : b.steps),
        minutes: num(per.minutes != null ? per.minutes : b.minutes),
        usd: num(per.usd != null ? per.usd : b.usd),
    };
    if (override && typeof override === 'object') {
        for (const k of ['steps', 'minutes', 'usd']) if (override[k] != null) out[k] = num(override[k]);
    }
    return out;
}

/**
 * Compare what a task spent with its limits. The first limit reached wins (steps, then minutes, then dollars).
 *
 * @param {object} used what it spent: { steps, minutes, usd }
 * @param {object} limits what it may spend: { steps, minutes, usd }
 * @returns {{hit: string|null, limits: object, used: object}} which limit was reached, if any
 */
function evaluate(used = {}, limits = {}) {
    const spent = {
        steps: Number(used.steps || 0),
        minutes: used.minutes == null ? null : Number(used.minutes),
        usd: used.usd == null ? null : Number(used.usd),
    };
    const cap = {
        steps: limits.steps == null ? null : Number(limits.steps),
        minutes: limits.minutes == null ? null : Number(limits.minutes),
        usd: limits.usd == null ? null : Number(limits.usd),
    };
    let hit = null;
    if (cap.steps != null && spent.steps >= cap.steps) hit = 'steps';
    else if (cap.minutes != null && spent.minutes != null && spent.minutes >= cap.minutes) hit = 'minutes';
    else if (cap.usd != null && spent.usd != null && spent.usd >= cap.usd) hit = 'usd';
    return {
        hit,
        limits: cap,
        used: { steps: spent.steps, minutes: spent.minutes == null ? null : Math.round(spent.minutes * 10) / 10, usd: spent.usd },
    };
}

/** The state of a task from its status: a task that stopped on a limit is 'budget-stopped', never a vague 'failed'. */
function state(status) {
    if (status === 'running' || status === 'queued') return status;
    if (status === 'budget-stopped') return 'budget-stopped';
    if (status === 'failed' || status === 'interrupted') return 'failed';
    return 'done';
}

/**
 * The one turn a task gets after its steps or minutes ran out: land the work, do not start anything new.
 *
 * @param {string} hit which limit was reached
 * @returns {string} the prompt of the wrap-up turn
 */
function wrapUpPrompt(hit) {
    return `You reached your ${hit} limit, so this is one short last turn to land the work. Do not start anything new.
1. Run the tests your change touches. Commit what passes and push it. Open the PR if there is none.
2. If something is half done, leave it out of the commit and say exactly what is left.
3. Stop any local server or browser you started.
4. End with a report: what landed (PRs), what is left, and anything the orchestrator must decide.`;
}

/**
 * The wrap-up rule: one turn after a steps or minutes stop, never after a dollar stop.
 *
 * @param {string} hit which limit was reached ('steps', 'minutes' or 'usd')
 * @param {object} [opts]
 * @param {boolean} [opts.done] the wrap-up turn already ran
 * @returns {{action: 'wrap-up'|'stop', prompt: string|null, why: string}} what to do now
 */
function wrapUp(hit, opts = {}) {
    if (hit === 'usd') return { action: 'stop', prompt: null, why: 'a dollar limit is a hard stop: no wrap-up turn' };
    if (opts.done) return { action: 'stop', prompt: null, why: 'the wrap-up turn already ran' };
    if (!hit) return { action: 'stop', prompt: null, why: 'no limit was reached' };
    return { action: 'wrap-up', prompt: wrapUpPrompt(hit), why: `one last turn to land the work after the ${hit} limit` };
}

module.exports = { STATES, limitsFor, evaluate, state, wrapUp, wrapUpPrompt };
