'use strict';

/**
 * Harness placement: each harness × agent pair from the catalog (server/domain/harnesses.js) becomes one
 * openvibe-sdk/placement Offer, and the SDK planner picks where a coding task runs. Pure: no I/O.
 */
const contracts = require('openvibe-contracts');
const { plan } = require('openvibe-sdk/placement');

// A catalog row without task_capabilities takes edit and review.
const DEFAULT_TASKS = ['edit', 'review'];
// harness-offer@1 capability flag → the resource-offer@1 capability it adds when true.
const HARNESS_FLAGS = { host_access: 'harness:host-access', mcp: 'harness:mcp', long_autonomy: 'harness:long-autonomy', resume: 'harness:resume' };

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
    const tasks = row.task_capabilities || DEFAULT_TASKS;
    const maxContextTokens = (agent.context_limits && agent.context_limits.input_tokens) ?? limits.max_context_tokens;
    const health = typeof opts.health === 'string' ? { status: opts.health } : opts.health || { status: 'up' };
    const offer = {
        offer_id: `${harness.id}:${agent.id || agent.model}`,
        kind: 'harness',
        provider: agent.provider || harness.provider,
        region: 'global',
        trust: opts.trust || 'external',
        capabilities: [...tasks.map((task) => `task:${task}`), ...Object.keys(HARNESS_FLAGS).filter((name) => caps[name] === true).map((name) => HARNESS_FLAGS[name])],
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

function route({ task, extra = {}, harnesses, opts = {}, now = Date.now() }) {
    const req = requirementsFor(task, extra);
    const offers = harnesses.list().flatMap((harness) => harnesses.agents(harness.id).map((agent) => {
        const id = `${harness.id}:${agent.id || agent.model}`;
        return toOffer(harness, agent, { now, ...opts[id] });
    }));
    const result = plan(req, offers, { now });
    // The Contracts compat gate refused widening placement-result@1 `selected` to null: a plan with nothing selected skips the check.
    if (result.selected !== null) {
        const check = contracts.validate('platform.placement-result@1', JSON.parse(JSON.stringify(result)));
        if (!check.valid) {
            const error = new Error(`invalid placement result: ${JSON.stringify(check.errors)}`);
            error.code = 'harness.placement_invalid';
            throw error;
        }
    }
    return {
        selected: result.selected,
        reasons: result.reasons,
        candidates: result.candidates.map((c) => ({ id: c.id, included: c.eligible, reason: c.excluded_because || null })),
    };
}

module.exports = { TASKS, toOffer, requirementsFor, route };
