'use strict';

/**
 * Harness placement: each harness × agent pair from the catalog (server/domain/harnesses.js) becomes one
 * openvibe-sdk/placement Offer, and the SDK planner picks where a coding task runs. Pure: no I/O.
 */
const contracts = require('openvibe-contracts');
const { place, optionKey } = require('openvibe-sdk/placement');

// A catalog row without task_capabilities derives its task kinds from the capability booleans:
// edit needs capabilities.edit === true, review needs capabilities.review === true.
const TASK_FLAGS = ['edit', 'review'];

function tasksFor(caps) {
    return TASK_FLAGS.filter((task) => caps[task] === true);
}

// harness-offer@1 capability flag → the resource-offer@1 capability it adds when true.
const HARNESS_FLAGS = {
    host_access: 'harness:host-access', mcp: 'harness:mcp', long_autonomy: 'harness:long-autonomy', resume: 'harness:resume',
    edit: 'harness:edit', review: 'harness:review', tools: 'harness:tools', vision: 'harness:vision', browser: 'harness:browser', computer_use: 'harness:computer-use',
};

const TASKS = Object.freeze({
    edit: ['task:edit'],
    review: ['task:review'],
    long: ['task:edit', 'harness:long-autonomy'],
    resume: ['harness:resume'],
});

/** One platform.resource-offer@1 of kind harness; its detail is the catalog row as platform.harness-offer@1. */
function toOffer(harness, agent, opts = {}) {
    const { agents, ...row } = harness;
    const caps = row.capabilities || {};
    const limits = row.limits || {};
    const tasks = row.task_capabilities || tasksFor(caps);
    const maxContextTokens = (agent.context_limits && agent.context_limits.input_tokens) ?? limits.max_context_tokens;
    const health = typeof opts.health === 'string' ? { status: opts.health } : opts.health || { status: 'up' };
    const offer = {
        offer_id: `${harness.id}:${agent.id || agent.model}`,
        kind: 'harness',
        provider: agent.provider || harness.provider,
        region: 'global',
        trust: opts.trust || 'external',
        capabilities: [...tasks.map((task) => `task:${task}`), ...Object.keys(HARNESS_FLAGS).filter((name) => caps[name] === true).map((name) => HARNESS_FLAGS[name]), ...(caps.runtimes || []).map((runtime) => `runtime:${runtime}`)],
        capacity: { workers: { harness: limits.max_concurrent_runs } },
        health,
        pricing: { model: 'per-operation', unit: 'token', marginal_usd_per_unit: agent.price_per_1k_tokens.fresh_usd / 1000 },
        updated_at: new Date(opts.now ?? Date.now()).toISOString(),
        detail: {
            ...row,
            limits: maxContextTokens == null ? limits : { ...limits, max_context_tokens: maxContextTokens },
            task_capabilities: [...tasks],
        },
    };
    if (opts.latencyMs != null) offer.latency_ms = { run_p95: opts.latencyMs };
    return offer;
}

function requirementsFor(task, extra = {}) {
    if (!Object.prototype.hasOwnProperty.call(TASKS, task)) {
        const error = new Error(`unknown harness task: ${task}`);
        error.code = 'harness.task_unknown';
        throw error;
    }
    const req = {
        kind: `harness.${task}`,
        mobility: 'job',
        latency_class: 'interactive',
        objective: 'balanced',
        ...extra,
        capabilities: [...new Set([...TASKS[task], ...(extra.capabilities || [])])],
    };
    if (typeof req.trust === 'string') req.trust = [req.trust];
    return req;
}

/**
 * Route a task with place() (placement A1): the SDK adds the person's rules, Bench priors, the learned counts and the
 * one line saying why. Everything stays pure: the caller reads the settings, the Bench priors (cached an hour) and the
 * outcomes (one read) into `context`, never this function.
 *
 * context: { person, rules, priorsByOfferId, outcomes, names, current, ownMachine, onlyAgent, floor }
 *   ownMachine  the person's own machine when noCloud is set: { name, agents: [harness ids] }
 *   onlyAgent   the agent the person chose, when the task named one
 */
function route({ task, extra = {}, harnesses, opts = {}, now = Date.now(), context = {} }) {
    const req = requirementsFor(task, extra);
    const wanted = context.onlyAgent || null;
    const names = { ...(context.names || {}) };
    let offers = harnesses.list().flatMap((harness) => harnesses.agents(harness.id).map((agent) => {
        const id = `${harness.id}:${agent.id || agent.model}`;
        return toOffer(harness, agent, { now, ...opts[id] });
    }));
    if (wanted) offers = offers.filter((offer) => offer.detail.id === wanted);
    // The person's own machine: noCloud turns each harness it runs into that person's own offer, so the SDK's rule
    // keeps the task there. With no such machine the offers stay external and the rule rejects every one.
    const own = context.rules && context.rules.noCloud ? context.ownMachine : null;
    if (own) {
        const runs = new Set(own.agents || []);
        offers = offers.filter((offer) => runs.has(offer.detail.id)).map((offer) => ({
            ...offer, trust: 'user-owned', owner: context.person,
        }));
    }
    // The line names the harness as the catalog does ("Codex", "Claude Code"), never its offer id, in both modes.
    for (const offer of offers) if (!names[offer.offer_id]) names[offer.offer_id] = offer.detail.name;
    // onlyFree: a paid harness is out; the person's own machine (owned capacity) and a free offer stay. The SDK's rule
    // also sets max_cost_usd 0, but Codes' catalog has no rate card to price a token with, so the price is read here.
    if (context.rules && context.rules.onlyFree) {
        offers = offers.filter((offer) => (offer.trust === 'user-owned' && offer.owner === context.person)
            || !(Number(offer.pricing && offer.pricing.marginal_usd_per_unit) > 0));
    }
    const priors = {};
    for (const offer of offers) {
        const score = context.priorsByOfferId ? context.priorsByOfferId[offer.offer_id] : undefined;
        if (score != null) priors[optionKey(offer)] = score;
    }
    const placed = place(req, offers, {
        now,
        person: context.person || null,
        step: { kind: `harness.${task}` },
        floor: context.floor,
        priors,
        outcomes: context.outcomes || [],
        rules: context.rules || {},
        names,
        current: context.current || null,
    });
    const result = placed.result;
    // The Contracts compat gate refused widening placement-result@1 `selected` to null: a plan with nothing selected skips the check.
    if (result.selected !== null) {
        const check = contracts.validate('platform.placement-result@1', JSON.parse(JSON.stringify(result)));
        if (!check.valid) {
            const error = new Error(`invalid placement result: ${JSON.stringify(check.errors)}`);
            error.code = 'harness.placement_invalid';
            throw error;
        }
    }
    const selectedOffer = result.selected ? offers.find((offer) => offer.offer_id === result.selected) : null;
    return {
        selected: result.selected,
        reasons: result.reasons,
        candidates: result.candidates.map((c) => ({ id: c.id, included: c.eligible, reason: c.excluded_because || null })),
        explain: { line: placed.line, ranked: placed.ranked, rejected: placed.rejected },
        option_key: selectedOffer ? optionKey(selectedOffer) : null,
        line: placed.line,
    };
}

module.exports = { TASKS, toOffer, requirementsFor, route };
