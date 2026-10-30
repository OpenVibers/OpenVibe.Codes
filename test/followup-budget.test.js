'use strict';

/**
 * The budget of every attempt (Codes C3): the first try and every follow-up after it (a continue, a switch, a
 * wrap-up) gets a run token of its own, carrying what is left of the task's budget — the task's budget minus what
 * the earlier attempts spent, as OpenVibe.AI counted it. When nothing is left of it, the follow-up does not start
 * and the task ends at its budget. An attempt on the person's own plan (their CLI subscription on their machine)
 * needs no token at all, and the attempt says so.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    // A stand-in for OpenVibe.AI: it keeps the budgets Codes registers and what each run spent.
    const budgets = new Map();
    const registered = [];
    const ai = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const send = (status, doc) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(doc)); };
            if (req.url.startsWith('/api/v1/credentials')) return send(404, { detail: 'no key for this provider' });
            const jti = decodeURIComponent(req.url.split('/').pop());
            if (req.method === 'PUT') {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                budgets.set(jti, {
                    budget_usd: body.budget_usd == null ? null : Number(body.budget_usd),
                    budget_tokens: body.budget_tokens == null ? null : Number(body.budget_tokens),
                    spent_usd: 0, spent_tokens: 0,
                });
                registered.push({ jti, body });
                return send(200, { jti, ...body });
            }
            const row = budgets.get(jti) || { budget_usd: null, budget_tokens: null, spent_usd: 0, spent_tokens: 0 };
            return send(200, { jti, ...row, reached: row.budget_tokens != null && row.spent_tokens >= row.budget_tokens });
        });
    });
    await new Promise((r) => ai.listen(0, '127.0.0.1', r));
    const aiUrl = `http://127.0.0.1:${ai.address().port}`;

    const submits = [];
    const jobs = new Map();
    let counter = 0;
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
        async cancel(jobId) { const j = jobs.get(jobId); if (j) j.state = 'cancelled'; return j; },
        async streamUrl() { throw new Error('not used'); },
    };

    // The person's connections: no key of their own, and a Claude plan on their machine.
    const connections = {
        async list() { return { keys: [], plans: [{ provider: 'anthropic', machine: 'ada-mac', label: 'Claude Max' }] }; },
    };

    const t = await boot({
        run, connections,
        env: { CODES_AI_URL: aiUrl, CODES_AI_INTERNAL_URL: aiUrl, CODES_TASK_TOKENS: '1000', CODES_TASK_USD: '2' },
    });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    const actor = t.network.mintService('svc:actor', 'openvibe.codes', ['codes.task.start', 'codes.task.read', 'codes.task.cancel']);
    const project = 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1';
    // A task the person ran in the browser: a service's task runs in the project of their latest one there.
    await db.exec(`INSERT INTO run_tasks (id, subject, project_id, job_id, repo, prompt, state, created_at, updated_at)
        VALUES ('tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T1', $1, $2, 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2Z200', 'https://github.com/a/b', 'by hand', 'succeeded', 1, 2)`, [ada.subject, project]);

    const call = async (method, path, body) => {
        const headers = { Accept: 'application/json', Authorization: `Bearer ${actor}`, 'X-OV-Subject': ada.subject };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(`${t.base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, json: await res.json().catch(() => null) };
    };

    const startTask = async (agent) => {
        const r = await call('POST', '/tasks', {
            repo: 'https://github.com/octocat/Hello-World', prompt: 'Add a line to the README.', agent,
            idempotency_key: `act_budget_${Math.random().toString(36).slice(2, 10)}`,
        });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        return r.json.task.id;
    };

    const attemptsOf = async (taskId) => await db.many('SELECT * FROM codes_attempts WHERE task_id = $1 ORDER BY n ASC', [taskId]);
    const rowOf = async (taskId) => await db.one('SELECT * FROM run_tasks WHERE id = $1', [taskId]);

    /** The attempt ends in a crash, so the engine carries the task on in the same conversation. */
    const endAttempt = async (taskId, error = 'the machine went away') => {
        const row = await rowOf(taskId);
        const result = {
            ok: false, summary: 'I will continue with the rest of it', files: [],
            log: [{ t: 'agent', agent: 'deepseek', session: 'sess-42' }, { t: 'done', ok: false, text: 'I will continue with the rest of it' }],
        };
        const job = { id: row.job_id, state: 'failed', result, error: { code: 'run.job.worker_failed', detail: error } };
        const updated = await t.ctx.tasks.applyEvent(row, { state: 'failed', job, error });
        await t.ctx.tasks.afterEnd(updated.id);
        return updated;
    };

    try {
        await check('a follow-up gets a run token of its own, with what is left of the task\'s budget', async () => {
            const id = await startTask('deepseek');
            assert.strictEqual(registered.length, 1, 'the first attempt minted a token');
            assert.strictEqual(registered[0].body.budget_tokens, 1000);
            assert.strictEqual(registered[0].body.budget_usd, 2);
            // What the first attempt spent, as OpenVibe.AI counted it.
            budgets.get(registered[0].jti).spent_usd = 0.42;
            budgets.get(registered[0].jti).spent_tokens = 400;

            await endAttempt(id);
            const attempts = await attemptsOf(id);
            assert.strictEqual(attempts.length, 2, 'the task was carried on');
            assert.strictEqual(attempts[1].kind, 'continue');
            assert.strictEqual(Number(attempts[1].budget_tokens), 600, 'the follow-up carries what is left of the tokens');
            assert.strictEqual(Number(attempts[1].budget_usd), 1.58, 'the follow-up carries what is left of the dollars');
            assert.strictEqual(attempts[1].run_mode, 'ai', 'the attempt ran through OpenVibe.AI');
            assert.strictEqual(registered.length, 2, 'the follow-up minted a token of its own');
            assert.strictEqual(registered[1].body.budget_tokens, 600);
            assert.strictEqual(registered[1].body.budget_usd, 1.58);
            const job = submits[submits.length - 1];
            assert.ok(job.args.env, 'the follow-up runs with a token');
            assert.ok(job.args.env.DEEPSEEK_API_KEY, 'the token is in the environment');
        });

        await check('a follow-up after the budget is spent does not start, and the task ends at its budget', async () => {
            const before = submits.length;
            const id = await startTask('deepseek');
            const token = registered[registered.length - 1];
            budgets.get(token.jti).spent_usd = 2;
            budgets.get(token.jti).spent_tokens = 1000;

            await endAttempt(id);
            const attempts = await attemptsOf(id);
            assert.strictEqual(attempts.length, 1, 'no follow-up: there is no budget left');
            assert.strictEqual(submits.length, before + 1, 'only the first attempt ran');
            const task = await rowOf(id);
            assert.strictEqual(task.outcome, 'unfinished');
            assert.ok(/stopped at its budget/.test(task.outcome_note), `the outcome says it: ${task.outcome_note}`);
            assert.ok(/1000 of 1000 tokens/.test(task.outcome_note), `the outcome says what it spent: ${task.outcome_note}`);
        });

        await check('a switch after the budget is spent does not start', async () => {
            const id = await startTask('deepseek');
            const token = registered[registered.length - 1];
            budgets.get(token.jti).spent_usd = 2;
            budgets.get(token.jti).spent_tokens = 1000;
            await endAttempt(id);
            const before = submits.length;

            const r = await call('POST', `/tasks/${id}/continue`, { agent: 'codex' });
            assert.strictEqual(r.status, 409, JSON.stringify(r.json));
            assert.ok(/budget/.test(String(r.json && r.json.detail || r.json && r.json.title || '')), JSON.stringify(r.json));
            assert.strictEqual((await attemptsOf(id)).length, 1, 'the switch started no attempt');
            assert.strictEqual(submits.length, before, 'the switch started no job');
            const task = await rowOf(id);
            assert.strictEqual(task.outcome, 'unfinished');
            assert.ok(/stopped at its budget/.test(task.outcome_note), `the outcome says it: ${task.outcome_note}`);
        });

        await check('an attempt on the person\'s own plan needs no token, and the attempt says so', async () => {
            const before = registered.length;
            const id = await startTask('claude-code');
            const attempts = await attemptsOf(id);
            assert.strictEqual(attempts[0].run_mode, 'plan', 'the attempt ran on their own subscription');
            assert.strictEqual(registered.length, before, 'no run token was minted');
            const job = submits[submits.length - 1];
            assert.ok(!job.args.env, 'the job carries no token');
        });
    } finally {
        await t.close();
        await new Promise((r) => ai.close(r));
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
