'use strict';
/**
 * run.job.* → Codes (plan 2026-10-28 §6, decision 2): a signed delivery for a job that is a Codes task finalizes the
 * run_tasks row once (state, timings, result read once from Run), in the same transaction as the inbox claim; a replay
 * changes nothing; a bad signature is refused; a job that is not a Codes task is ignored.
 */
const assert = require('assert');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { parseArgs } = require('../harness/job');
const { boot, check, done } = require('./helpers/boot');

const SECRET = `fixture_${'consumer'.repeat(6)}`;
const JOB_A = 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J1';
const JOB_B = 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J2';

function eventOf(id, type, jobId, subject, project, state, timings = {}) {
    return {
        event_id: id, event_type: type, version: 1, source: 'run',
        subject: { type: 'job', id: jobId }, visibility: 'internal',
        payload: {
            job_id: jobId, project_id: project, requester: { type: 'user', id: subject }, state,
            timings: {
                created_at: new Date(Date.now() - 5000).toISOString(), placed_at: new Date(Date.now() - 4000).toISOString(),
                started_at: timings.started_at || new Date(Date.now() - 3000).toISOString(),
                finished_at: timings.finished_at || null,
            },
            error: null,
        },
    };
}

(async () => {
    const reads = [];
    let readState = 'succeeded';
    let readResult = null;
    const run = {
        enabled: true,
        async submit() { return { id: JOB_A, state: 'queued' }; },
        async read(jobId) {
            reads.push(jobId);
            return {
                id: jobId, state: readState, result: readResult, error: null,
                timings: { started_at: new Date(Date.now() - 3000).toISOString(), finished_at: new Date().toISOString() },
            };
        },
        async cancel() { return { state: 'cancelled' }; },
        async streamUrl() { throw new Error('not used'); },
    };
    const t = await boot({ run, env: { CODES_EVENTS_SECRET: SECRET } });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    const project = 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1';
    const args = parseArgs(JSON.stringify({ repo: 'https://github.com/Octocat/Hello-World', prompt: 'Fix the typo', permission: 'edit' }));
    const post = (body) => t.get('/internal/events', { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, SECRET) } });
    const deliver = (event) => post(JSON.stringify({ event, seq: 1 }));

    try {
        const task = await t.ctx.tasks.start({ subject: ada.subject, project, args });
        readResult = { ok: true, summary: 'Fixed', cost_usd: 0.02, files: [{ path: 'README', added: 1, removed: 1 }], log: [{ t: 'text', text: 'done' }, { t: 'done', ok: true, text: 'Fixed' }] };

        await check('a signed run.job.started moves the task to running without reading Run', async () => {
            const started = eventOf('evt_01M61F7R3WXM5T5ET9CRGNHEP1', 'run.job.started', JOB_A, ada.subject, project, 'running');
            const r = await deliver(started);
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().outcome, 'running');
            assert.strictEqual(r.json().task_id, task.id);
            const row = await db.one('SELECT state, started_at FROM run_tasks WHERE id = $1', [task.id]);
            assert.strictEqual(row.state, 'running');
            assert.ok(row.started_at);
            assert.strictEqual(reads.length, 0, 'no result is read for a non-terminal event');
            assert.strictEqual(await db.value("SELECT COUNT(*)::int FROM codes_outbox WHERE topic = 'codes.task.running'"), 1);
        });

        await check('a signed run.job.succeeded finalizes the task once, with its result and one codes.task.succeeded row', async () => {
            const succeeded = eventOf('evt_01M61F7R3WXM5T5ET9CRGNHEP2', 'run.job.succeeded', JOB_A, ada.subject, project, 'succeeded',
                { finished_at: new Date().toISOString() });
            const r = await deliver(succeeded);
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().outcome, 'succeeded');
            assert.strictEqual(reads.length, 1, 'the result was read once');
            const row = await db.one('SELECT state, result, finished_at, session_complete_at FROM run_tasks WHERE id = $1', [task.id]);
            assert.strictEqual(row.state, 'succeeded');
            assert.strictEqual(row.result.summary, 'Fixed');
            assert.ok(row.finished_at);
            assert.ok(row.session_complete_at);
            const line = await db.maybe("SELECT * FROM codes_session_lines WHERE task_id = $1 AND kind = 'done'", [task.id]);
            assert.ok(line, 'the result log was back-filled');
            const outbox = await db.many('SELECT topic, payload FROM codes_outbox WHERE payload->>\'task_id\' = $1 ORDER BY created_at', [task.id]);
            assert.deepStrictEqual(outbox.map((x) => x.topic), ['codes.task.queued', 'codes.task.running', 'codes.task.succeeded']);
            const payload = outbox[2].payload;
            assert.strictEqual(payload.task_id, task.id);
            assert.strictEqual(payload.state, 'succeeded');
            assert.strictEqual(payload.repo, 'Octocat/Hello-World');
            assert.strictEqual(payload.cost_usd, 0.02);
            assert.strictEqual(payload.files_changed, 1);
            assert.ok(payload.started_at && payload.finished_at);
            assert.strictEqual(payload.error, null);
        });

        await check('a replayed delivery changes nothing', async () => {
            const before = await db.one('SELECT state, updated_at FROM run_tasks WHERE id = $1', [task.id]);
            const count = await db.value('SELECT COUNT(*)::int FROM codes_outbox');
            const succeeded = eventOf('evt_01M61F7R3WXM5T5ET9CRGNHEP2', 'run.job.succeeded', JOB_A, ada.subject, project, 'succeeded',
                { finished_at: new Date().toISOString() });
            const r = await deliver(succeeded);
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().duplicate, true);
            const after = await db.one('SELECT state, updated_at FROM run_tasks WHERE id = $1', [task.id]);
            assert.strictEqual(after.state, before.state);
            assert.strictEqual(Number(after.updated_at), Number(before.updated_at));
            assert.strictEqual(await db.value('SELECT COUNT(*)::int FROM codes_outbox'), count);
            assert.strictEqual(await db.value('SELECT COUNT(*)::int FROM codes_events_inbox WHERE event_id = $1', ['evt_01M61F7R3WXM5T5ET9CRGNHEP2']), 1);
            assert.strictEqual(reads.length, 1, 'a replay does not read Run again');
        });

        await check('a bad signature is refused; a job that is not a Codes task is ignored', async () => {
            const body = JSON.stringify({ event: eventOf('evt_01M61F7R3WXM5T5ET9CRGNHEP3', 'run.job.failed', JOB_A, ada.subject, project, 'failed'), seq: 1 });
            const bad = await t.get('/internal/events', { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, 'wrong'.repeat(8)) } });
            assert.strictEqual(bad.status, 401);
            const other = eventOf('evt_01M61F7R3WXM5T5ET9CRGNHEP4', 'run.job.succeeded', JOB_B, ada.subject, project, 'succeeded');
            const r = await deliver(other);
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().outcome, 'ignored:not_a_codes_task');
            assert.strictEqual(await db.value('SELECT COUNT(*)::int FROM codes_events_inbox WHERE event_id = $1', [other.event_id]), 1);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
