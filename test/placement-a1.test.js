'use strict';
/**
 * Placement A1 in Codes: place() explains where a task runs, the person's two rules change the answer, the line is
 * first on the task's timeline, the outcome is learned once at the end, a cancelled task is not counted, and the
 * learned table is exported and erased with the person (test/account-data.test.js covers the guard).
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const jobs = new Map();
    let counter = 0;
    const run = {
        enabled: true,
        async submit(o) {
            counter++;
            const id = `job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J${String(counter).padStart(2, '0')}`;
            jobs.set(id, { id, state: 'queued', args: o.args });
            return { id, state: 'queued' };
        },
        async read(jobId) { return jobs.get(jobId) || { id: jobId, state: 'queued' }; },
        async cancel(jobId) { const j = jobs.get(jobId); if (j) j.state = 'cancelled'; return j; },
        async streamUrl() { throw new Error('not used'); },
    };
    const t = await boot({ run });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    const bo = t.network.addUser('bo');
    const project = 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1';
    const CAPS = ['codes.task.start', 'codes.task.read', 'codes.task.cancel'];
    const actor = t.network.mintService('svc:actor', 'openvibe.codes', CAPS);
    const call = async (method, path, { token = actor, subject = ada.subject, body } = {}) => {
        const headers = { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(subject ? { 'X-OV-Subject': subject } : {}) };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(`${t.base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    const startTask = async (subject, agent = null) => {
        const r = await call('POST', '/tasks', { subject, body: {
            repo: 'https://github.com/octocat/Hello-World', prompt: 'Fix the parser and add a test for it.',
            ...(agent ? { agent } : {}), idempotency_key: `act_${Math.random().toString(36).slice(2, 10)}`,
        } });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        return r.json.task;
    };
    // The machine the fleet reports, and the agent it runs (a real fleet row, as Bot's answer would carry).
    t.bot.addMachine({ id: 'dev_01J8Z4M2Q0R7T9YV3K6N8P1W2X', node_id: 'nod_01J8Z4M2Q0R7T9YV3K6N8P1W2X', name: 'ada-laptop', online: true,
        fleet: [{ agent: 'codex', installed: true, signed_in: true, windows: [] }] });
    // A person starts a service's task in the project of their latest task: seed one for each.
    for (const [i, subject] of [[1, ada.subject], [2, bo.subject]]) {
        await db.exec(`INSERT INTO run_tasks (id, subject, project_id, repo, prompt, agent, state, created_at, updated_at)
            VALUES ($1, $2, $3, 'https://github.com/a/b', 'seed', 'codex', 'succeeded', $4, $4)`,
        [`tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2S${i}`, subject, project, i]);
    }

    const endAttempt = async (taskId, state = 'succeeded') => {
        const row = await db.one('SELECT * FROM run_tasks WHERE id = $1', [taskId]);
        const job = { id: row.job_id, state, result: state === 'succeeded' ? { ok: true, summary: 'done' } : null, error: null };
        const updated = await t.ctx.tasks.applyEvent(row, { state, job });
        await t.ctx.tasks.afterEnd(updated.id);
        return await db.one('SELECT * FROM run_tasks WHERE id = $1', [taskId]);
    };

    try {
        await check('the migration creates the learned table and the placement columns', async () => {
            const cols = await db.many("SELECT column_name FROM information_schema.columns WHERE table_name = 'placement_outcomes' ORDER BY column_name");
            assert.deepStrictEqual(cols.map((c) => c.column_name), ['n_w', 'ok_w', 'option_key', 'person_id', 'step_kind', 'updated_at']);
            const taskCols = (await db.many("SELECT column_name FROM information_schema.columns WHERE table_name = 'run_tasks'")).map((c) => c.column_name);
            for (const c of ['placement_line', 'placement_option_key', 'placement_step_kind', 'placement_recorded']) assert.ok(taskCols.includes(c), c);
        });

        await check('a task gets the placement line, and the page shows it first', async () => {
            const task = await startTask(ada.subject, 'codex');
            const row = await db.one('SELECT * FROM run_tasks WHERE id = $1', [task.id]);
            assert.ok(row.placement_line, 'the task carries its line');
            assert.ok(row.placement_option_key, 'the task carries the option key');
            const page = await t.get(`/run/tasks/${task.id}`, { as: ada });
            assert.strictEqual(page.status, 200, page.text.slice(0, 200));
            assert.ok(page.text.includes('data-placement'), 'the timeline has a placement entry');
            assert.ok(page.text.includes(`Placed: ${row.placement_line}`), page.text.slice(0, 400));
            assert.ok(page.text.indexOf('data-placement') < page.text.indexOf('data-attempt='), 'it comes before the attempts');
        });

        await check('the settings toggles are on the page and stored per person', async () => {
            const page = await t.get('/settings', { as: ada });
            assert.ok(page.text.includes('Never send my code to the cloud'));
            assert.ok(page.text.includes('Only free'));
            const saved = await t.get('/settings', { as: ada, method: 'POST', form: { no_cloud: '1', only_free: '1', notify_done: '1', notify_needs: '1', safety: 'ask' } });
            assert.strictEqual(saved.status, 303);
            const settings = await t.ctx.userSettings.get(ada.subject);
            assert.strictEqual(settings.no_cloud, true);
            assert.strictEqual(settings.only_free, true);
            assert.strictEqual((await t.ctx.userSettings.get(bo.subject)).no_cloud, false, 'another person keeps the default');
        });

        await check('noCloud keeps the task on the person’s own machine; with none, the line says nothing can run it', async () => {
            const { route } = require('../server/domain/harness-placement');
            const { createHarnesses } = require('../server/domain/harnesses');
            const harnesses = createHarnesses();
            const own = route({ task: 'edit', harnesses, now: Date.parse('2026-10-30T12:00:00Z'), context: {
                person: ada.subject, rules: { noCloud: true }, ownMachine: { name: 'ada-laptop', agents: ['codex'] }, onlyAgent: 'codex',
            } });
            assert.strictEqual(own.selected, 'codex:codex-default');
            assert.strictEqual(own.explain.line, 'On Codex: your own machine, and it\'s free.');
            assert.ok(!own.explain.line.includes('codex:codex-default'), 'the line never shows a raw offer id');
            const none = route({ task: 'edit', harnesses, now: Date.parse('2026-10-30T12:00:00Z'), context: {
                person: bo.subject, rules: { noCloud: true }, ownMachine: null, onlyAgent: 'codex',
            } });
            assert.strictEqual(none.selected, null);
            assert.match(none.explain.line, /nothing can run this/i);
            assert.ok(none.explain.rejected.some((r) => /never send my repo to the cloud/i.test(r.why)), JSON.stringify(none.explain.rejected));
            // Only free: a paid harness is out; no free option means the line says nothing can run it.
            const paid = route({ task: 'edit', harnesses, now: Date.parse('2026-10-30T12:00:00Z'), context: {
                person: bo.subject, rules: { onlyFree: true }, onlyAgent: 'deepseek',
            } });
            assert.strictEqual(paid.selected, null);
            assert.match(paid.explain.line, /nothing can run this/i);
        });

        await check('an escalation persists escalate()’s counts and is not learned again', async () => {
            const cy = t.network.addUser('cy');
            const { place, escalate } = require('openvibe-sdk/placement');
            const { toOffer, requirementsFor } = require('../server/domain/harness-placement');
            const { createHarnesses } = require('../server/domain/harnesses');
            const harnesses = createHarnesses();
            const at = Date.parse('2026-10-30T12:00:00Z');
            const req = requirementsFor('edit');
            const offers = [toOffer(harnesses.get('claude-code'), harnesses.get('claude-code').agents[0], { now: at })];
            const ctx = { now: at, person: cy.subject, step: { kind: 'harness.escalation-test' }, priors: {}, outcomes: [] };
            const first = place(req, offers, ctx);
            const next = escalate(first, { reason: 'quality' }, req, offers, ctx);
            assert.strictEqual(next.result.selected, null);
            assert.ok(next.outcomes.some((r) => r.person === cy.subject && r.n_w === 1 && r.ok_w === 0), 'escalate learned the failure');
            await t.ctx.placementContext.recordEscalation(next, cy.subject);
            const row = await db.one('SELECT * FROM placement_outcomes WHERE person_id = $1', [cy.subject]);
            assert.strictEqual(Number(row.n_w), 1);
            // Persisting the same returned set again is the same row, not a second failure.
            await t.ctx.placementContext.recordEscalation(next, cy.subject);
            assert.strictEqual(Number((await db.one('SELECT n_w FROM placement_outcomes WHERE person_id = $1', [cy.subject])).n_w), 1);
        });

        await check('an outcome is recorded once at the end, and a cancelled task is not counted', async () => {
            await t.ctx.userSettings.save(ada.subject, { no_cloud: false, only_free: false });
            const task = await startTask(ada.subject, 'codex');
            const before = await db.one('SELECT * FROM run_tasks WHERE id = $1', [task.id]);
            const doneRow = await endAttempt(task.id, 'succeeded');
            assert.strictEqual(doneRow.outcome, 'done');
            const rows = await db.many('SELECT * FROM placement_outcomes WHERE person_id = $1', [ada.subject]);
            assert.strictEqual(rows.length, 1, 'one learned row');
            assert.strictEqual(rows[0].option_key, before.placement_option_key);
            assert.strictEqual(rows[0].step_kind, 'harness.edit');
            assert.ok(Number(rows[0].ok_w) > 0 && Number(rows[0].n_w) === 1);
            // The same ending delivered again changes nothing: placement_recorded is the fence.
            await t.ctx.tasks.afterEnd(task.id);
            const again = await db.one('SELECT * FROM placement_outcomes WHERE person_id = $1', [ada.subject]);
            assert.strictEqual(Number(again.n_w), 1, 'recorded once');
            // A stopped task is the person's own act: no new row.
            const cancelled = await startTask(bo.subject, 'codex');
            await t.ctx.tasks.stopTask(await db.one('SELECT * FROM run_tasks WHERE id = $1', [cancelled.id]));
            assert.strictEqual(Number(await db.value('SELECT count(*) FROM placement_outcomes WHERE person_id = $1', [bo.subject])), 0);
        });

        await check('the learned table is exported and erased with the person', async () => {
            const accountData = require('../server/account-data').create({ db, log: t.ctx.log });
            const part = await accountData.exportPart(ada.subject);
            const file = part.files.find((f) => f.name === 'placement-outcomes.json');
            assert.ok(file, JSON.stringify(part.files.map((f) => f.name)));
            assert.strictEqual(file.content.length, 1);
            assert.ok(file.content[0].option_key);
            await accountData.erase([ada.subject]);
            assert.strictEqual(Number(await db.value('SELECT count(*) FROM placement_outcomes WHERE person_id = $1', [ada.subject])), 0);
        });
    } finally {
        await t.close();
    }
    done();
})();
