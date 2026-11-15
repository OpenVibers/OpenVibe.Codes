'use strict';
/**
 * The Run API's message and stop on Codes runs (agents.message@1, Contracts 0.434.0): POST /api/v1/runs/:id/messages
 * carries a task on with the person's words, or waits while an attempt runs (202); USE swaps the harness, the model or
 * the effort from that turn on, in the same task (a hand-over keeps the conversation); a swap during an attempt is 409
 * agents.run_busy, a task stopped on purpose 409 agents.run_closed, a model or field Codes cannot run 409
 * agents.use_unavailable, and none of them starts anything. POST /api/v1/runs/:id/stop stops the running attempt.
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
            const id = `job_01J8Z3Q4R5S6T7V8W9X0Y1Z2K${String(counter).padStart(2, '0')}`;
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
    const project = 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1';
    await db.exec(`INSERT INTO run_tasks (id, subject, project_id, job_id, repo, prompt, state, created_at, updated_at)
        VALUES ('tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T1', $1, $2, 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z200', 'https://github.com/a/b', 'by hand', 'succeeded', 1, 2)`, [ada.subject, project]);

    const asAda = async (method, path, body, { token = t.network.userToken(ada), headers: more = {} } = {}) => {
        const headers = { Accept: 'application/json', Authorization: `Bearer ${token}`, ...more };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(`${t.base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    let seq = 0;
    const startTask = async () => {
        seq++;
        const r = await asAda('POST', '/tasks', { repo: 'https://github.com/octocat/Hello-World', prompt: 'Add a line to the README.', agent: 'deepseek', idempotency_key: `act_runmsg_${seq}` });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        return r.json.task.id;
    };
    const attemptsOf = async (taskId) => db.many('SELECT * FROM codes_attempts WHERE task_id = $1 ORDER BY n ASC', [taskId]);
    const endAttempt = async (taskId, ok, text) => {
        const row = await db.one('SELECT * FROM run_tasks WHERE id = $1', [taskId]);
        const job = {
            id: row.job_id, state: ok ? 'succeeded' : 'failed',
            result: { ok, summary: text, files: [], log: [{ t: 'agent', agent: 'deepseek', session: 'sess-1' }, { t: 'done', ok, text }] },
            ...(ok ? {} : { error: { code: 'run.job.worker_failed', detail: text } }),
        };
        const updated = await t.ctx.tasks.applyEvent(row, { state: ok ? 'succeeded' : 'failed', job, error: ok ? null : text });
        return t.ctx.tasks.afterEnd(updated.id);
    };
    const ended = async () => { const id = await startTask(); await endAttempt(id, true, 'done, all green'); return id; };

    try {
        const listed = await asAda('GET', '/harnesses');
        assert.strictEqual(listed.status, 200, JSON.stringify(listed.json));
        const rows = Array.isArray(listed.json) ? listed.json : (listed.json.harnesses || listed.json.items || []);
        const other = (rows.find((h) => h.id === 'codex') || rows.find((h) => h.id && h.id !== 'deepseek')).id;

        await check('words carry an ended task on: 201 and the person\'s step, one new attempt', async () => {
            const id = await ended();
            const before = submits.length;
            const r = await asAda('POST', `/runs/${id}/messages`, { text: 'and the tests' });
            assert.strictEqual(r.status, 201, JSON.stringify(r.json));
            assert.deepStrictEqual([r.json.run_id, r.json.kind, r.json.from, r.json.text], [id, 'message', 'person', 'and the tests']);
            assert.ok(Number.isInteger(r.json.seq) && r.json.seq >= 1 && !Number.isNaN(Date.parse(r.json.started_at)));
            assert.strictEqual((await attemptsOf(id)).length, 2);
            assert.strictEqual(submits.length, before + 1);
            assert.ok(String(submits[submits.length - 1].args.prompt).includes('and the tests'));
        });

        await check('use.harness hands the task to another harness, with the conversation so far', async () => {
            const id = await ended();
            const r = await asAda('POST', `/runs/codes:${id}/messages`, { text: 'finish the tests', use: { harness: other, effort: 'high' } });
            assert.strictEqual(r.status, 201, JSON.stringify(r.json));
            const attempts = await attemptsOf(id);
            assert.strictEqual(attempts.length, 2);
            assert.strictEqual(attempts[1].agent, other);
            assert.strictEqual(attempts[1].effort, 'high');
            const prompt = String(submits[submits.length - 1].args.prompt);
            assert.ok(prompt.includes('takes over from') && prompt.includes('finish the tests'), 'a hand-over with the note');
        });

        await check('use.model swaps the model and keeps the harness', async () => {
            const id = await ended();
            const r = await asAda('POST', `/runs/${id}~1/messages`, { text: 'try the stronger model', use: { model: { id: 'deepseek-reasoner', source: 'openvibe', name: 'DeepSeek Reasoner', effort: 'max' } } });
            assert.strictEqual(r.status, 201, JSON.stringify(r.json));
            const attempts = await attemptsOf(id);
            assert.deepStrictEqual([attempts[1].agent, attempts[1].model, attempts[1].effort], [attempts[0].agent, 'deepseek-reasoner', 'max']);
        });

        await check('during an attempt words wait (202) and a swap is 409 agents.run_busy; nothing starts', async () => {
            const id = await startTask();
            const before = submits.length;
            const waits = await asAda('POST', `/runs/${id}/messages`, { text: 'also check the spelling' });
            assert.strictEqual(waits.status, 202, JSON.stringify(waits.json));
            assert.strictEqual(waits.json.from, 'person');
            const busy = await asAda('POST', `/runs/${id}/messages`, { text: 'swap now', use: { harness: other } });
            assert.strictEqual(busy.status, 409, JSON.stringify(busy.json));
            assert.strictEqual(busy.json.code, 'agents.run_busy');
            assert.strictEqual(submits.length, before);
            assert.strictEqual((await attemptsOf(id)).length, 1);
        });

        await check('what Codes cannot run is 409 agents.use_unavailable, a malformed use 422, and nothing starts', async () => {
            const id = await ended();
            const before = submits.length;
            const cases = [
                [{ model: { id: 'qwen3:8b', source: 'machines', machine: 'mch_1' } }, 409, 'agents.use_unavailable'],
                [{ model: { id: 'a model with spaces' } }, 409, 'agents.use_unavailable'],
                [{ temperature: 1 }, 409, 'agents.use_unavailable'],
                [{ harness: 'no-such-harness' }, 409, 'agents.use_unavailable'],
                [{ effort: 'ultra' }, 422, 'runs.bad_use'],
                [{ model: 'deepseek-chat' }, 422, 'runs.bad_use'],
                [{}, 422, 'runs.bad_use'],
            ];
            for (const [use, status, code] of cases) {
                const r = await asAda('POST', `/runs/${id}/messages`, { text: 'go', use });
                assert.strictEqual(r.status, status, `${JSON.stringify(use)}: ${JSON.stringify(r.json)}`);
                assert.strictEqual(r.json.code, code, JSON.stringify(use));
            }
            assert.strictEqual((await asAda('POST', `/runs/${id}/messages`, { text: '  ' })).json.code, 'runs.say_needs_words');
            assert.strictEqual((await asAda('POST', `/runs/${id}/messages`, { text: 'see this', attachments: [{ kind: 'image', media_id: 'med_1' }] })).status, 422);
            assert.strictEqual((await asAda('POST', `/runs/${id}/messages`, { text: 'x'.repeat(4001) })).status, 422);
            assert.strictEqual(submits.length, before, 'no job for any of them');
            assert.strictEqual((await attemptsOf(id)).length, 1);
        });

        await check('another person\'s run, a missing run and a run id that is not one are 404', async () => {
            const id = await ended();
            assert.strictEqual((await asAda('POST', `/runs/${id}/messages`, { text: 'hello' }, { token: t.network.userToken(bo) })).status, 404);
            assert.strictEqual((await asAda('POST', '/runs/tsk_01J8Z3Q4R5S6T7V8W9X0Y9Z9Q9/messages', { text: 'hello' })).status, 404);
            assert.strictEqual((await asAda('POST', '/runs/chat:abc/messages', { text: 'hello' })).status, 404);
            assert.strictEqual((await asAda('POST', `/runs/${id}/stop`, undefined, { token: t.network.userToken(bo) })).status, 404);
        });

        await check('an Idempotency-Key answers a repeat with the first answer, and starts one attempt', async () => {
            const id = await ended();
            const before = submits.length;
            const headers = { 'Idempotency-Key': 'msg-key-0001' };
            const a = await asAda('POST', `/runs/${id}/messages`, { text: 'once', use: { effort: 'low' } }, { headers });
            const b = await asAda('POST', `/runs/${id}/messages`, { text: 'once', use: { effort: 'low' } }, { headers });
            assert.strictEqual(a.status, 201, JSON.stringify(a.json));
            assert.deepStrictEqual(b, a);
            assert.strictEqual(submits.length, before + 1);
            assert.strictEqual((await asAda('POST', `/runs/${id}/messages`, { text: 'x' }, { headers: { 'Idempotency-Key': 'bad key!' } })).status, 422);
        });

        await check('stop ends the running attempt; a message after it is 409 agents.run_closed', async () => {
            const id = await startTask();
            const stopped = await asAda('POST', `/runs/${id}/stop`);
            assert.strictEqual(stopped.status, 200, JSON.stringify(stopped.json));
            assert.deepStrictEqual(stopped.json, { id, ref: `codes:${id}`, status: 'stopped' });
            const before = submits.length;
            const r = await asAda('POST', `/runs/${id}/messages`, { text: 'one more thing', use: { harness: other } });
            assert.strictEqual(r.status, 409, JSON.stringify(r.json));
            assert.strictEqual(r.json.code, 'agents.run_closed');
            assert.strictEqual(submits.length, before);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
