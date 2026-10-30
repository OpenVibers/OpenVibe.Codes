'use strict';
// The per-task budget, ported from the portal's jobbudget.js: steps, minutes and dollars, and the wrap-up turn that
// lands the work when the steps or the minutes run out. Dollars stay a hard stop.

const assert = require('node:assert/strict');
const { check, done } = require('./helpers/boot');
const { limitsFor, caps, evaluate, state, wrapUp, wrapUpPrompt, STATES } = require('../engine/budget');

(async () => {
    await check('the limits are the config\'s, then the runner\'s, then the task\'s', () => {
        const cfg = { budget: { steps: 100, minutes: 60, usd: 5, perRunner: { cc: { steps: 50 } } } };
        assert.deepEqual(limitsFor(cfg, 'mm'), { steps: 100, minutes: 60, usd: 5 });
        assert.deepEqual(limitsFor(cfg, 'cc'), { steps: 50, minutes: 60, usd: 5 });
        assert.deepEqual(limitsFor(cfg, 'mm', { steps: 10, usd: 1 }), { steps: 10, minutes: 60, usd: 1 });
        assert.deepEqual(limitsFor({}, 'mm'), { steps: null, minutes: null, usd: null });
    });

    await check('a limit that is not set is no limit, never a zero budget', () => {
        assert.deepEqual(limitsFor({ budget: { steps: 0, minutes: -1, usd: 'many' } }, 'mm'), { steps: null, minutes: null, usd: null });
        assert.equal(evaluate({ steps: 100000 }, limitsFor({}, 'mm')).hit, null);
    });

    await check('the harness caps follow the limits: 25 turns and 5 minutes above, or none', () => {
        assert.deepEqual(caps({ steps: 350, minutes: 45 }), { maxTurns: 375, timeoutMs: 50 * 60_000, timeout: '50m' });
        assert.deepEqual(caps({ steps: 200, minutes: 90 }), { maxTurns: 225, timeoutMs: 95 * 60_000, timeout: '95m' });
        // No limit means none: the harness's own cap is effectively off, and the wall clock is no timer at all.
        const none = caps({ steps: null, minutes: null });
        assert.equal(none.maxTurns, 100000);
        assert.equal(none.timeoutMs, 0);
        assert.equal(none.timeout, '100000m');
        assert.deepEqual(caps({}), none);
        assert.deepEqual(caps({ steps: 0, minutes: 0 }), none);
    });

    await check('the first limit reached wins', () => {
        const limits = { steps: 100, minutes: 60, usd: 5 };
        assert.equal(evaluate({ steps: 120, minutes: 90, usd: 9 }, limits).hit, 'steps');
        assert.equal(evaluate({ steps: 10, minutes: 90, usd: 9 }, limits).hit, 'minutes');
        assert.equal(evaluate({ steps: 10, minutes: 20, usd: 9 }, limits).hit, 'usd');
        assert.equal(evaluate({ steps: 10, minutes: 20, usd: 1 }, limits).hit, null);
    });

    await check('an unknown spend is not a reason to stop', () => {
        assert.equal(evaluate({ steps: 1, minutes: null, usd: null }, { steps: 100, minutes: 60, usd: 5 }).hit, null);
        const out = evaluate({ steps: 1, minutes: null, usd: null }, { steps: 100, minutes: 60, usd: 5 });
        assert.equal(out.used.minutes, null);
        assert.equal(out.used.usd, null);
    });

    await check('a task that stopped on a limit is budget-stopped, never a vague failure', () => {
        assert.equal(state('budget-stopped'), 'budget-stopped');
        assert.equal(state('failed'), 'failed');
        assert.equal(state('interrupted'), 'failed');
        assert.equal(state('done'), 'done');
        assert.equal(state('running'), 'running');
        assert.ok(STATES.includes('budget-stopped'));
    });

    await check('steps and minutes buy one wrap-up turn', () => {
        const steps = wrapUp('steps');
        assert.equal(steps.action, 'wrap-up');
        assert.match(steps.prompt, /one short last turn/);
        assert.match(steps.prompt, /Do not start anything new/);
        assert.equal(wrapUp('minutes').action, 'wrap-up');
    });

    await check('a dollar limit is a hard stop', () => {
        const dollars = wrapUp('usd');
        assert.equal(dollars.action, 'stop');
        assert.equal(dollars.prompt, null);
    });

    await check('only one wrap-up turn', () => {
        assert.equal(wrapUp('steps', { done: true }).action, 'stop');
    });

    await check('the wrap-up prompt says which limit was reached', () => {
        assert.match(wrapUpPrompt('minutes'), /your minutes limit/);
    });

    done();
})();
