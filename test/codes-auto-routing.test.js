'use strict';

/**
 * Codes C9c, end to end: a task with no agent named is `auto`, and the router reads the fleet the machines reported.
 * Today (2026-10-30) Codex's week is spent, OpenCode's month is spent and Command Code is at 96% of its week, so auto
 * must land on MiniMax or DeepSeek — and never on Claude. A finished or unfinished task then tells the person once.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const NODE = 'nod_01J8Z3Q4R5S6T7V8W9X0Y1Z2N3';
const RESET_WEEK = '2026-11-04T00:00:00Z';
const RESET_MONTH = '2026-11-02T00:00:00Z';

(async () => {
    const submits = [];
    let counter = 0;
    const run = {
        enabled: true,
        async submit(o) { counter++; submits.push(o); return { id: `job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J${String(counter).padStart(2, '0')}`, state: 'queued' }; },
        async read(jobId) { return { id: jobId, state: 'queued' }; },
        async cancel() { return { state: 'cancelled' }; },
        async streamUrl() { throw new Error('not used'); },
    };
    const pushed = [];
    const notify = { async push(body) { pushed.push(body); return { sent: true }; } };
    // DeepSeek's balance is read the way the portal reads it (engine/balance.js): $0.02 today, too little for a job.
    const t = await boot({
        run, notify,
        balance: async () => ({ deepseek: { usd: 0.02, at: new Date().toISOString() } }),
        // The fleet is read fresh every time here, so a changed reading is the one the router sees.
        env: { CODES_FLEET_TTL_MS: '0' },
    });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    t.network.addNode(ada.subject, { principal: NODE, node_id: 'node_ada', name: 'ada-laptop', status: 'active', last_seen_at: new Date().toISOString() });

    /** The fleet Ada's machines reported with their last heartbeats. */
    const window = (name, pct, resetsAt) => JSON.stringify([{ name, pct, resets_at: resetsAt }]);
    // The machine, as OpenVibe.Bot answers it: the device id Run pins a job to, the Network id the machine is known
    // by, and the fleet its Node last reported with its heartbeat.
    t.bot.addMachine({
        id: 'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2N1', node_id: NODE, name: 'ada-laptop', online: true, fleet_at: new Date().toISOString(),
        fleet: [
            { agent: 'codex', installed: true, signed_in: true, windows: [{ name: 'week', pct: 100, resets_at: RESET_WEEK }] },
            { agent: 'opencode', installed: true, signed_in: true, windows: [{ name: 'month', pct: 100, resets_at: RESET_MONTH }] },
            { agent: 'command-code', installed: true, signed_in: true, windows: [{ name: 'week', pct: 96, resets_at: RESET_WEEK }] },
            { agent: 'minimax-code', installed: true, signed_in: true, windows: [] },
            { agent: 'deepseek', installed: true, signed_in: true, windows: [] },
        ],
    });
    await db.exec(
        `INSERT INTO codes_machine_fleet (subject, machine, node_id, name, agent, installed, signed_in, windows, online, reported_at, updated_at)
         VALUES ($1,'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2N1','nod_ada','ada-laptop','codex',true,true,$2::jsonb,true,now(),now()),
                ($1,'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2N1','nod_ada','ada-laptop','opencode',true,true,$3::jsonb,true,now(),now()),
                ($1,'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2N1','nod_ada','ada-laptop','command-code',true,true,$4::jsonb,true,now(),now()),
                ($1,'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2N1','nod_ada','ada-laptop','minimax-code',true,true,'[]'::jsonb,true,now(),now()),
                ($1,'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2N1','nod_ada','ada-laptop','deepseek',true,true,'[]'::jsonb,true,now(),now())`,
        [ada.subject, window('week', 100, RESET_WEEK), window('month', 100, RESET_MONTH), window('week', 96, RESET_WEEK)],
    );

    const start = async (prompt) => {
        const r = await t.get('/api/v1/me/tasks', { as: ada, json: { repo: 'https://github.com/octocat/Hello-World', prompt, idempotency_key: `c9c_${Math.random().toString(36).slice(2, 10)}` } });
        assert.strictEqual(r.status, 201, r.text);
        return r.json().task;
    };
    const endAttempt = async (taskId, { state, result = null }) => {
        const row = await db.one('SELECT * FROM run_tasks WHERE id = $1', [taskId]);
        const updated = await t.ctx.tasks.applyEvent(row, { state, job: { id: row.job_id, state, result, error: null }, error: null });
        await t.ctx.tasks.afterEnd(updated.id);
    };

    try {
        await check('auto: today\'s fleet never starts a task on Codex, OpenCode or Command Code', async () => {
            const hard = await start('Find the root cause of the race condition in the payment webhook and prove it with a test.');
            assert.strictEqual(submits.at(-1).args.agent, 'minimax-code', 'Codex is spent, so MiniMax takes the hard task');
            assert.strictEqual(hard.agent, 'minimax-code');
            const basic = await start('Rename the variable in the one file and reformat it.');
            assert.strictEqual(submits.at(-1).args.agent, 'minimax-code', 'OpenCode is spent and Command Code is at 96%');
            assert.strictEqual(basic.agent, 'minimax-code');
            for (const s of submits) assert.ok(!/claude/.test(String(s.args.agent)), 'never an Anthropic agent');
        });

        await check('a sub-task the conductor starts without an agent is auto too', async () => {
            const created = await t.get('/api/v1/conductor', { as: ada, json: { folder: '/home/ada/openvibe', machine: NODE } });
            assert.strictEqual(created.status, 201, created.text);
            const before = submits.length;
            const r = await t.get(`/api/v1/conductor/${created.json().task.id}/tasks`, { as: ada, json: { prompt: 'Fix the parser and add a test.', repo: 'https://github.com/octocat/Hello-World' } });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(submits.length, before + 1);
            assert.strictEqual(submits.at(-1).args.agent, 'minimax-code', 'the router picked, not a fixed codex');
            assert.strictEqual(r.json().task.agent, 'minimax-code');
        });

        await check('a finished task tells the person once, and a redelivered ending does not tell them again', async () => {
            const task = await start('Add the endpoint and its tests.');
            await endAttempt(task.id, { state: 'succeeded', result: { ok: true, summary: 'It added the endpoint and its tests.', files: [], log: [{ t: 'done', ok: true, text: 'done' }] } });
            const told = pushed.filter((p) => p.title === 'Your task is done' && p.url.endsWith(`/tasks/${task.id}`));
            assert.strictEqual(told.length, 1, JSON.stringify(pushed));
            assert.match(told[0].message, /endpoint/);
            await t.ctx.tasks.afterEnd(task.id);
            assert.strictEqual(pushed.filter((p) => p.url.endsWith(`/tasks/${task.id}`)).length, 1, 'one notice per task and state');
        });

        await check('a task that needs a person says so, high priority', async () => {
            const task = await start('Rename a variable in the one file.');
            // The first failure is a second opinion on another agent; when that one fails too, the task needs a person.
            await endAttempt(task.id, { state: 'failed', result: { ok: false, summary: 'I could not finish it', files: [], log: [{ t: 'done', ok: false, text: 'I could not finish it' }] } });
            await endAttempt(task.id, { state: 'failed', result: { ok: false, summary: 'I could not finish it either', files: [], log: [{ t: 'done', ok: false, text: 'I could not finish it either' }] } });
            const row = await db.one('SELECT outcome, outcome_note FROM run_tasks WHERE id = $1', [task.id]);
            assert.strictEqual(row.outcome, 'unfinished', row.outcome_note);
            const told = pushed.filter((p) => p.title === 'Your task needs you' && p.url.endsWith(`/tasks/${task.id}`));
            assert.strictEqual(told.length, 1, JSON.stringify(pushed));
            assert.strictEqual(told[0].priority, 'high');
        });

        await check('a task the person stopped tells them nothing', async () => {
            const task = await start('Rename a variable in the one file now.');
            await endAttempt(task.id, { state: 'cancelled' });
            assert.strictEqual(pushed.filter((p) => p.url.endsWith(`/tasks/${task.id}`)).length, 0);
        });

        await check('a task that no agent may take is refused, and needs a person', async () => {
            // Every flat plan is spent and DeepSeek has $0.02: nothing may take it, and the task says why.
            t.bot.state.machines[0].fleet = [
                { agent: 'codex', installed: true, signed_in: true, windows: [{ name: 'week', pct: 100, resets_at: RESET_WEEK }] },
                { agent: 'opencode', installed: true, signed_in: true, windows: [{ name: 'month', pct: 100, resets_at: RESET_MONTH }] },
                { agent: 'command-code', installed: true, signed_in: true, windows: [{ name: 'week', pct: 96, resets_at: RESET_WEEK }] },
                { agent: 'minimax-code', installed: true, signed_in: true, windows: [{ name: 'week', pct: 100, resets_at: RESET_WEEK }] },
                { agent: 'deepseek', installed: true, signed_in: true, windows: [] },
            ];
            await t.get('/api/v1/fleet', { as: ada });   // the reading Bot now answers is the one Codes keeps
            const before = submits.length;
            const r = await t.get('/api/v1/me/tasks', { as: ada, json: { repo: 'https://github.com/octocat/Hello-World', prompt: 'Find the root cause of the race condition in the payment webhook.', idempotency_key: `c9c_${Math.random().toString(36).slice(2, 10)}` } });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(submits.length, before, 'no job was started');
            const row = await db.one('SELECT state, error, outcome FROM run_tasks WHERE id = $1', [r.json().task.id]);
            assert.strictEqual(row.state, 'failed');
            assert.match(row.error, /no agent has room/, row.error);
            assert.match(row.error, /DeepSeek has \$0\.02 left/, row.error);
            const told = pushed.filter((p) => p.title === 'Your task needs you' && p.url.endsWith(`/tasks/${r.json().task.id}`));
            assert.strictEqual(told.length, 1, 'the person is told, once');
        });

        await check('/api/v1/fleet answers the stored fleet for the person', async () => {
            // Ada's machine reports again: MiniMax has room, DeepSeek's balance is what it is.
            t.bot.state.machines[0].fleet = [
                { agent: 'codex', installed: true, signed_in: true, windows: [{ name: 'week', pct: 100, resets_at: RESET_WEEK }] },
                { agent: 'opencode', installed: true, signed_in: true, windows: [{ name: 'month', pct: 100, resets_at: RESET_MONTH }] },
                { agent: 'command-code', installed: true, signed_in: true, windows: [{ name: 'week', pct: 96, resets_at: RESET_WEEK }] },
                { agent: 'minimax-code', installed: true, signed_in: true, windows: [] },
                { agent: 'deepseek', installed: true, signed_in: true, windows: [] },
            ];
            const r = await t.get('/api/v1/fleet', { as: ada });
            assert.strictEqual(r.status, 200, r.text);
            const body = r.json();
            assert.ok(Array.isArray(body.machines) && body.machines.length === 1);
            assert.ok(Array.isArray(body.agents));
            const mm = body.agents.find((a) => a.agent === 'minimax-code');
            assert.strictEqual(mm.state, 'ok');
            const ds = body.agents.find((a) => a.agent === 'deepseek');
            assert.strictEqual(ds.balance_usd, 0.02, 'the balance the portal reads, in the agent\'s own row');
            assert.strictEqual(ds.state, 'empty', 'and an agent out of credit says so');
            assert.ok(mm.machines.some((m) => m.machine === 'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2N1'));
            assert.strictEqual(body.problem, undefined, 'Bot answered, so there is no problem beside the fleet');
        });
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    } finally {
        await t.close();
    }
    done();
})();
