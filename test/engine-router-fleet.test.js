'use strict';

/**
 * The router on live quotas (Codes C9c). The fleet is what the person's machines reported with their heartbeats, and
 * the router skips an agent whose window is full or that is not signed in — so `auto` never picks an agent that would
 * stop mid-way. Today's state (2026-10-30) is in these tests: Codex's week is spent until 11-04, OpenCode's month
 * until 11-02, and Command Code is at 96% of its week; auto must route to MiniMax or DeepSeek.
 */
const assert = require('node:assert/strict');
const { check, done } = require('./helpers/boot');
const router = require('../engine/router');

const NOW = Date.parse('2026-10-30T12:00:00Z');
const RESET_WEEK = '2026-11-04T00:00:00Z';
const RESET_MONTH = '2026-11-02T00:00:00Z';

const runner = (enabled = true) => ({ enabled, max: 4 });
const cfg = { subagents: { cx: runner(), mm: runner(), cc: runner(), oc: runner(), dsh: runner(), claude: runner(false) } };
const health = { cx: { state: 'ok' }, mm: { state: 'ok' }, cc: { state: 'ok' }, oc: { state: 'ok' }, dsh: { state: 'ok' } };
const context = (fleet) => ({ cfg, health, counts: {}, models: {}, fleet });

/** Today's state of the owner's plans, as the Nodes report it. */
const TODAY = {
    cx: { signed_in: true, installed: true, windows: [{ name: 'week', used: 100, limit: 100, pct: 100, resets_at: RESET_WEEK }] },
    oc: { signed_in: true, installed: true, windows: [{ name: 'month', used: 100, limit: 100, pct: 100, resets_at: RESET_MONTH }] },
    cc: { signed_in: true, installed: true, windows: [{ name: 'week', used: 96, limit: 100, pct: 96, resets_at: RESET_WEEK }] },
    mm: { signed_in: true, installed: true, windows: [] },
    dsh: { signed_in: true, installed: true, windows: [] },
};

const HARD = 'Root cause of the race condition in the payment webhook. Find the deadlock and write the test that proves it.';
const BASIC = 'Rename the variable in the one file and reformat it.';

(async () => {
    try {
        await check('a window at the full mark is spent, and one that has already reset is not', () => {
            assert.equal(router.windowFull({ pct: 96 }, NOW), true, '96% of a week is spent, not 4% left');
            assert.equal(router.windowFull({ used: 19, limit: 20 }, NOW), true, 'used/limit is the same reading');
            assert.equal(router.windowFull({ pct: 100, resets_at: '2026-10-29T00:00:00Z' }, NOW), false, 'it freed yesterday');
            assert.equal(router.windowFull({ pct: 40 }, NOW), false);
            assert.equal(router.windowFull(null, NOW), false);
            assert.equal(router.FULL_PCT, 95);
        });

        await check('room needs a signed-in agent with no full window', () => {
            assert.equal(router.roomFor(TODAY, 'mm', NOW), true);
            assert.equal(router.roomFor(TODAY, 'cx', NOW), false);
            assert.equal(router.roomFor(TODAY, 'cc', NOW), false, '96% is full');
            assert.equal(router.roomFor({ cx: { signed_in: false, windows: [] } }, 'cx', NOW), false, 'not signed in');
            assert.equal(router.roomFor({}, 'cx', NOW), true, 'an agent the fleet does not name is unknown, not full');
            assert.equal(router.roomFor(null, 'cx', NOW), true, 'no fleet at all leaves the ladder as it was');
        });

        await check('auto routes today to MiniMax or DeepSeek, never Codex, OpenCode or Command Code', () => {
            for (const prompt of ['Standard feature: add the endpoint and its tests.', HARD, BASIC, 'Design pass on the task page: layout, css and a screenshot at 390.']) {
                const picked = router.pick(prompt, context(TODAY));
                assert.ok(picked, `something takes: ${prompt}`);
                assert.ok(['mm', 'dsh'].includes(picked.runner), `${prompt} → ${picked.runner}`);
            }
            assert.equal(router.pick(HARD, context(TODAY)).runner, 'mm', 'hard starts at Codex, which is spent, so MiniMax');
            assert.equal(router.pick(BASIC, context(TODAY)).runner, 'mm', 'basic starts at OpenCode (spent), Command Code (96%), then MiniMax');
        });

        await check('a plan with room keeps its place at the front of the ladder', () => {
            const room = { ...TODAY, cx: { signed_in: true, windows: [{ name: 'week', pct: 20, resets_at: RESET_WEEK }] } };
            assert.equal(router.pick(HARD, context(room)).runner, 'cx', 'Codex with room takes the hard task');
            const ccRoom = { ...TODAY, cc: { signed_in: true, windows: [{ name: 'week', pct: 40, resets_at: RESET_WEEK }] } };
            assert.equal(router.pick(BASIC, context(ccRoom)).runner, 'cc');
        });

        await check('a flat-price plan with room is preferred over a pay-per-token agent', () => {
            // Both have room: the plan comes first, because the pay-per-token one costs money for every token.
            const both = { ...TODAY, mm: { signed_in: true, windows: [] }, dsh: { signed_in: true, windows: [] } };
            assert.equal(router.pick(BASIC, context(both)).runner, 'mm', 'the plan, not the meter');
            assert.equal(router.pick(HARD, context(both)).runner, 'mm');
            // And when the plan is spent, the pay-per-token one is what is left.
            const spent = { ...both, mm: { signed_in: true, windows: [{ name: 'week', pct: 100, resets_at: RESET_WEEK }] } };
            assert.equal(router.pick(BASIC, context(spent)).runner, 'dsh', 'DeepSeek is last, but it is the one with room');
        });

        await check('an agent the person is not signed in to is skipped for one that is', () => {
            const out = { ...TODAY, cx: { signed_in: false, windows: [] }, mm: { signed_in: false, windows: [] } };
            assert.equal(router.pick(HARD, context(out)).runner, 'dsh', 'Codex and MiniMax are signed out, so DeepSeek');
        });

        await check('an agent whose balance is nearly gone may not take a job', () => {
            // DeepSeek reads its balance the way the portal reads it (engine/balance.js): $0.02 today.
            assert.equal(router.MIN_BALANCE_USD, 1, 'a balance under a dollar would not pay for the job');
            const broke = { ...TODAY, dsh: { ...TODAY.dsh, balance_usd: 0.02 } };
            assert.equal(router.balanceLow(broke, 'dsh'), true, '$0.02 is too little');
            assert.equal(router.roomFor(broke, 'dsh', NOW), false, 'so DeepSeek has no room');
            assert.equal(router.pick(HARD, context(broke)).runner, 'mm', 'and the hard task goes to MiniMax');
            const signedOut = { ...broke, cx: { signed_in: false, windows: [] }, mm: { signed_in: false, windows: [] } };
            assert.equal(router.pick(HARD, context(signedOut)), null, 'nothing may take it: no agent is left, not a guess');

            // A balance nobody read is unknown, not empty: the ladder keeps working.
            assert.equal(router.balanceLow(TODAY, 'dsh'), false);
            assert.equal(router.roomFor(TODAY, 'dsh', NOW), true);
            assert.equal(router.pick(HARD, context(TODAY)).runner, 'mm');
            // And a balance with money in it is no reason to skip anything.
            const paid = { ...TODAY, dsh: { ...TODAY.dsh, balance_usd: 12.5 } };
            assert.equal(router.roomFor(paid, 'dsh', NOW), true);
        });
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    }
    done();
})();
