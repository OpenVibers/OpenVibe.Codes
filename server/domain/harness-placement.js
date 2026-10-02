'use strict';

/**
 * Harness placement: each harness × agent pair from the catalog (server/domain/harnesses.js) becomes one
 * openvibe-sdk/placement Offer, and the SDK planner picks where a coding task runs. Pure: no I/O.
 */
const contracts = require('openvibe-contracts');
const { plan } = require('openvibe-sdk/placement');

// Every coding harness offers edit and review until task capabilities reach harness-offer@1.
const BASE_CAPABILITIES = ['edit', 'review'];
const HARNESS_CAPABILITIES = ['host_access', 'mcp', 'long_autonomy', 'resume'];

const TASKS = Object.freeze({
    edit: ['edit'],
    review: ['review'],
    long: ['edit', 'long_autonomy'],
    resume: ['resume'],
});

function toOffer(harness, agent, opts = {}) {
    const caps = harness.capabilities || {};
    const limits = harness.limits || {};
    const health = typeof opts.health === 'string' ? { status: opts.health } : opts.health || { status: 'up' };
    const offer = {
        offer_id: `${harness.id}:${agent.id || agent.model}`,
        kind: 'provider',
        provider: agent.provider || harness.provider,
        region: 'global',
        trust: opts.trust || 'external',
        capabilities: [...BASE_CAPABILITIES, ...HARNESS_CAPABILITIES.filter((name) => caps[name] === true)],
        capacity: { workers: { harness: limits.max_concurrent_runs } },
        health,
        pricing: { model: 'per-operation', unit: 'token', marginal_usd_per_unit: agent.price_per_1k_tokens.fresh_usd / 1000 },
        // Not an SDK Offer field: the planner ignores it; kept for callers sizing a run.
        max_context_tokens: (agent.context_limits && agent.context_limits.input_tokens) ?? limits.max_context_tokens,
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
        return toOffer(harness, agent, opts[id] || {});
    }));
    const result = plan(req, offers, { now });
    // placement-result@1 types `selected` as a string, so a plan with no eligible candidate cannot validate.
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
