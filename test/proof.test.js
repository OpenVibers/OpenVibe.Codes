'use strict';

/**
 * Stage C8: a finished task's proof. The machine collects it (harness/job.js) and sends it with the result; the
 * server keeps it (one row per item), tells the world one event per item, and says the task's outcome in plain words.
 *
 * The review is behind an interface (engine/review.js): with the connections of stage C3 it is a model of another
 * family through OpenVibe.AI; without them it is a fake, and the fake is what this test uses.
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
        async cancel() { throw new Error('not used'); },
        async streamUrl() { throw new Error('not used'); },
    };
    const t = await boot({ run });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    const project = 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1';

    // A service's task runs in the project of the person's latest /run task, so Ada needs one before she starts any.
    await db.exec(`INSERT INTO run_tasks (id, subject, project_id, job_id, repo, prompt, agent, state, created_at, updated_at)
        VALUES ($1, $2, $3, 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J98', 'https://github.com/a/b', 'an earlier task', 'claude-code', 'succeeded', 1, 2)`,
    ['tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T90', ada.subject, project]);

    const CAPS = ['codes.task.start', 'codes.task.read', 'codes.task.cancel'];
    const actor = t.network.mintService('svc:actor', 'openvibe.codes', CAPS);
    const startTask = async (prompt = 'Fix the parser and add a test for it.') => {
        const res = await t.get('/api/v1/tasks', {
            method: 'POST', as: ada, json: { repo: 'https://github.com/octocat/Hello-World', prompt, idempotency_key: `act_${Math.random().toString(36).slice(2, 10)}` },
            headers: { Authorization: `Bearer ${actor}`, 'X-OV-Subject': ada.subject },
        });
        assert.strictEqual(res.status, 201, res.text.slice(0, 300));
        return res.json().task.id;
    };

    /** The attempt ends with a result that carries the proof the machine collected. */
    const endAttempt = async (taskId, { state = 'succeeded', result = null } = {}) => {
        const row = await db.one('SELECT * FROM run_tasks WHERE id = $1', [taskId]);
        const job = { id: row.job_id, state, result, error: null };
        const updated = await t.ctx.tasks.applyEvent(row, { state, job });
        await t.ctx.tasks.afterEnd(updated.id);
        return await db.one('SELECT * FROM run_tasks WHERE id = $1', [taskId]);
    };

    /** The proof a machine would collect: the tests, the pages, the diff and the review. */
    const proofOf = (items = null) => ({
        items: items || [
            { kind: 'tests', label: 'tests', ok: true, skipped: false, summary: 'only the tests the change reaches (proof)' },
            { kind: 'screenshots', label: 'screenshots', ok: true, skipped: false, summary: '2 screenshots of 1 page' },
            { kind: 'diff', label: 'diff', ok: true, skipped: false, summary: '1 file changed' },
            { kind: 'review', label: 'review', ok: true, skipped: false, family: 'deepseek', summary: 'It holds together.' },
        ],
        outcome: { state: 'done', note: 'Done with proof.' },
    });

    const proofRows = async (taskId) => await db.many('SELECT * FROM codes_task_proof WHERE task_id = $1 ORDER BY n ASC', [taskId]);
    const proofLines = async (taskId) => await db.many("SELECT seq, kind, body FROM codes_session_lines WHERE task_id = $1 AND kind = 'proof' ORDER BY seq", [taskId]);

    try {
        await check('a finished task keeps its proof: one row per item, in order', async () => {
            const id = await startTask();
            await endAttempt(id, { result: { ok: true, summary: 'done', proof: proofOf() } });
            const rows = await proofRows(id);
            assert.strictEqual(rows.length, 4);
            assert.deepStrictEqual(rows.map((r) => r.kind), ['tests', 'screenshots', 'diff', 'review']);
            assert.strictEqual(rows[3].family, 'deepseek');
            assert.strictEqual(rows[0].attempt_n, 1, 'the items belong to the attempt that ended');
        });

        await check('every proof item is an event on the task\'s stream', async () => {
            const id = await startTask();
            await endAttempt(id, { result: { ok: true, proof: proofOf() } });
            const lines = await proofLines(id);
            assert.strictEqual(lines.length, 4);
            assert.strictEqual(lines[0].body.t, 'proof');
            assert.strictEqual(lines[0].body.kind, 'tests');
            assert.strictEqual(lines[3].body.family, 'deepseek');
            assert.ok(lines.every((l, i) => i === 0 || Number(l.seq) > Number(lines[i - 1].seq)), 'the lines are in order');
        });

        await check('the outcome is in plain words: done with proof', async () => {
            const id = await startTask();
            const row = await endAttempt(id, { result: { ok: true, proof: proofOf() } });
            assert.strictEqual(row.outcome, 'done');
            assert.ok(/^Done with proof/.test(row.outcome_note), row.outcome_note);
        });

        await check('a proof that failed is said out loud, and the task is not called done', async () => {
            const id = await startTask();
            const row = await endAttempt(id, {
                result: { ok: true, proof: proofOf([
                    { kind: 'tests', label: 'tests', ok: false, skipped: false, summary: 'FAIL test/proof.test.js' },
                    { kind: 'diff', label: 'diff', ok: true, skipped: false, summary: '1 file changed' },
                ]) },
            });
            assert.strictEqual(row.outcome, 'unfinished', 'the evidence wins over the agent\'s claim');
            assert.ok(/Didn't finish, with what is left/.test(row.outcome_note), row.outcome_note);
            assert.ok(/FAIL test/.test(row.outcome_note), row.outcome_note);
        });

        await check('a task the person stopped stays stopped, whatever the proof says', async () => {
            const id = await startTask();
            const row = await endAttempt(id, {
                state: 'cancelled',
                result: { ok: false, proof: proofOf([{ kind: 'tests', label: 'tests', ok: false, skipped: false, summary: 'FAIL' }]) },
            });
            assert.strictEqual(row.outcome, 'stopped');
        });

        await check('a task without a proof says nothing about one', async () => {
            const id = await startTask();
            const row = await endAttempt(id, { result: { ok: true, summary: 'done' } });
            assert.strictEqual((await proofRows(id)).length, 0);
            assert.ok(row.outcome_note, 'the engine\'s own note still stands');
        });

        await check('the API answers codes.task@2 with the outcome in plain words', async () => {
            const id = await startTask();
            await endAttempt(id, { result: { ok: true, proof: proofOf() } });
            const res = await t.get(`/api/v1/tasks/${id}`, { as: ada });
            assert.strictEqual(res.status, 200, res.text.slice(0, 200));
            const doc = res.json();
            assert.strictEqual(doc.outcome.state, 'done');
            assert.ok(/^Done with proof/.test(doc.outcome.note), doc.outcome.note);
        });

        await check('recording the same proof twice makes no second event', async () => {
            const id = await startTask();
            const row = await db.one('SELECT * FROM run_tasks WHERE id = $1', [id]);
            const job = { id: row.job_id, state: 'succeeded', result: { ok: true, proof: proofOf() } };
            await t.ctx.tasks.applyEvent(row, { state: 'succeeded', job });
            await t.ctx.tasks.afterEnd(row.id);
            await t.ctx.tasks.applyEvent(row, { state: 'succeeded', job });
            await t.ctx.tasks.afterEnd(row.id);
            assert.strictEqual((await proofRows(id)).length, 4);
            assert.ok((await proofLines(id)).length <= 8, 'the lines do not pile up');
        });

        await check('the task page shows the proof, each item with what it found', async () => {
            const id = await startTask();
            await endAttempt(id, { result: { ok: true, proof: proofOf() } });
            const res = await t.get(`/run/tasks/${id}`, { as: ada });
            assert.strictEqual(res.status, 200, res.text.slice(0, 200));
            assert.ok(res.text.includes('data-proof'), 'the page has the proof section');
            assert.ok(res.text.includes('data-proof-kind="tests"'), 'the tests are listed');
            assert.ok(res.text.includes('data-proof-kind="review"'), 'the review is listed');
            assert.ok(res.text.includes('deepseek'), 'the reviewer\'s family is shown');
        });

        console.log('proof: the items are kept, each one is an event, and the outcome is in plain words');
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
    done();
})();
