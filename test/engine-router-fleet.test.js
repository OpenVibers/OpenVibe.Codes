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

        await check('an agent the person is not signed in to is skipped for one that is', () => {
            const out = { ...TODAY, cx: { signed_in: false, windows: [] }, mm: { signed_in: false, windows: [] } };
            assert.equal(router.pick(HARD, context(out)).runner, 'dsh', 'Codex and MiniMax are signed out, so DeepSeek');
        });
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    }
    done();
})();
