'use strict';
/**
 * The service API for coding tasks (server/http/tasks-api.js, Contracts 0.162 codes.task.*): a first-party service
 * holding the capability starts a task for a person named in X-OV-Subject, in the project of that person's latest
 * /run task, on a stand-in OpenVibe.Run; a repeated idempotency key answers the first task; the service reads and
 * cancels only the tasks it started for that person; what the person's machine returned is passed on only as the
 * contract allows. Tokens: none, an app's, a service's without the capability or for another audience are refused.
 */
const assert = require('assert');
const { validate } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const calls = [];
    let state = 'queued';
    let result = null;
    const run = {
        enabled: true,
        async submit(o) { calls.push(['submit', o]); return { id: 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J1', state: 'queued' }; },
        async read(jobId, who) { calls.push(['read', jobId, who]); return { id: jobId, state, result, error: null }; },
        async cancel(jobId, who) { calls.push(['cancel', jobId, who]); state = 'cancelled'; return { id: jobId, state }; },
        async streamUrl() { throw new Error('not used'); },
    };
    const t = await boot({ run });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    const bo = t.network.addUser('bo');
    const CAPS = ['codes.task.start', 'codes.task.read', 'codes.task.cancel'];
    const actor = t.network.mintService('svc:actor', 'openvibe.codes', CAPS);
    const call = async (method, path, { token = actor, subject = ada.subject, body } = {}) => {
        const headers = { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(subject ? { 'X-OV-Subject': subject } : {}) };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(`${t.base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    const ask = { repo: 'https://github.com/octocat/Hello-World', prompt: 'Add a line to the README.', agent: 'deepseek', idempotency_key: 'act_task_1:step-1' };

    // Ada ran a task on /run before (so Codes knows her project); Bo never did.
    const project = 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1';
    await db.exec(`INSERT INTO run_tasks (id, subject, project_id, job_id, repo, prompt, state, created_at, updated_at)
        VALUES ('tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T1', $1, $2, 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z200', 'https://github.com/a/b', 'by hand', 'succeeded', 1, 2)`, [ada.subject, project]);

    try {
        await check('no token, an app token, a service without the capability or for another audience, no person: refused', async () => {
            assert.strictEqual((await call('POST', '/tasks', { token: null, body: ask })).status, 401);
            assert.strictEqual((await call('POST', '/tasks', { token: t.network.mintService('app:app_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1', 'openvibe.codes', CAPS, { ns: ['prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P9'], project_id: 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P9', env: 'production' }), body: ask })).status, 403);
            const noCap = await call('POST', '/tasks', { token: t.network.mintService('svc:actor', 'openvibe.codes', ['codes.task.read']), body: ask });
            assert.strictEqual(noCap.status, 403, JSON.stringify(noCap.json));
            assert.strictEqual((await call('POST', '/tasks', { token: t.network.mintService('svc:actor', 'openvibe.run', CAPS), body: ask })).status, 401);
            assert.strictEqual((await call('POST', '/tasks', { subject: null, body: ask })).status, 422);
            assert.strictEqual(calls.filter((c) => c[0] === 'submit').length, 0);
        });

        await check('a bad body or an unknown agent is 422; a person who never ran a task on /run is 409 codes.no_project', async () => {
            assert.strictEqual((await call('POST', '/tasks', { body: { ...ask, repo: 'http://github.com/a/b' } })).status, 422);
            assert.strictEqual((await call('POST', '/tasks', { body: { ...ask, agent: 'nobody' } })).status, 422);
            const none = await call('POST', '/tasks', { subject: bo.subject, body: ask });
            assert.strictEqual(none.status, 409);
            assert.strictEqual(none.json.code, 'codes.no_project');
            assert.strictEqual(calls.filter((c) => c[0] === 'submit').length, 0);
        });

        let task;
        await check('the task starts as a Run job for the person in their project; the same key answers it again', async () => {
            const r = await call('POST', '/tasks', { body: ask });
            assert.strictEqual(r.status, 201, JSON.stringify(r.json));
            assert.ok(validate('codes.task-start-result@1', r.json).valid, JSON.stringify(validate('codes.task-start-result@1', r.json).errors));
            task = r.json.task;
            assert.strictEqual(task.state, 'queued');
            assert.strictEqual(task.url, `https://openvibe.codes/run/tasks/${task.id}`);
            const submit = calls.find((c) => c[0] === 'submit')[1];
            assert.strictEqual(submit.subject, ada.subject);
            assert.strictEqual(submit.project, project);
            assert.strictEqual(submit.args.agent, 'deepseek');
            assert.strictEqual(submit.key, task.id);
            const again = await call('POST', '/tasks', { body: ask });
            assert.strictEqual(again.status, 200);
            assert.strictEqual(again.json.created, false);
            assert.strictEqual(again.json.task.id, task.id);
            assert.strictEqual(calls.filter((c) => c[0] === 'submit').length, 1, 'one job');
        });

        await check('reading follows Run; the machine’s result is passed on only as codes.task@1 allows', async () => {
            state = 'succeeded';
            result = {
                protocol: 'openvibe-codes@1.0.0', ok: true, repo: 'https://github.com/octocat/Hello-World', base: 'master', agents: ['deepseek'],
                summary: 'x'.repeat(5000), files: [{ path: 'README', added: 1, removed: 0, extra: 'dropped' }, { nope: 1 }],
                patch: '+line\n', cost_usd: 0.0011, duration_ms: 4200, push: { pushed: false, reason: 'no token', smuggled: '<script>' },
                branch_url: 'javascript:alert(1)',
            };
            // A read is not a poll: age the row past the 10-minute fallback so this one checks Run.
            await db.exec('UPDATE run_tasks SET updated_at = updated_at - $2 WHERE id = $1', [task.id, 11 * 60_000]);
            const r = await call('GET', `/tasks/${task.id}`);
            assert.strictEqual(r.status, 200, JSON.stringify(r.json));
            // The read is the task (its own fields at the top level, as codes.task@1 had them), with its
            // attempts and its outcome added to it: codes.task@2 (stage C2).
            const v = validate('codes.task@2', r.json);
            assert.ok(v.valid, JSON.stringify(v.errors));
            const v1doc = { ...r.json };
            delete v1doc.attempts; delete v1doc.outcome;
            const v1 = validate('codes.task@1', v1doc);
            assert.ok(v1.valid, 'the task itself still answers codes.task@1');
            assert.strictEqual(r.json.state, 'succeeded');
            assert.strictEqual(r.json.id, task.id, 'the task at the top level, not wrapped');
            assert.strictEqual(r.json.result.summary.length, 4000);
            assert.deepStrictEqual(r.json.result.files, [{ path: 'README', added: 1, removed: 0 }]);
            assert.deepStrictEqual(r.json.result.push, { pushed: false, reason: 'no token' });
            assert.strictEqual(r.json.attempts.length, 1, 'one attempt: the task as it was asked');
            assert.strictEqual(r.json.attempts[0].n, 1);
            assert.strictEqual(r.json.attempts[0].state, 'done');
            assert.ok(r.json.attempts[0].why, 'the attempt says why it happened');
            assert.strictEqual(r.json.outcome.state, 'done');
        });

        await check('another person, another service, or a task the person started by hand: 404', async () => {
            assert.strictEqual((await call('GET', `/tasks/${task.id}`, { subject: bo.subject })).status, 404);
            const watch = t.network.mintService('svc:watch', 'openvibe.codes', CAPS);
            assert.strictEqual((await call('GET', `/tasks/${task.id}`, { token: watch })).status, 404);
            assert.strictEqual((await call('GET', '/tasks/tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T1')).status, 404);
            assert.strictEqual((await call('GET', '/tasks/nope')).status, 404);
        });

        await check('cancel reaches Run for a task not ended; an ended one is answered as it is', async () => {
            state = 'queued';
            result = null;
            const r2 = await call('POST', '/tasks', { body: { ...ask, idempotency_key: 'act_task_1:step-2' } });
            assert.strictEqual(r2.status, 201);
            const c = await call('POST', `/tasks/${r2.json.task.id}/cancel`);
            assert.strictEqual(c.status, 200, JSON.stringify(c.json));
            assert.strictEqual(c.json.state, 'cancelled');
            assert.ok(calls.some((x) => x[0] === 'cancel'));
            const before = calls.filter((x) => x[0] === 'cancel').length;
            const ended = await call('POST', `/tasks/${task.id}/cancel`);
            assert.strictEqual(ended.json.state, 'succeeded');
            assert.strictEqual(calls.filter((x) => x[0] === 'cancel').length, before);
        });

        // The person's own Network access token, as `openvibe-codes task` sends it: the same routes, as the owner.
        const asAda = async (method, path, body, token = t.network.userToken(ada)) => {
            const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            const res = await fetch(`${t.base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
            return { status: res.status, json: await res.json().catch(() => null) };
        };

        let own;
        await check('a person’s own token starts a read-only task (permission review), read at the harness level', async () => {
            state = 'queued';
            result = null;
            const r = await asAda('POST', '/tasks', { repo: 'https://github.com/octocat/Hello-World', prompt: 'Audit the auth flow.', permission: 'review', idempotency_key: 'cli:audit-1' });
            assert.strictEqual(r.status, 201, JSON.stringify(r.json));
            own = r.json.task;
            assert.strictEqual(own.state, 'queued');
            const submit = calls.filter((c) => c[0] === 'submit').pop()[1];
            assert.strictEqual(submit.subject, ada.subject, 'the person the token belongs to, with no X-OV-Subject');
            assert.strictEqual(submit.args.permission, 'read', 'review runs read-only');
            const again = await asAda('POST', '/tasks', { repo: 'https://github.com/octocat/Hello-World', prompt: 'Audit the auth flow.', permission: 'review', idempotency_key: 'cli:audit-1' });
            assert.strictEqual(again.status, 200);
            assert.strictEqual(again.json.created, false);
            assert.strictEqual(again.json.task.id, own.id);
        });

        await check('a token for the Codes audience is accepted as the same person', async () => {
            const r = await asAda('GET', '/tasks', undefined, t.network.userToken(ada, { audience: ['openvibe.codes'] }));
            assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        });

        await check('the person lists, reads, continues and stops their own tasks; another person’s token is 404', async () => {
            const list = await asAda('GET', '/tasks?state=running');
            assert.strictEqual(list.status, 200, JSON.stringify(list.json));
            assert.ok(list.json.tasks.some((x) => x.id === own.id), 'the new task is running');
            assert.ok(list.json.tasks.every((x) => ['queued', 'placed', 'running'].includes(x.state)));
            const all = await asAda('GET', '/tasks');
            assert.ok(all.json.tasks.some((x) => x.id === 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T1'), 'the one started by hand is the person’s too');
            const read = await asAda('GET', `/tasks/${own.id}`);
            assert.strictEqual(read.status, 200);
            assert.strictEqual(read.json.id, own.id);
            assert.ok(Array.isArray(read.json.attempts));
            const other = await asAda('GET', `/tasks/${own.id}`, undefined, t.network.userToken(bo));
            assert.strictEqual(other.status, 404, 'someone else’s task');
            // A continue starts the next attempt on a task that has ended; stop ends the running one for good.
            await db.exec("UPDATE run_tasks SET state = 'failed', outcome = 'unfinished' WHERE id = $1", [own.id]);
            const carried = await asAda('POST', `/tasks/${own.id}/continue`, { note: 'and the tests' });
            assert.strictEqual(carried.status, 200, JSON.stringify(carried.json));
            assert.ok(carried.json.attempts.length >= 2, 'the continue is the next attempt');
            const stopped = await asAda('POST', `/tasks/${own.id}/stop`);
            assert.strictEqual(stopped.status, 200, JSON.stringify(stopped.json));
            assert.strictEqual(stopped.json.outcome.state, 'stopped');
        });

        await check('list filters: needs is the task the engine left unfinished, done is the rest', async () => {
            await db.exec("UPDATE run_tasks SET outcome = 'unfinished' WHERE id = $1", ['tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T1']);
            const needs = await asAda('GET', '/tasks?state=needs');
            assert.ok(needs.json.tasks.some((x) => x.id === 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T1'));
            assert.ok(needs.json.tasks.every((x) => x.outcome.state === 'unfinished'));
            const done = await asAda('GET', '/tasks?state=done');
            assert.ok(done.json.tasks.every((x) => x.outcome.state !== 'unfinished' && !['queued', 'placed', 'running'].includes(x.state)));
            assert.strictEqual((await asAda('GET', '/tasks?state=later')).status, 422);
        });

        await check('the person’s own /run page lists the task a service started for them', async () => {
            const page = await t.get('/run', { as: ada });
            assert.ok(page.text.includes(`/run/tasks/${task.id}`));
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
