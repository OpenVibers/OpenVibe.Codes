'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { createHarnesses } = require('../server/domain/harnesses');
const { plan } = require('openvibe-sdk/placement');
const { TASKS, toOffer, requirementsFor, route } = require('../server/domain/harness-placement');
const { check, done } = require('./helpers/boot');

const catalogPath = path.join(__dirname, '..', 'server', 'data', 'harness-offers.json');
const rows = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const now = Date.parse('2026-10-02T12:00:00Z');

function stub(list) {
    return { list: () => list, agents: (id) => (list.find((row) => row.id === id) || {}).agents || [] };
}

function priced(row, freshUsd) {
    const agent = { ...row.agents[0], price_per_1k_tokens: { ...row.agents[0].price_per_1k_tokens, fresh_usd: freshUsd } };
    return { ...row, agents: [agent] };
}

(async () => {
    await check('toOffer maps a seed harness and agent field by field', async () => {
        const harness = rows.find((row) => row.id === 'command-code');
        const agent = {
            ...rows[0].agents[0],
            id: 'command-code-test',
            harness: 'command-code',
            provider: 'example',
            context_limits: { input_tokens: 100000, output_tokens: 8000 },
            price_per_1k_tokens: { fresh_usd: 0.003, cached_usd: 0.0003, output_usd: 0.015 },
        };
        const { agents, ...row } = harness;
        assert.deepStrictEqual(toOffer(harness, agent, { trust: 'partner', health: 'degraded', latencyMs: 900, now }), {
            offer_id: 'command-code:command-code-test',
            kind: 'harness',
            provider: 'example',
            region: 'global',
            trust: 'partner',
            capabilities: ['task:edit', 'harness:host-access', 'harness:mcp', 'harness:resume', 'harness:edit', 'harness:tools', 'runtime:code'],
            capacity: { workers: { harness: 2 } },
            health: { status: 'degraded' },
            pricing: { model: 'per-operation', unit: 'token', marginal_usd_per_unit: 0.003 / 1000 },
            updated_at: '2026-10-02T12:00:00.000Z',
            detail: { ...row, limits: { ...row.limits, max_context_tokens: 100000 }, task_capabilities: ['edit'] },
            latency_ms: { run_p95: 900 },
        });

        const deepseek = rows.find((row) => row.id === 'deepseek');
        const offer = toOffer(deepseek, deepseek.agents[0]);
        assert.strictEqual(offer.offer_id, 'deepseek:deepseek-chat');
        assert.deepStrictEqual(offer.capabilities, []);
        assert.strictEqual(offer.trust, 'external');
        assert.deepStrictEqual(offer.health, { status: 'up' });
        assert.strictEqual('latency_ms' in offer, false);
        assert.strictEqual('max_context_tokens' in offer, false);
        assert.strictEqual(offer.detail.limits.max_context_tokens, 64000);
        assert.strictEqual('agents' in offer.detail, false);
        assert.strictEqual(toOffer(deepseek, { ...deepseek.agents[0], id: undefined }).offer_id, `deepseek:${deepseek.agents[0].model}`);
    });

    await check('every seed offer validates as platform.resource-offer@1 of kind harness', async () => {
        const harnesses = createHarnesses({ catalogPath });
        const offers = harnesses.list().flatMap((harness) => harnesses.agents(harness.id).map((agent) => [harness, toOffer(harness, agent, { now })]));
        assert.strictEqual(offers.length, 6);
        for (const [harness, offer] of offers) {
            const result = contracts.validate('platform.resource-offer@1', JSON.parse(JSON.stringify(offer)));
            assert.ok(result.valid, `${offer.offer_id}: ${JSON.stringify(result.errors)}`);
            assert.strictEqual(offer.detail.id, harness.id);
        }
        const browsing = { ...rows[0], task_capabilities: ['edit', 'browse'] };
        const offer = toOffer(browsing, browsing.agents[0], { now });
        assert.deepStrictEqual(offer.capabilities, ['task:edit', 'task:browse', 'harness:host-access', 'harness:mcp', 'harness:long-autonomy', 'harness:resume', 'harness:edit', 'harness:review', 'harness:tools', 'harness:vision', 'runtime:code']);
        assert.ok(contracts.validate('platform.resource-offer@1', JSON.parse(JSON.stringify(offer))).valid);
    });

    await check('requirementsFor maps each task and merges extras', async () => {
        assert.deepStrictEqual(requirementsFor('long').capabilities, TASKS.long);
        assert.deepStrictEqual(requirementsFor('review').capabilities, ['task:review']);
        const req = requirementsFor('edit', { trust: 'first-party', capabilities: ['harness:mcp'] });
        assert.deepStrictEqual(req.capabilities, ['task:edit', 'harness:mcp']);
        assert.deepStrictEqual(req.trust, ['first-party']);
        assert.strictEqual(req.objective, 'balanced');
    });

    await check('task capabilities derive from the capability booleans', async () => {
        const byId = new Map(rows.map((row) => [row.id, row]));
        const tasksOf = (id) => toOffer(byId.get(id), byId.get(id).agents[0]).detail.task_capabilities;
        assert.deepStrictEqual(tasksOf('claude-code'), ['edit', 'review']);
        assert.deepStrictEqual(tasksOf('command-code'), ['edit']);
        assert.deepStrictEqual(tasksOf('aider'), ['edit']);
        assert.deepStrictEqual(tasksOf('deepseek'), []);
        // An explicit task_capabilities list still overrides the booleans.
        const claude = byId.get('claude-code');
        assert.deepStrictEqual(toOffer({ ...claude, task_capabilities: ['edit', 'browse'] }, claude.agents[0]).detail.task_capabilities, ['edit', 'browse']);

        const harnesses = createHarnesses({ catalogPath });
        const review = route({ task: 'review', harnesses, now });
        for (const id of ['command-code:command-code-default', 'aider:aider-default', 'deepseek:deepseek-chat']) {
            assert.deepStrictEqual(review.candidates.find((c) => c.id === id), { id, included: false, reason: 'lacks task:review' });
        }
        assert.ok(!['command-code', 'aider', 'deepseek'].includes(review.selected.split(':')[0]));
        const edit = route({ task: 'edit', harnesses, now });
        assert.deepStrictEqual(edit.candidates.find((c) => c.id === 'deepseek:deepseek-chat'), { id: 'deepseek:deepseek-chat', included: false, reason: 'lacks task:edit' });
        assert.ok(edit.candidates.some((c) => c.id === 'command-code:command-code-default' && c.included));
    });

    await check('deepseek advertises no runtime class', async () => {
        const deepseek = rows.find((row) => row.id === 'deepseek');
        const offer = toOffer(deepseek, deepseek.agents[0]);
        assert.deepStrictEqual(offer.capabilities, []);
        assert.strictEqual('runtimes' in offer.detail.capabilities, false);
        // A bare runtime:code requirement no longer reaches the host-less API, but still reaches a code CLI.
        const req = { kind: 'harness.edit', mobility: 'job', latency_class: 'interactive', objective: 'balanced', capabilities: ['runtime:code'] };
        assert.strictEqual(plan(req, [offer], { now }).selected, null);
        const claude = rows.find((row) => row.id === 'claude-code');
        assert.strictEqual(plan(req, [toOffer(claude, claude.agents[0])], { now }).selected, 'claude-code:claude-code-sonnet');
    });

    await check('a review task selects a review-capable offer', async () => {
        const harnesses = createHarnesses({ catalogPath });
        const r = route({ task: 'review', harnesses, now });
        assert.ok(r.selected);
        const [harnessId] = r.selected.split(':');
        assert.ok(toOffer(harnesses.get(harnessId), harnesses.agents(harnessId)[0]).capabilities.includes('task:review'));
        assert.ok(r.reasons.length);
        assert.deepStrictEqual(r.candidates.map((c) => c.id), ['claude-code:claude-code-sonnet', 'codex:codex-default', 'command-code:command-code-default', 'opencode:opencode-default', 'aider:aider-default', 'deepseek:deepseek-chat']);
    });

    await check('an offer whose health is down is excluded with a reason', async () => {
        const harnesses = createHarnesses({ catalogPath });
        const r = route({ task: 'edit', harnesses, now, opts: { 'claude-code:claude-code-sonnet': { health: 'down' } } });
        assert.deepStrictEqual(r.candidates.find((c) => c.id === 'claude-code:claude-code-sonnet'), { id: 'claude-code:claude-code-sonnet', included: false, reason: 'health down' });
        assert.notStrictEqual(r.selected, 'claude-code:claude-code-sonnet');
    });

    await check('first-party trust excludes every external offer', async () => {
        const harnesses = createHarnesses({ catalogPath });
        const r = route({ task: 'edit', extra: { trust: 'first-party' }, harnesses, now, opts: { 'codex:codex-default': { trust: 'first-party' } } });
        assert.strictEqual(r.selected, 'codex:codex-default');
        for (const c of r.candidates.filter((c) => c.id !== 'codex:codex-default' && c.id !== 'deepseek:deepseek-chat')) {
            assert.deepStrictEqual(c, { id: c.id, included: false, reason: 'workload requires first-party trust' });
        }
        // Deepseek cannot edit, so it drops out on capabilities before trust is considered.
        assert.deepStrictEqual(r.candidates.find((c) => c.id === 'deepseek:deepseek-chat'), { id: 'deepseek:deepseek-chat', included: false, reason: 'lacks task:edit' });
        const none = route({ task: 'edit', extra: { trust: ['first-party'] }, harnesses, now });
        assert.strictEqual(none.selected, null);
        assert.ok(none.candidates.every((c) => !c.included));
    });

    await check('with equal latency the cheaper eligible offer wins', async () => {
        const [claude, codex] = rows;
        const harnesses = stub([priced(claude, 0.015), priced(codex, 0.003)]);
        const opts = { 'claude-code:claude-code-sonnet': { latencyMs: 500 }, 'codex:codex-default': { latencyMs: 500 } };
        const r = route({ task: 'edit', harnesses, opts, now });
        assert.strictEqual(r.selected, 'codex:codex-default');
        assert.ok(r.candidates.every((c) => c.included));
        const flipped = route({ task: 'edit', harnesses: stub([priced(claude, 0.001), priced(codex, 0.003)]), opts, now });
        assert.strictEqual(flipped.selected, 'claude-code:claude-code-sonnet');
    });

    await check('a task:browse requirement excludes harnesses without it', async () => {
        const [claude, codex] = rows;
        const harnesses = stub([{ ...claude, task_capabilities: ['edit', 'review', 'browse'] }, codex]);
        const r = route({ task: 'edit', extra: { capabilities: ['task:browse'] }, harnesses, now });
        assert.strictEqual(r.selected, 'claude-code:claude-code-sonnet');
        assert.deepStrictEqual(r.candidates.find((c) => c.id === 'codex:codex-default'), { id: 'codex:codex-default', included: false, reason: 'lacks task:browse' });
        const none = route({ task: 'edit', extra: { capabilities: ['task:browse'] }, harnesses: createHarnesses({ catalogPath }), now });
        assert.strictEqual(none.selected, null);
        for (const c of none.candidates.filter((c) => c.id !== 'deepseek:deepseek-chat')) {
            assert.strictEqual(c.reason, 'lacks task:browse');
        }
        // Deepseek drops on capabilities it lacks (edit) before task:browse.
        assert.deepStrictEqual(none.candidates.find((c) => c.id === 'deepseek:deepseek-chat'), { id: 'deepseek:deepseek-chat', included: false, reason: 'lacks task:edit' });
    });

    await check('a harness:vision requirement drops the vision:false harnesses', async () => {
        const harnesses = createHarnesses({ catalogPath });
        const r = route({ task: 'edit', extra: { capabilities: ['harness:vision'] }, harnesses, now });
        assert.ok(['claude-code:claude-code-sonnet', 'codex:codex-default'].includes(r.selected), `selected ${r.selected}`);
        for (const id of ['claude-code:claude-code-sonnet', 'codex:codex-default']) {
            assert.deepStrictEqual(r.candidates.find((c) => c.id === id), { id, included: true, reason: null });
        }
        assert.deepStrictEqual(r.candidates.find((c) => c.id === 'command-code:command-code-default'), { id: 'command-code:command-code-default', included: false, reason: 'lacks harness:vision' });
        assert.ok(toOffer(harnesses.get(r.selected.split(':')[0]), harnesses.agents(r.selected.split(':')[0])[0]).capabilities.includes('harness:vision'));
    });

    await check('an unknown task throws harness.task_unknown', async () => {
        assert.throws(() => requirementsFor('deploy'), (error) => error.code === 'harness.task_unknown');
        assert.throws(() => requirementsFor('toString'), (error) => error.code === 'harness.task_unknown');
        assert.throws(() => route({ task: 'deploy', harnesses: createHarnesses({ catalogPath }), now }), (error) => error.code === 'harness.task_unknown');
    });

    done();
})();
