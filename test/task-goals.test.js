'use strict';

/**
 * AL1: a goal task is not done on the worker's word. The harness runs the typed check in the workspace and the result
 * carries its output; Codes sends a bounded evidence window to an independent cheap model, and only an acceptance ends
 * the task ready. A rejection resumes the same session; a spent goal budget ends the task stopped by budget; a task
 * with no goal behaves exactly as before.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const submitted = [];
    const jobs = new Map();
    let counter = 0;
    const run = {
        enabled: true,
        async submit(o) {
            counter++;
            const id = `job_01J8Z3Q4R5S6T7V8W9X0Y1Z2K${String(counter).padStart(2, '0')}`;
            const parsed = JSON.parse(JSON.stringify(o.args));
            jobs.set(id, { id, state: 'queued', args: parsed });
            submitted.push({ id, args: parsed, key: o.key });
            return { id, state: 'queued' };
        },
        async read(jobId) { return jobs.get(jobId) || { id: jobId, state: 'queued' }; },
        async cancel(jobId) { const j = jobs.get(jobId); if (j) j.state = 'cancelled'; return j; },
        async streamUrl() { throw new Error('not used'); },
    };
    // The independent verifier: a fake in the tests, so no model is called. It answers in order from `next`.
    const asked = [];
    let next = [];
    const goalVerifier = {
        model: 'deepseek-chat',
        async verify(what) { asked.push(what); return next.shift() || { status: 'rejected', reason: 'nothing configured', check_output: what.checkOutput }; },
    };
    const t = await boot({ run, goalVerifier, env: { CODES_GOALS_ENABLED: '1', CODES_TASK_STEPS: '12' } });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    const CAPS = ['codes.task.start', 'codes.task.read', 'codes.task.cancel'];
    const actor = t.network.mintService('svc:actor', 'openvibe.codes', CAPS);

    const call = async (method, path, { body } = {}) => {
        const res = await fetch(`${t.base}/api/v1${path}`, {
            method,
            headers: { Accept: 'application/json', Authorization: `Bearer ${actor}`, 'X-OV-Subject': ada.subject, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    const rowOf = async (id) => await db.one('SELECT * FROM run_tasks WHERE id = $1', [id]);
    const attemptsOf = async (id) => await db.many('SELECT * FROM codes_attempts WHERE task_id = $1 ORDER BY n ASC', [id]);

    const GOAL = {
        goal: 'The file notes.txt exists and is not empty.',
        check: { kind: 'command', value: 'test -s notes.txt' },
        budget: { tokens: 1000000, turns: 12, active_minutes: 60 },
    };

    /** A task through the API, with or without a goal. */
    const startTask = async (goal = GOAL) => {
        const body = { repo: 'https://github.com/octocat/Hello-World', prompt: 'Write notes.txt.', idempotency_key: `act_${Math.random().toString(36).slice(2, 10)}` };
        if (goal) body.goal = goal;
        const r = await call('POST', '/tasks', { body });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        return r.json.task.id;
    };

    /** The worker's turn ends: the job's state is applied and the engine decides (what the events consumer does). */
    const endAttempt = async (id, { state = 'succeeded', go = null, session = 'sess-1', turns = 2 } = {}) => {
        const row = await rowOf(id);
        const result = {
            ok: state === 'succeeded', summary: 'I wrote notes.txt.', files: [{ path: 'notes.txt', added: 1, removed: 0 }],
            tokens: 2000,
            turns, log: [{ t: 'agent', agent: row.agent, session }, { t: 'done', ok: state === 'succeeded', text: 'I wrote notes.txt.' }],
            ...(go ? { goal: go } : {}),
        };
        const job = { id: row.job_id, state, result };
        const updated = await t.ctx.tasks.applyEvent(row, { state, job });
        await t.ctx.tasks.afterEnd(updated.id);
        return { row: await rowOf(id), attempts: await attemptsOf(id) };
    };

    const acceptedCheck = { check_output: 'exit 0\n(no output)', checked: { ok: true }, proposal: 'I wrote notes.txt.', evidence: '{"check":{"ok":true}}' };
    const rejectedCheck = { check_output: 'exit 1\nnotes.txt is empty', checked: { ok: false }, proposal: 'I wrote notes.txt.', evidence: '{"check":{"ok":false}}' };

    try {
        // A person's service task runs in the project of their latest task on /run: seed one, as a first visit would.
        await db.exec(`INSERT INTO run_tasks (id, subject, project_id, job_id, repo, prompt, agent, state, created_at, updated_at)
            VALUES ('tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2Q1', $1, 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1', 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J90',
                'https://github.com/octocat/Hello-World', 'the first one', 'claude-code', 'succeeded', 1, 2)`, [ada.subject]);

        await check('a passing check and an accepting verifier end the task ready, with the evidence kept', async () => {
            next = [{ status: 'accepted', reason: 'the check passed and the evidence matches', check_output: acceptedCheck.check_output }];
            const id = await startTask();
            await endAttempt(id, { go: acceptedCheck });
            const row = await rowOf(id);
            assert.ok(row.goal, 'the task kept its goal');
            assert.strictEqual(row.end_state, 'ready');
            assert.strictEqual(row.outcome, 'done');
            const verdict = row.goal_verdict;
            assert.strictEqual(verdict.status, 'accepted');
            assert.strictEqual(verdict.check_output, acceptedCheck.check_output);
            assert.ok(verdict.reason);
            const shown = await call('GET', `/tasks/${id}`);
            assert.strictEqual(shown.json.outcome.state, 'ready');
            assert.strictEqual(shown.json.goal.verdict.status, 'accepted');
            assert.strictEqual(shown.json.goal.check_output, acceptedCheck.check_output);
            assert.strictEqual((await attemptsOf(id)).length, 1, 'an accepted goal starts no follow-up');
            assert.strictEqual(asked.length, 1, 'the verifier was asked once');
            assert.match(asked[0].checkOutput, /exit 0/);
            assert.strictEqual(submitted[0].args.goal.check.value, GOAL.check.value, 'the harness got the check');
            const page = await t.get(`/run/tasks/${id}`, { as: ada });
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /The goal and its check/);
            assert.match(page.text, /exit 0/);
            assert.match(page.text, /accepted/);
        });

        await check('a failing check is rejected and the SAME session is resumed with the check output', async () => {
            next = [{ status: 'rejected', reason: 'notes.txt is empty, so the check failed', check_output: rejectedCheck.check_output }];
            const id = await startTask();
            const { row, attempts } = await endAttempt(id, { go: rejectedCheck, session: 'sess-goal-7' });
            assert.strictEqual(attempts.length, 2, 'the task was carried on');
            assert.strictEqual(attempts[1].kind, 'continue');
            assert.strictEqual(attempts[1].agent, attempts[0].agent, 'the same worker');
            assert.strictEqual(attempts[1].session, 'sess-goal-7', 'the same session');
            const resume = submitted[submitted.length - 1].args.resume;
            assert.strictEqual(resume, 'sess-goal-7');
            assert.strictEqual(submitted[submitted.length - 1].args.goal.check.value, GOAL.check.value, 'the same check runs again in the workspace');
            assert.match(submitted[submitted.length - 1].args.prompt, /notes\.txt is empty/);
            assert.match(submitted[submitted.length - 1].args.prompt, /exit 1/);
            assert.strictEqual(row.state, 'queued', 'the follow-up is running');
            assert.strictEqual(row.goal.no_progress, 1);
        });

        await check('a spent turn budget ends the task stopped by budget, with the reason', async () => {
            next = [{ status: 'rejected', reason: 'still empty', check_output: rejectedCheck.check_output }];
            const id = await startTask({ ...GOAL, budget: { turns: 1 } });
            const { row, attempts } = await endAttempt(id, { go: rejectedCheck, turns: 7 });
            assert.strictEqual(attempts.length, 1, 'no follow-up is bought with a spent budget');
            assert.strictEqual(row.outcome, 'unfinished');
            assert.strictEqual(row.end_state, 'stopped_by_budget');
            assert.match(row.outcome_note, /stopped by budget: the task used 7 of its 1 turns/);
            const shown = await call('GET', `/tasks/${id}`);
            assert.strictEqual(shown.json.outcome.state, 'stopped_by_budget');
        });

        await check('a spent token budget also ends the task stopped by budget', async () => {
            next = [{ status: 'rejected', reason: 'still empty', check_output: rejectedCheck.check_output }];
            const id = await startTask({ ...GOAL, budget: { tokens: 100 } });
            const { row, attempts } = await endAttempt(id, { go: rejectedCheck });
            assert.strictEqual(attempts.length, 1);
            assert.strictEqual(row.end_state, 'stopped_by_budget');
            assert.match(row.outcome_note, /stopped by budget: the task spent 2000 of its 100 tokens/);
        });

        await check('a verifier that could not run leaves the task waiting, never ready', async () => {
            next = [{ status: 'failed', reason: 'the model was unavailable', check_output: acceptedCheck.check_output }];
            const id = await startTask();
            const { row, attempts } = await endAttempt(id, { go: acceptedCheck });
            assert.strictEqual(attempts.length, 1);
            assert.strictEqual(row.end_state, 'waiting');
            assert.match(row.outcome_note, /waiting: the model was unavailable/);
        });

        await check('the no-progress limit blocks the task instead of looping the same failure', async () => {
            const id = await startTask({ ...GOAL, no_progress_limit: 2, budget: { tokens: 1000000, turns: 10 } });
            next = [{ status: 'rejected', reason: 'same failure', check_output: 'exit 1\nsame output' }];
            const first = await endAttempt(id, { go: rejectedCheck });
            assert.strictEqual(first.attempts.length, 2, 'the first rejection continues');
            next = [{ status: 'rejected', reason: 'same failure', check_output: 'exit 1\nsame output' }];
            const second = await endAttempt(id, { go: rejectedCheck });
            assert.strictEqual(second.attempts.length, 2, 'the second identical rejection starts nothing');
            assert.strictEqual(second.row.end_state, 'blocked');
            assert.match(second.row.outcome_note, /blocked: the verifier rejected the completion 2 times without progress/);
        });

        await check('a task with no goal behaves exactly as before: done on the worker, no verifier', async () => {
            const before = asked.length;
            const id = await startTask(null);
            const { row, attempts } = await endAttempt(id);
            assert.strictEqual(asked.length, before, 'the verifier is never asked without a goal');
            assert.strictEqual(row.outcome, 'done');
            assert.strictEqual(row.end_state, null);
            assert.strictEqual(attempts.length, 1);
        });

        await check('a goal is refused while the switch is off', async () => {
            const other = await boot({ run, env: { CODES_GOALS_ENABLED: '0' } });
            try {
                const otherAda = other.network.addUser('ada');
                const otherActor = other.network.mintService('svc:actor', 'openvibe.codes', CAPS);
                const r = await fetch(`${other.base}/api/v1/tasks`, {
                    method: 'POST',
                    headers: { Accept: 'application/json', Authorization: `Bearer ${otherActor}`, 'X-OV-Subject': otherAda.subject, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ repo: 'https://github.com/octocat/Hello-World', prompt: 'x', goal: GOAL, idempotency_key: 'act_switch_off' }),
                });
                assert.strictEqual(r.status, 409);
                const body = await r.json();
                assert.strictEqual(body.code, 'codes.goals_disabled');
            } finally { await other.close(); }
        });
    } finally {
        await t.close();
    }
    done();
})();
