'use strict';
// The reasoning level a harness accepts, ported from the portal's test-effort-fit.js. The 2026-10-29 incident: a job
// retried on another runner copied cx's "medium" to Command Code, which died before its first step ("Unknown effort
// \"medium\". Supported: off, low, high, max."). Levels are also uneven (off and ultra exist on one harness only), so
// the ordering must know them all or a cross-runner value passes through untouched.
//
// The blocked-model list, from the portal's test-blocked-models.js: a model the provider refuses is replaced by one it
// still lists, and a launch with nothing left is an error, never a silent run with a refused model.

const assert = require('node:assert/strict');
const { check, done } = require('./helpers/boot');
const { fitEffort, stepUp, EFFORTS, pickModel, blockModel, unblockModel, isBlocked, harnessOf } = require('../engine/effort');

const ALL = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

(async () => {
    await check('every level a harness offers is a level the ordering knows', () => {
        for (const [harness, list] of Object.entries(EFFORTS)) {
            for (const level of list) assert.ok(ALL.includes(level), `${harness} offers ${level}, which fitEffort does not order`);
        }
    });

    await check('whatever comes in, the result is accepted by the harness', () => {
        for (const [harness, list] of Object.entries(EFFORTS)) {
            for (const level of ALL) {
                const got = fitEffort(harness, level);
                if (list.length) assert.ok(list.includes(got), `${harness} would be handed ${got} for ${level}`);
                else assert.equal(got, level, `${harness} has no effort setting: ${level} passes through`);
            }
        }
    });

    await check('the reported case and the neighbours it must not break', () => {
        assert.equal(fitEffort('cc', 'medium'), 'high');
        assert.equal(fitEffort('cc', 'xhigh'), 'max');
        assert.equal(fitEffort('cc', 'ultra'), 'max');
        assert.equal(fitEffort('cc', 'off'), 'off');
        assert.equal(fitEffort('cx', 'off'), 'low');
        assert.equal(fitEffort('dsh', 'medium'), 'high');
        assert.equal(fitEffort('cc', 'high'), 'high', 'an accepted level is left alone');
        assert.equal(fitEffort('cc', null), null);
    });

    await check('Codes\' harness names are the same harnesses', () => {
        assert.equal(harnessOf('command-code'), 'cc');
        assert.equal(harnessOf('codex'), 'cx');
        assert.equal(harnessOf('opencode'), 'oc');
        assert.equal(harnessOf('claude-code'), 'claude');
        assert.equal(harnessOf('deepseek'), 'dsh');
        assert.equal(fitEffort('command-code', 'medium'), 'high');
        assert.equal(fitEffort('claude-code', 'high'), 'high');
    });

    await check('a retry goes one level up', () => {
        assert.equal(stepUp('medium', EFFORTS.cc), 'high');
        assert.equal(stepUp('max', EFFORTS.cc), 'max');
        assert.equal(stepUp('medium', EFFORTS.cx), 'high');
    });

    await check('a blocked model is replaced by one the harness still lists', () => {
        const blockedModels = { cx: ['gpt-6.1-sol', 'gpt-6.1-terra'] };
        const models = { cx: ['gpt-6.1-sol', 'gpt-6-sol'] };
        assert.equal(pickModel({ runner: 'cx', model: 'gpt-6.1-sol', models, blockedModels }), 'gpt-6-sol');
        assert.equal(pickModel({ runner: 'cx', model: 'gpt-6.1-terra', models, blockedModels }), 'gpt-6-sol');
        assert.equal(pickModel({ runner: 'cx', model: 'gpt-6-sol', models, blockedModels }), 'gpt-6-sol', 'an unblocked model is left alone');
        assert.equal(pickModel({ runner: 'cx', model: null, models, blockedModels }), null, 'no model asked for, none forced');
    });

    await check('a launch with nothing unblocked left is an error', () => {
        const blockedModels = { cx: ['gpt-6.1-sol', 'gpt-6-sol'] };
        const models = { cx: ['gpt-6.1-sol', 'gpt-6-sol'] };
        assert.throws(() => pickModel({ runner: 'cx', model: 'gpt-6.1-sol', models, blockedModels }), /No unblocked model/);
    });

    await check('a model is blocked only when the provider says it does not have it', () => {
        assert.deepEqual(blockModel([], 'gpt-6.1-sol', 'model_not_found'), ['gpt-6.1-sol']);
        assert.deepEqual(blockModel([], 'gpt-6.1-sol', 'not available on your plan'), ['gpt-6.1-sol']);
        assert.deepEqual(blockModel([], 'gpt-6.1-sol', 'the connection was reset'), [], 'a crash is not a missing model');
        assert.deepEqual(blockModel(['gpt-6.1-sol'], 'gpt-6.1-sol', 'model_not_found'), ['gpt-6.1-sol'], 'no twice');
        assert.deepEqual(unblockModel(['a', 'b'], 'a'), ['b']);
        assert.equal(isBlocked({ cx: ['x'] }, 'cx', 'x'), true);
        assert.equal(isBlocked({ cx: ['x'] }, 'cx', 'y'), false);
    });

    done();
})();
