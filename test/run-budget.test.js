'use strict';
/**
 * The hard spend cap of a Codes run (Codes C3): the attempt's run token carries the budget, OpenVibe.AI counts what
 * the run spends, and the request after the budget is spent is refused (402 ai.run_budget_reached). The attempt then
 * ends as "stopped at its budget" with what it spent: the outcome line, not a crash.
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
            if (req.url.startsWith('/api/v1/credentials')) return send(200, { keys: [] });
            const jti = decodeURIComponent(req.url.split('/').pop());
            if (req.method === 'PUT') {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                budgets.set(jti, { ...body, spent_usd: 0.42, spent_tokens: 1000 });
                registered.push({ jti, body });
                return send(200, { jti, ...body });
            }
            const row = budgets.get(jti) || { budget_usd: null, budget_tokens: null, spent_usd: 0, spent_tokens: 0 };
            return send(200, { jti, ...row, reached: true });
        });
    });
    await new Promise((r) => ai.listen(0, '127.0.0.1', r));
    const aiUrl = `http://127.0.0.1:${ai.address().port}`;

    let state = 'queued';
    let jobError = null;
    const run = {
        enabled: true,
        async submit() { return { id: 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J1', state: 'queued' }; },
        async read(jobId) { return { id: jobId, state, result: null, error: jobError }; },
        async cancel() { state = 'cancelled'; return { id: 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J1', state }; },
        async streamUrl() { throw new Error('not used'); },
    };
    const t = await boot({
        run,
        env: { CODES_AI_URL: aiUrl, CODES_AI_INTERNAL_URL: aiUrl, CODES_TASK_TOKENS: '1000', CODES_TASK_USD: '2' },
    });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    const actor = t.network.mintService('svc:actor', 'openvibe.codes', ['codes.task.start', 'codes.task.read']);
    const project = 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1';
    await db.exec(`INSERT INTO run_tasks (id, subject, project_id, job_id, repo, prompt, state, created_at, updated_at)
        VALUES ('tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T1', $1, $2, 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2Z200', 'https://github.com/a/b', 'by hand', 'succeeded', 1, 2)`, [ada.subject, project]);

    const start = async () => {
        const res = await fetch(`${t.base}/api/v1/tasks`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${actor}`, 'X-OV-Subject': ada.subject },
            body: JSON.stringify({ repo: 'https://github.com/octocat/Hello-World', prompt: 'Add a line to the README.', agent: 'deepseek', idempotency_key: `act_budget_${Date.now()}` }),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    };

    try {
        let taskId;
        await check('the attempt\'s run token carries the budget from Codes\' settings', async () => {
            const r = await start();
            assert.strictEqual(r.status, 201, JSON.stringify(r.body));
            taskId = r.body.task.id;
            assert.strictEqual(registered.length, 1, 'the budget was registered with OpenVibe.AI');
            assert.strictEqual(registered[0].body.budget_tokens, 1000);
            assert.strictEqual(registered[0].body.budget_usd, 2);
            assert.ok(registered[0].jti, 'the budget is registered under the token\'s own id');
        });

        await check('the token row keeps the budget, and the attempt knows it', async () => {
            const token = await db.maybe('SELECT jti, budget_usd, budget_tokens FROM codes_run_tokens WHERE task_id = $1', [taskId]);
            assert.ok(token, 'the run token was recorded');
            assert.strictEqual(Number(token.budget_tokens), 1000);
            const attempt = await db.maybe('SELECT state, budget_usd, budget_tokens FROM codes_attempts WHERE task_id = $1', [taskId]);
            assert.strictEqual(Number(attempt.budget_tokens), 1000);
        });

        await check('a run refused for its budget ends as "stopped at its budget", with what it spent', async () => {
            state = 'failed';
            jobError = 'the run was refused: ai.run_budget_reached: this run reached its tokens budget: 1000 of 1000 tokens spent.';
            const row = await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [taskId]);
            await t.ctx.tasks.refresh(row, { force: true });
            const attempt = await db.maybe('SELECT state, reason, budget_hit, cost_usd, tokens FROM codes_attempts WHERE task_id = $1', [taskId]);
            assert.strictEqual(attempt.state, 'budget-stopped');
            assert.strictEqual(attempt.reason, 'budget');
            assert.strictEqual(attempt.budget_hit, 'tokens');
            assert.strictEqual(Number(attempt.tokens), 1000);
            await t.ctx.tasks.afterEnd(taskId);
            const task = await db.maybe('SELECT outcome, outcome_note FROM run_tasks WHERE id = $1', [taskId]);
            assert.strictEqual(task.outcome, 'unfinished');
            assert.ok(/stopped at its budget/.test(task.outcome_note), `the outcome line says it: ${task.outcome_note}`);
            assert.ok(/1000 of 1000 tokens/.test(task.outcome_note), `the outcome line says what it spent: ${task.outcome_note}`);
        });

        await check('the task carries on: nothing was spent twice', async () => {
            const attempts = await db.many('SELECT n, state FROM codes_attempts WHERE task_id = $1 ORDER BY n', [taskId]);
            assert.strictEqual(attempts.length, 1, 'a budget stop buys no wrap-up turn');
        });
    } finally {
        await t.close();
        await new Promise((r) => ai.close(r));
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
