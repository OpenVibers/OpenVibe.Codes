'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHarnesses } = require('../server/domain/harnesses');
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
        assert.deepStrictEqual(toOffer(harness, agent, { trust: 'partner', health: 'degraded', latencyMs: 900 }), {
            offer_id: 'command-code:command-code-test',
            kind: 'provider',
            provider: 'example',
            region: 'global',
            trust: 'partner',
            capabilities: ['edit', 'review', 'host_access', 'mcp', 'resume'],
            capacity: { workers: { harness: 2 } },
            health: { status: 'degraded' },
            pricing: { model: 'per-operation', unit: 'token', marginal_usd_per_unit: 0.003 / 1000 },
            max_context_tokens: 100000,
            latency_ms: { run_p95: 900 },
        });

        const deepseek = rows.find((row) => row.id === 'deepseek');
        const offer = toOffer(deepseek, deepseek.agents[0]);
        assert.strictEqual(offer.offer_id, 'deepseek:deepseek-chat');
        assert.deepStrictEqual(offer.capabilities, ['edit', 'review']);
        assert.strictEqual(offer.trust, 'external');
        assert.deepStrictEqual(offer.health, { status: 'up' });
        assert.strictEqual('latency_ms' in offer, false);
        assert.strictEqual(offer.max_context_tokens, 64000);
        assert.strictEqual(toOffer(deepseek, { ...deepseek.agents[0], id: undefined }).offer_id, `deepseek:${deepseek.agents[0].model}`);
    });

    await check('requirementsFor maps each task and merges extras', async () => {
        assert.deepStrictEqual(requirementsFor('long').capabilities, TASKS.long);
        const req = requirementsFor('edit', { trust: 'first-party', capabilities: ['mcp'] });
        assert.deepStrictEqual(req.capabilities, ['edit', 'mcp']);
        assert.deepStrictEqual(req.trust, ['first-party']);
        assert.strictEqual(req.objective, 'balanced');
    });

    await check('a review task selects a review-capable offer', async () => {
        const harnesses = createHarnesses({ catalogPath });
        const r = route({ task: 'review', harnesses, now });
        assert.ok(r.selected);
        const [harnessId] = r.selected.split(':');
        assert.ok(toOffer(harnesses.get(harnessId), harnesses.agents(harnessId)[0]).capabilities.includes('review'));
        assert.ok(r.reasons.length);
        assert.deepStrictEqual(r.candidates.map((c) => c.id), ['claude-code:claude-code-sonnet', 'codex:codex-default', 'deepseek:deepseek-chat']);
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
        for (const c of r.candidates.filter((c) => c.id !== 'codex:codex-default')) {
            assert.deepStrictEqual(c, { id: c.id, included: false, reason: 'workload requires first-party trust' });
        }
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

    await check('an unknown task throws harness.task_unknown', async () => {
        assert.throws(() => requirementsFor('deploy'), (error) => error.code === 'harness.task_unknown');
        assert.throws(() => requirementsFor('toString'), (error) => error.code === 'harness.task_unknown');
        assert.throws(() => route({ task: 'deploy', harnesses: createHarnesses({ catalogPath }), now }), (error) => error.code === 'harness.task_unknown');
    });

    done();
})();
