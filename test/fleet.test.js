'use strict';

/**
 * The fleet (Codes C9c): what each of a person's machines reports with its heartbeat, kept per machine and answered for
 * the Agents page, the router and the MCP tool. Bot is stood in for here; the database is the real one.
 */
const assert = require('node:assert/strict');
const { check, done } = require('./helpers/boot');
const { createStore } = require('../server/db');
const { createFleet } = require('../server/domain/fleet');
const { testDb } = require('./helpers/db');

const SUBJECT = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2AB';
const NOW = Date.parse('2026-10-30T12:00:00Z');
const RESET = '2026-11-04T00:00:00Z';

/** Bot's answer for one person's machines. */
const machines = (list) => ({ ok: true, status: 200, json: async () => ({ machines: list }) });
const answer = (doc) => ({ ok: true, status: 200, json: async () => doc });

(async () => {
    const testdb = await testDb();
    const store = createStore(testdb.db, { now: () => NOW });
    const log = { warn() {} };

    try {
        await check('the heartbeat report is stored per machine and agent, and answered per machine', async () => {
            let doc = machines([
                { id: 'dev_ada_laptop', node_id: 'nod_ada', name: 'ada-laptop', online: true, fleet: [
                    { agent: 'codex', installed: true, signed_in: true, windows: [{ name: 'week', used: 100, limit: 100, resets_at: RESET }] },
                    { agent: 'minimax-code', installed: true, signed_in: true, windows: [] },
                ] },
                { id: 'dev_ada_desk', node_id: 'nod_desk', name: 'ada-desk', online: false, fleet: [
                    { agent: 'opencode', installed: true, signed_in: false, windows: [] },
                ] },
            ]);
            const fleet = createFleet({ config: { bot: { internalUrl: 'http://bot.test' } }, store, log, now: () => NOW, fetchImpl: async () => doc });
            const out = await fleet.refresh(SUBJECT, 'tok');
            assert.equal(out.ok, true);
            assert.equal(out.machines.length, 2);
            const laptop = out.machines.find((m) => m.id === 'dev_ada_laptop');
            assert.equal(laptop.node_id, 'nod_ada');
            assert.equal(laptop.agents.length, 2);
            assert.equal(laptop.agents[0].windows[0].pct, 100, 'the pct is derived from used/limit');
            assert.equal(laptop.agents[0].windows[0].resets_at, new Date(RESET).toISOString());
            const desk = out.machines.find((m) => m.id === 'dev_ada_desk');
            assert.equal(desk.online, false);
        });

        await check('the page rows: one per agent, a state each, usable first', async () => {
            const fleet = createFleet({ config: { bot: { internalUrl: 'http://bot.test' } }, store, log, now: () => NOW, fetchImpl: async () => machines([
                { id: 'dev_ada_laptop', node_id: 'nod_ada', name: 'ada-laptop', online: true, fleet: [
                    { agent: 'codex', installed: true, signed_in: true, windows: [{ name: 'week', used: 100, limit: 100, resets_at: RESET }] },
                    { agent: 'minimax-code', installed: true, signed_in: true, windows: [{ name: 'week', used: 10, limit: 100, resets_at: RESET }] },
                    { agent: 'command-code', installed: true, signed_in: true, windows: [{ name: 'week', pct: 84, resets_at: RESET }] },
                    { agent: 'opencode', installed: true, signed_in: false, windows: [] },
                    { agent: 'deepseek', installed: false, signed_in: false, windows: [] },
                ] },
            ]) });
            await fleet.refresh(SUBJECT, 'tok');
            const rows = await fleet.agents(SUBJECT, null);
            const by = Object.fromEntries(rows.map((r) => [r.agent, r]));
            assert.equal(by['minimax-code'].state, 'ok');
            assert.equal(by['command-code'].state, 'low', '84% of the week is nearly full');
            assert.equal(by.codex.state, 'limited', 'a full window');
            assert.equal(by.opencode.state, 'login', 'installed, not signed in');
            assert.equal(by.deepseek.state, 'absent');
            assert.equal(rows[0].agent, 'minimax-code', 'the one with the most room comes first');
            assert.equal(by['minimax-code'].machines[0].machine, 'dev_ada_laptop');
        });

        await check('the router reads the fleet per runner, with the machine that has room', async () => {
            const fleet = createFleet({ config: { bot: { internalUrl: 'http://bot.test' } }, store, log, now: () => NOW, fetchImpl: async () => machines([
                { id: 'dev_ada_laptop', node_id: 'nod_ada', name: 'ada-laptop', online: true, fleet: [
                    { agent: 'codex', installed: true, signed_in: true, windows: [{ name: 'week', pct: 100, resets_at: RESET }] },
                    { agent: 'minimax-code', installed: true, signed_in: true, windows: [] },
                ] },
            ]) });
            await fleet.refresh(SUBJECT, 'tok');
            const forRouter = await fleet.forRouter(SUBJECT, (agent) => ({ 'minimax-code': 'mm', codex: 'cx' })[agent] || null);
            assert.equal(forRouter.cx.room, false);
            assert.equal(forRouter.mm.room, true);
            assert.equal(forRouter.mm.machine, 'dev_ada_laptop');
            assert.equal(forRouter.claude, undefined, 'Claude has no place in a sub-task fleet');
        });

        await check('a plan with room on one machine is usable, and the meter shows the fullest reading', async () => {
            const fleet = createFleet({ config: { bot: { internalUrl: 'http://bot.test' } }, store, log, now: () => NOW, fetchImpl: async () => machines([
                { id: 'dev_ada_laptop', node_id: 'nod_ada', name: 'ada-laptop', online: true, fleet: [
                    { agent: 'codex', installed: true, signed_in: true, windows: [{ name: 'week', pct: 100, resets_at: RESET }] },
                ] },
                { id: 'dev_ada_desk', node_id: 'nod_desk', name: 'ada-desk', online: true, fleet: [
                    { agent: 'codex', installed: true, signed_in: true, windows: [{ name: 'week', pct: 10, resets_at: RESET }] },
                ] },
            ]) });
            await fleet.refresh(SUBJECT, 'tok');
            const by = await fleet.byHarness(SUBJECT);
            assert.equal(by.codex.windows[0].pct, 100, 'the fullest reading is the one a person sees');
            assert.equal(by.codex.room, true, 'the desk has room, so a job can run');
            assert.equal(by.codex.machine, 'dev_ada_desk', 'on the machine that has room');
            const row = (await fleet.agents(SUBJECT, null)).find((a) => a.agent === 'codex');
            assert.notEqual(row.state, 'limited', 'room on one machine is not full');
        });

        await check('a plan that is full on every machine is limited', async () => {
            const fleet = createFleet({ config: { bot: { internalUrl: 'http://bot.test' } }, store, log, now: () => NOW, fetchImpl: async () => machines([
                { id: 'dev_ada_laptop', node_id: 'nod_ada', name: 'ada-laptop', online: true, fleet: [
                    { agent: 'codex', installed: true, signed_in: true, windows: [{ name: 'week', pct: 100, resets_at: RESET }] },
                ] },
                { id: 'dev_ada_desk', node_id: 'nod_desk', name: 'ada-desk', online: true, fleet: [
                    { agent: 'codex', installed: true, signed_in: true, windows: [{ name: 'week', pct: 96, resets_at: RESET }] },
                ] },
            ]) });
            await fleet.refresh(SUBJECT, 'tok');
            const by = await fleet.byHarness(SUBJECT);
            assert.equal(by.codex.room, false);
            assert.equal((await fleet.agents(SUBJECT, null)).find((a) => a.agent === 'codex').state, 'limited');
        });

        await check('a machine gone from Bot\'s answer is gone here; one that reports no fleet keeps its reading', async () => {
            const fleet = createFleet({ config: { bot: { internalUrl: 'http://bot.test' } }, store, log, now: () => NOW, fetchImpl: async () => machines([
                { id: 'dev_ada_laptop', node_id: 'nod_ada', name: 'ada-laptop', online: true, fleet: [
                    { agent: 'codex', installed: true, signed_in: true, windows: [] },
                ] },
                { id: 'dev_ada_desk', node_id: 'nod_desk', name: 'ada-desk', online: true, fleet: [
                    { agent: 'opencode', installed: true, signed_in: false, windows: [] },
                ] },
            ]) });
            await fleet.refresh(SUBJECT, 'tok');
            // The desk's Node is old and reports no fleet; the laptop is unplugged from the answer.
            const next = createFleet({ config: { bot: { internalUrl: 'http://bot.test' } }, store, log, now: () => NOW, fetchImpl: async () => machines([
                { id: 'dev_ada_desk', node_id: 'nod_desk', name: 'ada-desk', online: true },
            ]) });
            await next.refresh(SUBJECT, 'tok');
            const { machines: left } = await next.latest(SUBJECT);
            assert.deepEqual(left.map((m) => m.id), ['dev_ada_desk'], 'the laptop is gone');
            assert.equal(left[0].agents.length, 1, 'the desk keeps its last reading');
            assert.equal(left[0].agents[0].agent, 'opencode');
        });

        await check('Bot that does not answer is a problem beside the stored fleet, never an empty one', async () => {
            const down = createFleet({ config: { bot: { internalUrl: 'http://bot.test' } }, store, log, now: () => NOW, fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); } });
            const out = await down.refresh(SUBJECT, 'tok');
            assert.equal(out.ok, false);
            assert.match(out.problem.detail, /did not answer/);
            const { machines: kept } = await down.latest(SUBJECT);
            assert.ok(kept.length >= 1, 'the last reading is still there');
        });

        await check('an expired session is said, not turned into an empty fleet', async () => {
            const fleet = createFleet({ config: { bot: { internalUrl: 'http://bot.test' } }, store, log, now: () => NOW, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ detail: 'unauthorized' }) }) });
            await assert.rejects(fleet.refresh(SUBJECT, 'stale'), (e) => e.status === 401);
        });
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    } finally {
        await testdb.close();
    }
    done();
})();
