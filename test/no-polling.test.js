'use strict';
/**
 * No page-view polling (plan 2026-10-28 §6, decision 2): a task page view does not call Run while the task got its
 * run.job.* events; Run is read once only as the fallback after ten minutes without an event.
 */
const assert = require('assert');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { parseArgs } = require('../harness/job');
const { boot, check, done } = require('./helpers/boot');

const SECRET = `fixture_${'no-polling'.repeat(4)}`;
const NOW = Date.now();

function event(id, type, jobId, subject, project, state, timings = {}) {
    return {
        event_id: id, event_type: type, version: 1, source: 'run', subject: { type: 'job', id: jobId }, visibility: 'internal',
        payload: {
            job_id: jobId, project_id: project, requester: { type: 'user', id: subject }, state,
            timings: { created_at: new Date(NOW).toISOString(), placed_at: new Date(NOW).toISOString(), started_at: new Date(NOW).toISOString(), finished_at: timings.finished_at || null },
            error: null,
        },
    };
}

(async () => {
    const reads = [];
    let nextJob = 1;
    const states = new Map();
    const run = {
        enabled: true,
        async submit() { const id = `job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J${nextJob++}`; states.set(id, { state: 'queued', result: null }); return { id, state: 'queued' }; },
        async read(jobId) {
            reads.push(jobId);
            const s = states.get(jobId) || { state: 'running', result: null };
            return { id: jobId, state: s.state, result: s.result, error: null, timings: { started_at: new Date(NOW).toISOString(), finished_at: s.state === 'succeeded' ? new Date().toISOString() : null } };
        },
        async cancel() { return { state: 'cancelled' }; },
        async streamUrl() { throw new Error('not used'); },
    };
    const t = await boot({ run, env: { CODES_EVENTS_SECRET: SECRET } });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    const project = 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1';
    const args = parseArgs(JSON.stringify({ repo: 'https://github.com/Octocat/Hello-World', prompt: 'Fix the typo', permission: 'edit' }));
    const deliver = async (e) => {
        const body = JSON.stringify({ event: e, seq: 1 });
        return await t.get('/internal/events', { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, SECRET) } });
    };

    try {
        await check('events finalize a task; its page view then reads nothing from Run', async () => {
            const task = await t.ctx.tasks.start({ subject: ada.subject, project, args });
            const jobId = task.job_id;
            states.set(jobId, { state: 'succeeded', result: { ok: true, summary: 'Fixed', log: [{ t: 'done', ok: true, text: 'Fixed' }] } });
            assert.strictEqual((await deliver(event('evt_01M61F7R3WXM5T5ET9CRGNHEP5', 'run.job.started', jobId, ada.subject, project, 'running'))).status, 200);
            assert.strictEqual((await deliver(event('evt_01M61F7R3WXM5T5ET9CRGNHEP6', 'run.job.succeeded', jobId, ada.subject, project, 'succeeded', { finished_at: new Date().toISOString() }))).status, 200);
            assert.strictEqual(await db.value('SELECT state FROM run_tasks WHERE id = $1', [task.id]), 'succeeded');
            reads.length = 0;
            const page = await t.get(`/run/tasks/${task.id}`, { as: ada });
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('Finished') && page.text.includes('Fixed'), page.text.slice(-500));
            assert.strictEqual(reads.length, 0, 'the page did not call Run');
        });

        await check('a running task is not polled on page views before ten quiet minutes, then read once', async () => {
            const task = await t.ctx.tasks.start({ subject: ada.subject, project, args });
            states.set(task.job_id, { state: 'running', result: null });
            assert.strictEqual((await deliver(event('evt_01M61F7R3WXM5T5ET9CRGNHEP7', 'run.job.started', task.job_id, ada.subject, project, 'running'))).status, 200);
            reads.length = 0;
            const first = await t.get(`/run/tasks/${task.id}`, { as: ada });
            assert.strictEqual(first.status, 200);
            assert.ok(first.text.includes('data-events'));
            assert.strictEqual(reads.length, 0, 'no page-view poll');
            await db.exec('UPDATE run_tasks SET updated_at = updated_at - $2 WHERE id = $1', [task.id, 11 * 60_000]);
            const fallback = await t.get(`/run/tasks/${task.id}`, { as: ada });
            assert.strictEqual(fallback.status, 200);
            assert.strictEqual(reads.length, 1, 'one fallback read after ten quiet minutes');
            assert.deepStrictEqual(reads, [task.job_id]);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
