'use strict';

const assert = require('node:assert/strict');
const { PRESETS } = require('../engine/model-plan');
const { firstChecks, weeklySummary, tuningSuggestions } = require('../engine/model-plan-outcomes');

const row = (passed) => ({
    state: 'succeeded', preset: 'Fast', role_runs: [{ role: 'builder', model: 'openvibe/economy', tokens: 100, cost_usd: 0.02, duration_ms: 1000 }],
    result: { ok: true, log: [{ t: 'step', phase: 'tests', text: `tests: ${passed ? 'passed' : 'failed'}` }, { t: 'step', phase: 'tests', text: 'tests: passed' }] },
});
assert.equal(firstChecks(row(false).result), false, 'first attempt matters even if a later check passes');
const summary = weeklySummary([row(false), row(false), row(false), row(false), row(true)]);
assert.equal(summary.presets[0].tasks, 5);
assert.equal(summary.presets[0].done, 5);
assert.equal(summary.presets[0].checks_first_time, 1);
assert.equal(summary.models[0].key, 'openvibe/economy');
assert.equal(summary.models[0].cost_usd, 0.1);
const suggestions = tuningSuggestions(summary, PRESETS);
assert.equal(suggestions.length, 1);
assert.equal(suggestions[0].preset, 'Fast');
assert.equal(suggestions[0].after, 'medium');
assert.equal(PRESETS.Fast.roles[0].effort, 'low', 'reading outcomes never tunes defaults');
assert.deepEqual(tuningSuggestions(weeklySummary([row(false)]), PRESETS), [], 'a small sample does not tune');
console.log('model plan outcomes: weekly preset/model counts and owner-only tuning proposal');
