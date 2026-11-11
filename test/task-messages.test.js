'use strict';
/**
 * A message to a task (POST /api/v1/tasks/:id/message, ask 354): while an attempt is live the message waits in
 * codes_task_messages (202, nothing lost — a Run job on the person's machine cannot be interrupted mid-run); when
 * the attempt ends the next attempt carries the waiting notes in its prompt, whether the engine planned a follow-up
 * or ended the task. When nothing runs the message carries the task on at once, like a continue with a note. A
 * stopped task refuses (409) and keeps its queue.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const submits = [];
    let counter = 0;
    const jobs = new Map();
    const run = {
        enabled: true,
        async submit(o) {
            counter++;
            const id = `job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J${String(counter).padStart(2, '0')}`;
            jobs.set(id, { id, state: 'queued', args: o.args });
            submits.push(o);
            return { id, state: 'queued' };
        },
        async read(jobId) { return jobs.get(jobId) || { id: jobId, state: 'queued' }; },
        async cancel(jobId) { const j = jobs.get(jobId); if (j) j.state = 'cancelled'; return j || { id: jobId, state: 'cancelled' }; },
        async streamUrl() { throw new Error('not used'); },
    };
    const t = await boot({ run });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    const bo = t.network.addUser('bo');
    const actor = t.network.mintService('svc:actor', 'openvibe.codes', ['codes.task.start', 'codes.task.read', 'codes.task.cancel']);
    const project = 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1';
    // Ada ran a task on /run before (so Codes knows her project); Bo never did.
    await db.exec(`INSERT INTO run_tasks (id, subject, project_id, job_id, repo, prompt, state, created_at, updated_at)
        VALUES ('tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T1', $1, $2, 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z200', 'https://github.com/a/b', 'by hand', 'succeeded', 1, 2)`, [ada.subject, project]);

    const asAda = async (method, path, body, token = t.network.userToken(ada)) => {
        const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(`${t.base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
        return { status: res.status, json: await res.json().catch(() => null) };
    };

    let seq = 0;
    const startTask = async () => {
        seq++;
        const r = await asAda('POST', '/tasks', { repo: 'https://github.com/octocat/Hello-World', prompt: 'Add a line to the README.', agent: 'deepseek', idempotency_key: `act_msg_${seq}` });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        return r.json.task.id;
    };
    const attemptsOf = async (taskId) => db.many('SELECT * FROM codes_attempts WHERE task_id = $1 ORDER BY n ASC', [taskId]);
    const messagesOf = async (taskId) => db.many('SELECT * FROM codes_task_messages WHERE task_id = $1 ORDER BY n ASC', [taskId]);
    /** The attempt ends the way Run delivers it, then the engine decides what happens next. */
    const endAttempt = async (taskId, ok, text) => {
        const row = await db.one('SELECT * FROM run_tasks WHERE id = $1', [taskId]);
        const job = {
            id: row.job_id, state: ok ? 'succeeded' : 'failed',
            result: {
                ok, summary: text, files: [],
                log: [{ t: 'agent', agent: 'deepseek', session: 'sess-1' }, { t: 'done', ok, text }],
            },
            ...(ok ? {} : { error: { code: 'run.job.worker_failed', detail: text } }),
        };
        const updated = await t.ctx.tasks.applyEvent(row, { state: ok ? 'succeeded' : 'failed', job, error: ok ? null : text });
        return t.ctx.tasks.afterEnd(updated.id);
    };

    try {
        await check('a message to a live task waits: 202, queued, no new attempt, no job', async () => {
            const id = await startTask();
            const before = submits.length;
            const r = await asAda('POST', `/tasks/${id}/message`, { text: 'also check the spelling' });
            assert.strictEqual(r.status, 202, JSON.stringify(r.json));
            assert.strictEqual(r.json.queued, true);
            assert.strictEqual(r.json.message.n, 1);
            assert.strictEqual(r.json.message.text, 'also check the spelling');
            assert.strictEqual((await attemptsOf(id)).length, 1, 'no new attempt while one runs');
            assert.strictEqual(submits.length, before, 'no job while one runs');
            const rows = await messagesOf(id);
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].state, 'queued');
        });

        await check('a second message joins the queue in order', async () => {
            const id = await startTask();
            await asAda('POST', `/tasks/${id}/message`, { text: 'first' });
            const r = await asAda('POST', `/tasks/${id}/message`, { note: 'second' });
            assert.strictEqual(r.status, 202, JSON.stringify(r.json));
            assert.strictEqual(r.json.message.n, 2);
            const rows = await messagesOf(id);
            assert.deepStrictEqual(rows.map((m) => m.text), ['first', 'second']);
            assert.ok(rows.every((m) => m.state === 'queued'));
        });

        await check('when the attempt crashes, the follow-up carries the waiting notes', async () => {
            const id = await startTask();
            await asAda('POST', `/tasks/${id}/message`, { text: 'also check the spelling' });
            await asAda('POST', `/tasks/${id}/message`, { text: 'and the license header' });
            const before = submits.length;
            await endAttempt(id, false, 'the machine went away');
            const attempts = await attemptsOf(id);
            assert.strictEqual(attempts.length, 2, 'the task was carried on');
            assert.strictEqual(submits.length, before + 1, 'one follow-up job');
            const prompt = String(submits[submits.length - 1].args.prompt);
            assert.ok(prompt.includes('Notes from the owner (sent while the last attempt ran)'), 'the notes ride the follow-up');
            assert.ok(prompt.includes('also check the spelling') && prompt.includes('and the license header'), 'both notes');
            assert.ok((await messagesOf(id)).every((m) => m.state === 'delivered'), 'taken exactly once');
        });

        await check('when the engine ends the task with notes waiting, it carries on by itself', async () => {
            const id = await startTask();
            await asAda('POST', `/tasks/${id}/message`, { text: 'double-check the edge cases' });
            const before = submits.length;
            await endAttempt(id, true, 'done, all green');
            const attempts = await attemptsOf(id);
            assert.strictEqual(attempts.length, 2, 'the waiting message started the next attempt');
            assert.strictEqual(submits.length, before + 1, 'one follow-up job');
            assert.ok(String(submits[submits.length - 1].args.prompt).includes('double-check the edge cases'), 'the note rides it');
            assert.ok((await messagesOf(id)).every((m) => m.state === 'delivered'), 'taken exactly once');
        });

        await check('a message to an ended task carries it on at once, like a continue with a note', async () => {
            const id = await startTask();
            await endAttempt(id, true, 'done, all green');
            assert.strictEqual((await attemptsOf(id)).length, 1, 'the engine left the finished task alone');
            const before = submits.length;
            const r = await asAda('POST', `/tasks/${id}/message`, { text: 'and the tests' });
            assert.strictEqual(r.status, 200, JSON.stringify(r.json));
            assert.strictEqual((await attemptsOf(id)).length, 2, 'the message is the next attempt');
            assert.strictEqual(submits.length, before + 1, 'one job');
            assert.ok(String(submits[submits.length - 1].args.prompt).includes('and the tests'), 'the note rides it');
        });

        await check('a stopped task refuses and keeps its queue: 409, nothing starts', async () => {
            const id = await startTask();
            await asAda('POST', `/tasks/${id}/message`, { text: 'wait for me' });
            const stopped = await asAda('POST', `/tasks/${id}/stop`);
            assert.strictEqual(stopped.status, 200, JSON.stringify(stopped.json));
            const before = submits.length;
            const r = await asAda('POST', `/tasks/${id}/message`, { text: 'one more thing' });
            assert.strictEqual(r.status, 409, JSON.stringify(r.json));
            assert.strictEqual(r.json.code, 'codes.task_conflict');
            assert.strictEqual(submits.length, before, 'no job on a stopped task');
            assert.strictEqual((await attemptsOf(id)).length, 1, 'no attempt on a stopped task');
            assert.deepStrictEqual((await messagesOf(id)).map((m) => m.state), ['queued'], 'the queue waits for a hand carry-on');
        });

        await check('empty and too long are 422; another person and a missing task are 404', async () => {
            const id = await startTask();
            assert.strictEqual((await asAda('POST', `/tasks/${id}/message`, { text: '  ' })).status, 422);
            assert.strictEqual((await asAda('POST', `/tasks/${id}/message`, { text: 'x'.repeat(4001) })).status, 422);
            const other = await asAda('POST', `/tasks/${id}/message`, { text: 'hello' }, t.network.userToken(bo));
            assert.strictEqual(other.status, 404);
            assert.strictEqual((await asAda('POST', '/tasks/tsk_01J8Z3Q4R5S6T7V8W9X0Y9Z9Q9/message', { text: 'hello' })).status, 404);
        });

        await check('the live task page says a message waits for the next attempt', async () => {
            const id = await startTask();
            await asAda('POST', `/tasks/${id}/message`, { text: 'wait for me' });
            const page = await t.get(`/run/tasks/${id}`, { as: ada });
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('data-pending'), 'the waiting line is on the page');
            assert.ok(page.text.includes('A message waits for the next attempt'), 'in plain words');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
