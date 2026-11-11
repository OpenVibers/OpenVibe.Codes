'use strict';

const assert = require('node:assert/strict');
const { PRESETS, validatePlan, fitEffort, resolvePlan, executePlan } = require('../engine/model-plan');

assert.throws(() => validatePlan({ mode: 'pair', roles: [{ role: 'builder', model: 'auto', effort: 'high' }], checks: { tests: true } }), /reviewer/);
assert.equal(fitEffort('medium', ['low', 'high']), 'high');
const registry = { entries: [{ id: 'openvibe/economy', state: 'ok', output_nano_usd_per_m: '1000000', efforts: ['low', 'high'] }, { id: 'openvibe/auto', state: 'ok' }, { id: 'gone/model@1', state: 'bad' }] };
const fallback = resolvePlan({ mode: 'escalate', roles: [{ role: 'builder', model: 'gone/model@1', effort: 'medium' }], ladder: ['openvibe/economy', 'openvibe/auto'], checks: { tests: true } }, registry);
assert.equal(fallback.plan.roles[0].model, 'openvibe/economy');
assert.equal(fallback.plan.roles[0].effort, 'high');
assert.equal(fallback.fallbacks[0].reason, 'unavailable in AI registry');

(async () => {
    const phases = [];
    let tests = 0;
    const single = await executePlan(PRESETS.Fast, {
        task: 'fix the parser',
        invoke: async (call) => { phases.push(call.phase); return { ok: true, text: call.phase === 'verify' ? 'PASS' : 'fixed', tokens: 40, cost_usd: 0.01, duration_ms: 5 }; },
        check: async (kind) => { tests++; return { kind, ok: true }; }, diff: async () => 'diff --git a/parser.js b/parser.js',
    });
    assert.equal(single.ok, true);
    assert.deepEqual(phases, ['build', 'verify']);
    assert.equal(tests, 2, 'verifier repeats the test');
    assert.deepEqual(single.role_runs.map((r) => r.role), ['builder', 'verifier']);
    assert.equal(single.role_runs[0].tokens, 40);

    const pairPhases = [];
    let reviews = 0;
    const pair = await executePlan(PRESETS.Balanced, {
        task: 'fix a bug',
        invoke: async (call) => {
            pairPhases.push(call.phase);
            if (call.phase === 'review') return { ok: true, text: JSON.stringify({ approved: ++reviews > 1, confidence: 0.9, reason: 'cover the edge case' }) };
            return { ok: true, text: 'PASS' };
        }, check: async (kind) => ({ kind, ok: true }), diff: async () => 'a useful patch',
    });
    assert.equal(pair.ok, true);
    assert.deepEqual(pairPhases, ['build', 'review', 'repair', 'review', 'verify']);
    assert.equal(pair.role_runs.filter((r) => r.phase === 'repair').length, 1);
    const refusedReview = await executePlan(PRESETS.Balanced, {
        task: 'fix a bug',
        invoke: async (call) => call.phase === 'review'
            ? { ok: false, text: '{"approved":true,"confidence":0.9}', refused: true }
            : { ok: true, text: 'PASS' },
        check: async (kind) => ({ kind, ok: true }), diff: async () => 'patch',
    });
    assert.equal(refusedReview.ok, false, 'a refused reviewer cannot approve a task');

    const councilPhases = [];
    const council = await executePlan(PRESETS.Council, {
        task: 'build the feature',
        invoke: async (call) => { councilPhases.push(call.phase); return { ok: true, text: call.phase === 'review' ? '{"approved":true,"confidence":0.8}' : 'PASS' }; },
        check: async (kind) => ({ kind, ok: true }), diff: async () => 'patch',
    });
    assert.equal(council.ok, true);
    assert.equal(councilPhases.filter((p) => p === 'propose').length, 3);
    assert.ok(councilPhases.includes('judge'));

    const escalated = await executePlan({ mode: 'escalate', roles: [{ role: 'builder', model: 'auto', effort: 'low' }], ladder: ['openvibe/economy', 'openvibe/auto'], checks: { tests: true } }, {
        task: 'fix a test',
        invoke: async (call) => call.model === 'openvibe/economy' ? { ok: false, refused: true, text: 'unavailable' } : { ok: true, text: 'PASS' },
        check: async (kind) => ({ kind, ok: true }), diff: async () => 'patch',
    });
    assert.equal(escalated.ok, true);
    assert.equal(escalated.reasons[0], 'model refusal');
    assert.deepEqual(escalated.role_runs.filter((r) => r.phase === 'build').map((r) => r.model), ['openvibe/economy', 'openvibe/auto']);
    console.log('model plans: validation, fallback, single, pair repair, council judge, escalation and repeat checks');
})().catch((error) => { console.error(error); process.exitCode = 1; });
