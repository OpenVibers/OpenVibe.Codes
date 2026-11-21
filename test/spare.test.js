'use strict';
/**
 * Spare usage (plan §AD.37; the owner, 11-21: "if the weekly reset's coming up and there's still usage available … a task
 * list if it's not doing something else already … every ounce of your usage across all your code harnesses"): the
 * planner picks an agent whose window resets soon with time left and that is idle, the list's next task for it starts as
 * an ordinary Codes task, and what ended settles (back on the list when it repeats).
 */
const assert = require('node:assert/strict');
const { check, done } = require('./helpers/boot');
const { createStore } = require('../server/db');
const { testDb } = require('./helpers/db');
const { plan, createSpare, taskFields } = require('../server/domain/spare');

const SUBJECT = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2AB';
const NOW = Date.parse('2026-11-21T01:00:00Z');
const inH = (h) => new Date(NOW + h * 3600e3).toISOString();
const agent = (id, windows, extra = {}) => ({ agent: id, name: id, state: 'ok', signed_in: true, windows, ...extra });
const task = (id, extra = {}) => ({ id, state: 'queued', priority: 3, agent: 'any', created_at: `2026-11-20T00:0${id.slice(-1)}:00Z`, ...extra });

(async () => {
    await check('the planner: soonest reset with time left, idle, short windows not full; one at a time; priorities and named agents', () => {
        const settings = { enabled: true, reset_within_hours: 12, min_left_pct: 15, keep_pct: 5, max_running: 1 };
        const agents = [
            agent('claude-code', [{ name: '5h', pct: 10, resets_at: inH(3) }, { name: 'week', pct: 40, resets_at: inH(6) }]),
            agent('codex', [{ name: 'week', pct: 0, resets_at: inH(80) }]),
            agent('command-code', [{ name: '5h', pct: 97, resets_at: inH(2) }, { name: 'week', pct: 10, resets_at: inH(4) }]),
            agent('opencode', [{ name: 'week', pct: 92, resets_at: inH(5) }]),
            agent('minimax-code', [{ name: 'week', pct: 20, resets_at: inH(1) }], { signed_in: false }),
        ];
        const out = plan({ settings, tasks: [task('t2', { priority: 2 }), task('t1', { priority: 1, agent: 'codex' }), task('t3')], agents, now: NOW });
        assert.deepEqual(out.picks.map((p) => [p.task.id, p.agent, p.window]), [['t2', 'claude-code', '5h']], 'claude-code\'s 5h window resets first; the codex-only task waits for codex');
        const why = Object.fromEntries(out.agents.map((a) => [a.agent, a.why]));
        assert.match(why.codex, /next reset is in 80 h/);
        assert.match(why['command-code'], /window of its plan is full/);
        assert.match(why.opencode, /8% of its week window is left \(you asked for 15%\)/);
        assert.match(why['minimax-code'], /not signed in/);
        const busy = plan({ settings, tasks: [task('t3')], agents, busy: new Set(['claude-code']), now: NOW });
        assert.equal(busy.picks.length, 0, 'an agent working on something of yours takes nothing');
        const full = plan({ settings, tasks: [task('t3')], agents, running: 1, now: NOW });
        assert.match(full.agents.find((a) => a.agent === 'claude-code').why, /1 of the list already running/);
        const stale = plan({ settings, tasks: [task('t3')], agents: [agent('codex', [{ name: 'week', pct: 100, resets_at: new Date(NOW - 1000).toISOString() }, { name: 'next', pct: 0, resets_at: inH(2) }])], now: NOW });
        assert.equal(stale.picks.length, 1, 'a reading past its reset is a reset window');
    });

    await check('a task needs words and a repository; owner/name becomes its GitHub address', () => {
        assert.match(taskFields({ repo: 'a/b' }).error, /Say what to do/);
        assert.match(taskFields({ prompt: 'x' }).error, /Name the repository/);
        assert.equal(taskFields({ prompt: 'Add tests', repo: 'OpenVibers/OpenVibe.Codes' }).fields.repo, 'https://github.com/OpenVibers/OpenVibe.Codes');
        assert.match(taskFields({ prompt: 'x', repo: 'a/b', agent: 'Bad Agent!' }).error, /agent/);
    });

    const testdb = await testDb();
    const store = createStore(testdb.db, { now: () => NOW });
    const started = [];
    const fakeTasks = {
        async start({ subject, project, args, via }) {
            const id = store.newId('tsk');
            await store.db.exec('INSERT INTO run_tasks (id, subject, project_id, repo, prompt, agent, state, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)', [id, subject, project, args.repo, args.prompt, args.agent, 'running', NOW]);
            started.push({ id, subject, project, agent: args.agent, repo: args.repo, via });
            return { id };
        },
        async latestProject() { return null; },
    };
    const fleet = { async agents() { return [agent('codex', [{ name: 'week', pct: 30, resets_at: inH(5) }])]; } };
    const spare = createSpare({ store, fleet, tasks: fakeTasks, log: { warn() {}, info() {} }, now: () => NOW });
    try {
        await check('the list starts its next task on the agent with time left, as an ordinary Codes task, and settles it', async () => {
            const t = await spare.add(SUBJECT, { title: 'Fleet tests', prompt: 'Add tests for fleet.js', repo: 'OpenVibers/OpenVibe.Codes', repeat: true });
            assert.equal(t.state, 'queued');
            assert.deepEqual(await spare.tick(), { started: 0, settled: 0 }, 'nothing while the list is off');
            await spare.saveSettings(SUBJECT, { enabled: true }, { project: null });
            await spare.tick();
            assert.match((await spare.list(SUBJECT))[0].note, /which project to run in/, 'without a project it says what is missing');
            await spare.saveSettings(SUBJECT, { enabled: true }, { project: 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2AB' });
            assert.deepEqual(await spare.tick(), { started: 1, settled: 0 });
            assert.deepEqual(started.map((s) => [s.agent, s.repo, s.via]), [['codex', 'https://github.com/OpenVibers/OpenVibe.Codes', 'spare']]);
            const running = (await spare.list(SUBJECT))[0];
            assert.equal(running.state, 'running');
            assert.match(running.note, /70% of its week window left, resetting in 5 h/);
            assert.deepEqual(await spare.tick(), { started: 0, settled: 0 }, 'one at a time, and codex is busy with it');
            await store.db.exec("UPDATE run_tasks SET state = 'succeeded' WHERE id = $1", [running.task_id]);
            assert.deepEqual(await spare.tick(), { started: 1, settled: 1 }, 'settled (it repeats: back on the list) and started again');
            assert.equal((await spare.list(SUBJECT))[0].runs, 2);
        });

        await check('the view says per agent what it has left and why it would or would not take a task', async () => {
            const v = await spare.view(SUBJECT);
            assert.equal(v.settings.enabled, true);
            assert.ok(!('project_id' in v.settings), 'the project stays inside');
            assert.deepEqual(v.agents[0].windows, [{ name: 'week', used_pct: 30, resets_at: inH(5) }]);
            assert.match(v.agents[0].why, /working on something of yours/);
            await assert.rejects(spare.saveSettings(SUBJECT, { reset_within_hours: 'soon' }), /reset_within_hours/);
            const s = await spare.saveSettings(SUBJECT, { min_left_pct: 10, keep_pct: 20 });
            assert.equal(s.keep_pct, 9, 'what you keep stays under what you ask for');
        });
    } finally {
        await testdb.close();
    }
    done();
})();
