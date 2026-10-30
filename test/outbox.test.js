'use strict';
/**
 * codes.task.* events out (plan 2026-10-28 §6, decision 3): every state change writes one codes_outbox row in the
 * same transaction, the publisher sends each under the evt_ id fixed at insert, a failure records the attempt and
 * backs off, a retry and a new publisher over the same rows never make a second event.
 */
const assert = require('assert');
const http = require('http');
const { validate } = require('openvibe-contracts');
const { parseArgs } = require('../harness/job');
const { boot, check, done } = require('./helpers/boot');
const { createPublisher } = require('../server/events/outbox');

(async () => {
    const received = [];
    let failNext = 0;
    let refuseNext = 0;
    const events = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            if (failNext > 0) { failNext--; res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"code":"events.down"}'); }
            // Events refuses an envelope it does not accept (a 422 that no retry can fix).
            if (refuseNext > 0) {
                refuseNext--;
                res.writeHead(422, { 'Content-Type': 'application/json' });
                return res.end('{"code":"events.invalid_envelope","detail":"/priority must be equal to one of the allowed values"}');
            }
            const event = JSON.parse(body);
            received.push(event);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ event_id: event.event_id, cursor: `c${received.length}` }));
        });
    });
    await new Promise((ok) => events.listen(0, '127.0.0.1', ok));

    let readState = 'queued';
    let readResult = null;
    const run = {
        enabled: true,
        async submit() { return { id: 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J1', state: 'queued' }; },
        async read(jobId) {
            return { id: jobId, state: readState, result: readResult, error: null, timings: { started_at: new Date(Date.now() - 1000).toISOString(), finished_at: readState === 'succeeded' ? new Date().toISOString() : null } };
        },
        async cancel() { return { state: 'cancelled' }; },
        async streamUrl() { throw new Error('not used'); },
    };
    const t = await boot({ run, env: { EVENTS_URL: `http://127.0.0.1:${events.address().port}` } });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    const project = 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1';
    const args = parseArgs(JSON.stringify({ repo: 'https://github.com/Octocat/Hello-World', prompt: 'Fix the typo', permission: 'edit' }));

    try {
        const task = await t.ctx.tasks.start({ subject: ada.subject, project, args });

        await check('a task start writes its queued row in the change transaction, with the fixed evt_ id', async () => {
            const rows = await db.many('SELECT * FROM codes_outbox WHERE payload->>\'task_id\' = $1', [task.id]);
            assert.strictEqual(rows.length, 1);
            const row = rows[0];
            assert.match(row.event_id, /^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
            assert.strictEqual(row.topic, 'codes.task.queued');
            assert.strictEqual(row.subject, ada.subject);
            assert.deepStrictEqual(Object.keys(row.payload).sort(), ['agent', 'cost_usd', 'error', 'files_changed', 'finished_at', 'repo', 'started_at', 'state', 'task_id']);
            assert.strictEqual(row.payload.repo, 'Octocat/Hello-World');
            assert.strictEqual(row.payload.state, 'queued');
            const before = await db.value('SELECT COUNT(*)::int FROM codes_outbox');
            await assert.rejects(t.ctx.store.tx(async () => {
                await t.ctx.outbox.emitTask({ ...task, state: 'succeeded', result: { ok: true } }, 'running');
                throw new Error('roll back the change');
            }), /roll back/);
            assert.strictEqual(await db.value('SELECT COUNT(*)::int FROM codes_outbox'), before, 'the event is not written without the change');
        });

        await check('a Run state change writes one row in the same transaction', async () => {
            readState = 'succeeded';
            readResult = { ok: true, cost_usd: 0.02, files: [{ path: 'README', added: 1, removed: 1 }], log: [{ t: 'done', ok: true }] };
            const row = await db.one('SELECT * FROM run_tasks WHERE id = $1', [task.id]);
            const done_ = await t.ctx.tasks.refresh(row, { force: true });
            assert.strictEqual(done_.state, 'succeeded');
            const rows = await db.many('SELECT topic, payload FROM codes_outbox WHERE payload->>\'task_id\' = $1 ORDER BY created_at, event_id', [task.id]);
            assert.deepStrictEqual(rows.map((x) => x.topic), ['codes.task.queued', 'codes.task.succeeded']);
            assert.strictEqual(rows[1].payload.state, 'succeeded');
            assert.strictEqual(rows[1].payload.cost_usd, 0.02);
            assert.strictEqual(rows[1].payload.files_changed, 1);
        });

        await check('publishing sends each row once, with the fixed id and the proposal envelope', async () => {
            const rows = await db.many('SELECT * FROM codes_outbox ORDER BY created_at, event_id');
            assert.strictEqual(await t.ctx.publisher.pending(), rows.length);
            const r = await t.ctx.publisher.runOnce();
            assert.deepStrictEqual(r, { configured: true, claimed: rows.length, published: rows.length, failed: 0 });
            assert.strictEqual(received.length, rows.length);
            for (const row of rows) {
                const event = received.find((x) => x.event_id === row.event_id);
                assert.ok(event, `published ${row.event_id}`);
                assert.strictEqual(event.event_type, row.topic);
                assert.strictEqual(event.source, 'codes');
                assert.deepStrictEqual(event.subject, { type: 'user', id: ada.subject });
                assert.strictEqual(event.visibility, 'internal');
                assert.deepStrictEqual(event.payload, row.payload);
            }
            assert.strictEqual((await t.ctx.publisher.runOnce()).claimed, 0);
            assert.strictEqual(received.length, rows.length, 'nothing sent twice');
            assert.strictEqual(await t.ctx.publisher.pending(), 0);
        });

        await check('the envelope is the one the contract describes, so OpenVibe.Events accepts it', async () => {
            assert.ok(received.length >= 2, 'events were published');
            for (const event of received) {
                const v = validate('events.event-envelope@1', event);
                assert.ok(v.valid, `the envelope matches events.event-envelope@1: ${JSON.stringify(v.errors)}`);
            }
        });

        await check('a failure records attempts/last_error, backs off, then retries the same id', async () => {
            const second = await t.ctx.tasks.start({ subject: ada.subject, project, args });
            const row = await db.one('SELECT * FROM codes_outbox WHERE payload->>\'task_id\' = $1', [second.id]);
            failNext = 1;
            const failed = await t.ctx.publisher.runOnce();
            assert.strictEqual(failed.failed, 1);
            let after = await db.one('SELECT * FROM codes_outbox WHERE event_id = $1', [row.event_id]);
            assert.strictEqual(after.attempts, 1);
            assert.match(after.last_error, /events 503/);
            assert.strictEqual(after.published_at, null);
            assert.ok(new Date(after.next_attempt_at).getTime() > Date.now(), 'backed off into the future');
            assert.strictEqual((await t.ctx.publisher.runOnce()).claimed, 0, 'not due yet');
            await db.exec("UPDATE codes_outbox SET next_attempt_at = now() - interval '1 second' WHERE event_id = $1", [row.event_id]);
            const retried = await t.ctx.publisher.runOnce();
            assert.deepStrictEqual(retried, { configured: true, claimed: 1, published: 1, failed: 0 });
            after = await db.one('SELECT * FROM codes_outbox WHERE event_id = $1', [row.event_id]);
            assert.ok(after.published_at);
            assert.strictEqual(after.attempts, 1, 'the failed attempt stays recorded');
            assert.strictEqual(received.filter((x) => x.event_id === row.event_id).length, 1, 'one event under the fixed id');
        });

        await check('an event OpenVibe.Events refuses is dead after a fixed number of tries, not retried forever', async () => {
            const third = await t.ctx.tasks.start({ subject: ada.subject, project, args });
            const row = await db.one('SELECT * FROM codes_outbox WHERE payload->>\'task_id\' = $1', [third.id]);
            refuseNext = 3;
            for (let tries = 0; tries < 3; tries++) {
                await db.exec("UPDATE codes_outbox SET next_attempt_at = now() - interval '1 second' WHERE event_id = $1", [row.event_id]);
                const r = await t.ctx.publisher.runOnce();
                assert.strictEqual(r.claimed, 1, 'the row is claimed');
                assert.strictEqual(r.failed, 1, 'the refusal is a failure');
            }
            const dead = await db.one('SELECT * FROM codes_outbox WHERE event_id = $1', [row.event_id]);
            assert.ok(dead.dead_at, 'the event is dead');
            assert.strictEqual(dead.dead_reason, 'refused');
            assert.strictEqual(dead.published_at, null);
            assert.strictEqual(dead.attempts, 3, 'it got the tries it was given');
            assert.match(dead.last_error, /events 422/);
            assert.strictEqual(await t.ctx.publisher.pending(), 0, 'a dead event is not pending');
            assert.strictEqual(await t.ctx.publisher.dead(), 1);
            await db.exec("UPDATE codes_outbox SET next_attempt_at = now() - interval '1 second' WHERE event_id = $1", [row.event_id]);
            assert.strictEqual((await t.ctx.publisher.runOnce()).claimed, 0, 'a dead event is never sent again');
            refuseNext = 0;
        });

        await check('a restart over the same rows does not duplicate', async () => {
            const before = received.length;
            const restarted = createPublisher({ config: t.config, store: t.ctx.store, fetchImpl: globalThis.fetch, log: { warn() {}, log() {}, error() {} } });
            assert.strictEqual((await restarted.runOnce()).claimed, 0);
            assert.strictEqual(received.length, before);
            assert.strictEqual(await t.ctx.publisher.pending(), 0);
        });
    } finally {
        await t.close();
        events.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
