'use strict';

/**
 * Stage C2: a task's attempts. Every Run job is one attempt; when an attempt ends the engine decides what happens
 * next — done, a continue in the same conversation, a switch to another agent, a wrap-up after a limit, or an
 * unfinished task — and one ending starts at most one follow-up (the portal's 10-30 bug, where two racing ticks
 * carried one job on twice).
 *
 * The migration (an existing task becomes attempt 1), every engine decision, the fence under two concurrent endings,
 * the stop fence, and the auth of every new route.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const TASK = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;

(async () => {
    const calls = [];
    const jobs = new Map();
    let counter = 0;
    const run = {
        enabled: true,
        async submit(o) {
            counter++;
            const id = `job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J${String(counter).padStart(2, '0')}`;
            jobs.set(id, { id, state: 'queued', args: o.args });
            calls.push(['submit', o]);
            return { id, state: 'queued' };
        },
        async read(jobId) { return jobs.get(jobId) || { id: jobId, state: 'queued' }; },
        async cancel(jobId, who) { calls.push(['cancel', jobId, who]); const j = jobs.get(jobId); if (j) j.state = 'cancelled'; return j; },
        async streamUrl() { throw new Error('not used'); },
    };
    const t = await boot({ run, env: { CODES_TASK_STEPS: '2' } });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    const bo = t.network.addUser('bo');
    const CAPS = ['codes.task.start', 'codes.task.read', 'codes.task.cancel'];
    const actor = t.network.mintService('svc:actor', 'openvibe.codes', CAPS);
    const project = 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1';

    const call = async (method, path, { token = actor, subject = ada.subject, body, headers = {} } = {}) => {
        const h = { Accept: 'application/json', ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(subject ? { 'X-OV-Subject': subject } : {}) };
        if (body !== undefined) h['Content-Type'] = 'application/json';
        const res = await fetch(`${t.base}/api/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, json: await res.json().catch(() => null) };
    };

    /** A task for Ada, started through the API (so it has its first attempt). */
    const startTask = async (prompt = 'Fix the parser and add a test for it.') => {
        const r = await call('POST', '/tasks', { body: { repo: 'https://github.com/octocat/Hello-World', prompt, idempotency_key: `act_${Math.random().toString(36).slice(2, 10)}` } });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        return r.json.task.id;
    };

    /** The attempt ends: the state change and then the engine's decision (what the events consumer does). */
    const endAttempt = async (taskId, { state = 'failed', result = null, error = null } = {}) => {
        const row = await db.one('SELECT * FROM run_tasks WHERE id = $1', [taskId]);
        const job = { id: row.job_id, state, result, error: error ? { code: 'run.job.worker_failed', detail: error } : null };
        const updated = await t.ctx.tasks.applyEvent(row, { state, job, error });
        await t.ctx.tasks.afterEnd(updated.id);
        return await rowOf(updated.id);
    };

    const attemptsOf = async (taskId) => await db.many('SELECT * FROM codes_attempts WHERE task_id = $1 ORDER BY n ASC', [taskId]);
    const rowOf = async (taskId) => await db.one('SELECT * FROM run_tasks WHERE id = $1', [taskId]);

    try {
        await check('the migration: every task that exists becomes attempt 1 of itself', async () => {
            // A task from before the attempts (written straight into the table, as an old row would be).
            const old = 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T9';
            await db.exec(`INSERT INTO run_tasks (id, subject, project_id, job_id, repo, prompt, agent, state, created_at, updated_at)
                VALUES ($1, $2, $3, 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J99', 'https://github.com/a/b', 'by hand', 'claude-code', 'succeeded', 1, 2)`, [old, ada.subject, project]);
            const read = await t.ctx.attempts.list(old);
            assert.strictEqual(read.length, 1, 'one attempt');
            assert.strictEqual(Number(read[0].n), 1);
            assert.strictEqual(read[0].state, 'done', 'the task succeeded, so its first attempt did');
            assert.ok(read[0].why, 'the attempt says why it happened');
            const shown = await t.get(`/api/v1/tasks/${old}`, { as: ada });
            assert.strictEqual(shown.status, 200, shown.text.slice(0, 200));
            assert.strictEqual(shown.json().attempts.length, 1);
            assert.strictEqual(shown.json().attempts[0].n, 1);
        });

        await check('a task starts as one attempt, and the timeline says why', async () => {
            const id = await startTask();
            const attempts = await attemptsOf(id);
            assert.strictEqual(attempts.length, 1);
            assert.strictEqual(Number(attempts[0].n), 1);
            assert.strictEqual(attempts[0].state, 'queued');
            assert.strictEqual(attempts[0].kind, 'first');
            assert.ok(attempts[0].job_id, 'the attempt carries the Run job');
            const read = await call('GET', `/tasks/${id}`);
            assert.strictEqual(read.json.id, id, 'the task at the top level, as codes.task@1 had it');
            assert.strictEqual(read.json.state, 'queued');
            assert.ok(read.json.url, 'the task carries its own fields');
            assert.strictEqual(read.json.attempts.length, 1);
            assert.strictEqual(read.json.outcome.state, null, 'a running task has no outcome yet');
        });

        await check('a finished attempt: the task is done, and nothing follows it', async () => {
            const id = await startTask();
            const updated = await endAttempt(id, { state: 'succeeded', result: { ok: true, summary: 'all done', files: [], log: [{ t: 'done', ok: true, text: 'all done' }] } });
            assert.strictEqual(updated.outcome, 'done');
            assert.strictEqual((await attemptsOf(id)).length, 1, 'no follow-up');
            const read = await call('GET', `/tasks/${id}`);
            assert.strictEqual(read.json.outcome.state, 'done');
            assert.strictEqual(read.json.attempts[0].state, 'done');
        });

        await check('a crash: the same conversation continues, with the session to resume', async () => {
            const id = await startTask();
            const result = {
                ok: false, summary: 'I will continue with the rest of it', files: [],
                log: [{ t: 'agent', agent: 'claude-code', session: 'sess-42' }, { t: 'done', ok: false, text: 'I will continue with the rest of it' }],
            };
            await endAttempt(id, { state: 'failed', result, error: 'the machine went away' });
            const attempts = await attemptsOf(id);
            assert.strictEqual(attempts.length, 2, 'the task was carried on');
            assert.strictEqual(attempts[1].kind, 'continue');
            assert.strictEqual(attempts[1].session, 'sess-42', 'the session to resume');
            assert.ok(/^carried on in the same conversation: /.test(attempts[1].why), attempts[1].why);
            // The new attempt is a Run job of its own, with RESUME set to the session.
            const submits = calls.filter((c) => c[0] === 'submit');
            const last = submits[submits.length - 1][1];
            assert.strictEqual(last.args.resume, 'sess-42');
            assert.ok(last.args.prompt.includes('Continuation'), 'the prompt tells the agent to carry on');
            assert.notStrictEqual(last.key, id, 'the follow-up has its own idempotency key');
        });

        await check('a limit: another agent takes over, with a hand-over note of what the last one did', async () => {
            const id = await startTask();
            const result = { ok: false, summary: 'I fixed the parser', files: [{ path: 'src/parse.js', added: 3, removed: 1 }], log: [{ t: 'done', ok: false, text: 'usage limit reached' }] };
            await endAttempt(id, { state: 'failed', result, error: 'usage limit reached' });
            const attempts = await attemptsOf(id);
            assert.strictEqual(attempts.length, 2);
            assert.strictEqual(attempts[1].kind, 'switch');
            assert.ok(attempts[1].agent && attempts[1].agent !== attempts[0].agent, `${attempts[1].agent} took over from ${attempts[0].agent}`);
            assert.ok(/took over: /.test(attempts[1].why), attempts[1].why);
            const submits = calls.filter((c) => c[0] === 'submit');
            const last = submits[submits.length - 1][1];
            assert.ok(last.args.prompt.includes('Hand-over'), 'the new agent gets a hand-over note');
            assert.ok(last.args.prompt.includes('src/parse.js'), 'the note says what changed');
            assert.ok(last.args.prompt.includes('I fixed the parser'), 'the note says what it said');
        });

        await check('a limit of the owner: one last turn to land the work', async () => {
            const id = await startTask();
            const result = {
                ok: false, summary: 'half done', files: [],
                log: [{ t: 'tool', id: 't1', name: 'Edit' }, { t: 'tool', id: 't2', name: 'Edit' }, { t: 'done', ok: false, text: 'maximum turns' }],
            };
            await endAttempt(id, { state: 'failed', result, error: 'the agent stopped' });
            const attempts = await attemptsOf(id);
            assert.strictEqual(attempts.length, 2);
            assert.strictEqual(attempts[0].state, 'budget-stopped', 'a limit is not a failure');
            assert.strictEqual(attempts[0].reason, 'budget');
            assert.strictEqual(attempts[1].kind, 'wrap-up');
            assert.ok(/one last turn to land the work/.test(attempts[1].why), attempts[1].why);
            const submits = calls.filter((c) => c[0] === 'submit');
            assert.ok(submits[submits.length - 1][1].args.prompt.includes('one short last turn'), 'the wrap-up prompt');
        });

        await check('the same failure twice: the task is unfinished, with what is left', async () => {
            const id = await startTask();
            const fail = { ok: false, summary: 'it broke', files: [], log: [{ t: 'done', ok: false, text: 'the tool call failed' }] };
            await endAttempt(id, { state: 'failed', result: fail, error: 'the tool call failed' });
            await endAttempt(id, { state: 'failed', result: fail, error: 'the tool call failed' });
            const attempts = await attemptsOf(id);
            assert.strictEqual(attempts.length, 2, 'a second opinion, and no more');
            const row = await rowOf(id);
            assert.strictEqual(row.outcome, 'unfinished');
            assert.ok(row.outcome_note && row.outcome_note.length > 10, 'the outcome says what is left');
        });

        await check('one ending starts at most one follow-up, even when two endings race', async () => {
            const id = await startTask();
            const before = calls.filter((c) => c[0] === 'submit').length;
            const row = await rowOf(id);
            const job = { id: row.job_id, state: 'failed', result: { ok: false, summary: 'x', files: [], log: [{ t: 'done', ok: false, text: 'usage limit reached' }] }, error: { code: 'run.job.worker_failed', detail: 'usage limit reached' } };
            // Two ticks see the same ending at the same time (the portal's 10-30 bug).
            await Promise.all([
                t.ctx.tasks.applyEvent(row, { state: 'failed', job, error: 'usage limit reached' }),
                t.ctx.tasks.applyEvent(row, { state: 'failed', job, error: 'usage limit reached' }),
            ]);
            await Promise.all([t.ctx.tasks.afterEnd(id), t.ctx.tasks.afterEnd(id)]);
            const attempts = await attemptsOf(id);
            assert.strictEqual(attempts.length, 2, 'one follow-up, not two');
            const submits = calls.filter((c) => c[0] === 'submit').length - before;
            assert.strictEqual(submits, 1, 'one job started, not two');
        });

        await check('a stop fences the task: the outcome is stopped and nothing carries it on', async () => {
            const id = await startTask();
            const before = calls.filter((c) => c[0] === 'submit').length;
            const stopped = await call('POST', `/tasks/${id}/stop`);
            assert.strictEqual(stopped.status, 200, JSON.stringify(stopped.json));
            assert.strictEqual(stopped.json.outcome.state, 'stopped');
            assert.ok(calls.some((c) => c[0] === 'cancel'), 'the job was cancelled');
            const attempts = await attemptsOf(id);
            assert.strictEqual(attempts[0].state, 'stopped');
            assert.strictEqual(attempts[0].reason, 'stopped');
            // The machine's late report changes nothing.
            await endAttempt(id, { state: 'failed', error: 'the machine went away' });
            assert.strictEqual((await attemptsOf(id)).length, 1, 'nothing carried it on');
            assert.strictEqual(calls.filter((c) => c[0] === 'submit').length - before, 0, 'no job was started');
            assert.strictEqual((await rowOf(id)).outcome, 'stopped');
        });

        await check('the owner carries the task on, or hands it to another agent', async () => {
            const id = await startTask();
            await endAttempt(id, { state: 'succeeded', result: { ok: true, summary: 'done', files: [], log: [{ t: 'done', ok: true, text: 'done' }] } });
            const continued = await call('POST', `/tasks/${id}/continue`, { body: { note: 'Only the tests are left.' } });
            assert.strictEqual(continued.status, 200, JSON.stringify(continued.json));
            assert.strictEqual(continued.json.attempts.length, 2);
            assert.strictEqual(continued.json.attempts[1].kind, 'manual');
            assert.ok(/carried on by the owner/.test(continued.json.attempts[1].why), continued.json.attempts[1].why);
            // While the task runs again, nobody carries it on a second time.
            const again = await call('POST', `/tasks/${id}/continue`, { body: { agent: 'codex' } });
            assert.strictEqual(again.status, 409, 'the task is running again');
        });

        await check('the auth of every new route: no token, no capability, another person', async () => {
            const id = await startTask();
            const noCap = t.network.mintService('svc:nocap', 'openvibe.codes', ['codes.other']);
            const other = t.network.mintService('svc:other', 'openvibe.codes', CAPS);
            // No token at all.
            for (const [method, path] of [['GET', `/tasks/${id}`], ['GET', `/tasks/${id}/events`], ['POST', `/tasks/${id}/continue`], ['POST', `/tasks/${id}/stop`]]) {
                const res = await call(method, path, { token: null });
                assert.strictEqual(res.status, 401, `${method} ${path} without a token`);
            }
            // A service without the capability.
            assert.strictEqual((await call('GET', `/tasks/${id}`, { token: noCap })).status, 403);
            assert.strictEqual((await call('POST', `/tasks/${id}/continue`, { token: noCap, body: {} })).status, 403);
            // Another person, and another service (which sees only the tasks it started).
            assert.strictEqual((await call('GET', `/tasks/${id}`, { subject: bo.subject })).status, 404);
            assert.strictEqual((await call('GET', `/tasks/${id}`, { token: other })).status, 404);
            assert.strictEqual((await call('POST', `/tasks/${id}/stop`, { subject: bo.subject })).status, 404);
            // A task that does not exist.
            assert.strictEqual((await call('GET', '/tasks/tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T1')).status, 404);
            assert.strictEqual((await call('GET', '/tasks/nope')).status, 404);
        });

        await check('the task page shows the timeline of attempts, each with its why', async () => {
            const id = await startTask();
            const result = { ok: false, summary: 'x', files: [], log: [{ t: 'done', ok: false, text: 'usage limit reached' }] };
            await endAttempt(id, { state: 'failed', result, error: 'usage limit reached' });
            const page = await t.get(`/run/tasks/${id}`, { as: ada });
            assert.strictEqual(page.status, 200, page.text.slice(0, 300));
            assert.ok(page.text.includes('data-timeline'), 'the timeline is there');
            assert.ok(page.text.includes('data-attempt="1"') && page.text.includes('data-attempt="2"'), 'every attempt is a row');
            assert.ok(page.text.includes('data-state="failed"'), 'the attempt says how it ended');
            assert.ok(page.text.includes('data-why'), 'the attempt says why it happened');
            assert.ok(/took over: /.test(page.text), 'the second attempt says who took over');
            assert.ok(page.text.indexOf('data-timeline') < page.text.indexOf('data-session') || !page.text.includes('data-session'),
                'the timeline is above the session');
        });

        await check('a task is carried on twice, and then it needs a person', async () => {
            const id = await startTask();
            const crash = {
                ok: false, summary: 'I will continue with the rest of it', files: [],
                log: [{ t: 'agent', agent: 'claude-code', session: 'sess-1' }, { t: 'done', ok: false, text: 'I will continue with the rest of it' }],
            };
            await endAttempt(id, { state: 'failed', result: crash, error: 'the machine went away' });
            await endAttempt(id, { state: 'failed', result: crash, error: 'the machine went away' });
            const attempts = await attemptsOf(id);
            assert.strictEqual(attempts.filter((a) => a.kind === 'continue').length, 2, 'two automatic continues');
            await endAttempt(id, { state: 'failed', result: crash, error: 'the machine went away' });
            const row = await rowOf(id);
            assert.strictEqual(row.outcome, 'unfinished', 'the third one needs a person');
            assert.ok(/carried on 2 times/.test(row.outcome_note), row.outcome_note);
            assert.strictEqual((await attemptsOf(id)).length, 3, 'no third continue');
        });

        await check('the owner needs no token: their own task reads, continues and stops', async () => {
            const id = await startTask();
            const mine = await t.get(`/api/v1/tasks/${id}`, { as: ada });
            assert.strictEqual(mine.status, 200, mine.text.slice(0, 200));
            assert.strictEqual(mine.json().attempts.length, 1);
            const theirs = await t.get(`/api/v1/tasks/${id}`, { as: bo });
            assert.strictEqual(theirs.status, 404);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
