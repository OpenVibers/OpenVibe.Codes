'use strict';
/**
 * Actor back-reference (CODES-5): when OpenVibe.Actor starts a coding task through codes.task.start it can pass its
 * own task and step ids. The contract does not carry them yet, so they are stripped before validation, stored in
 * run_tasks.actor_ref, and kept out of codes.task@1 until the contract is amended.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const run = {
        enabled: true,
        async submit(o) { return { id: 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J1', state: 'queued' }; },
        async read() { return { state: 'queued' }; },
        async cancel() { return { state: 'cancelled' }; },
        async streamUrl() { throw new Error('not used'); },
    };
    const t = await boot({ run });
    const ada = t.network.addUser('ada');
    const actor = t.network.mintService('svc:actor', 'openvibe.codes', ['codes.task.start', 'codes.task.read', 'codes.task.cancel']);

    await t.ctx.store.db.exec(`INSERT INTO run_tasks (id, subject, project_id, job_id, repo, prompt, state, created_at, updated_at)
        VALUES ('tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T1', $1, $2, 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z200', 'https://github.com/a/b', 'by hand', 'succeeded', 1, 2)`, [ada.subject, 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1']);

    try {
        await check('actor_task_id and actor_step_id are accepted, stored, and not returned in codes.task@1', async () => {
            const res = await fetch(`${t.base}/api/v1/tasks`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${actor}`, 'X-OV-Subject': ada.subject, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    repo: 'https://github.com/OpenVibers/OpenVibe.Codes',
                    prompt: 'x',
                    actor_task_id: 'act_123',
                    actor_step_id: 'step_456',
                }),
            });
            assert.strictEqual(res.status, 201);
            const json = await res.json();
            assert.ok(!('actor_task_id' in json.task), 'actor_task_id is not in the public task');
            assert.ok(!('actor_step_id' in json.task));
            const row = await t.ctx.store.db.one('SELECT actor_ref FROM run_tasks WHERE id = $1', [json.task.id]);
            assert.deepStrictEqual(row.actor_ref, { task_id: 'act_123', step_id: 'step_456' });
        });

        await check('a body with only the contract fields still validates', async () => {
            const res = await fetch(`${t.base}/api/v1/tasks`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${actor}`, 'X-OV-Subject': ada.subject, 'Content-Type': 'application/json', 'Idempotency-Key': 'actor-fields-2' },
                body: JSON.stringify({ repo: 'https://github.com/OpenVibers/OpenVibe.Codes', prompt: 'y' }),
            });
            assert.strictEqual(res.status, 201);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
