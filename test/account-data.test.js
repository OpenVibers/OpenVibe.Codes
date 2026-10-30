'use strict';
/**
 * ADR-033: Codes' part of an account export and of an account deletion, through the signed loopback route
 * POST /internal/events with a stand-in Network. Ada and Bo each started a coding task on their own machine
 * (run_tasks, plan T16). Ada's export carries her task whole; her deletion erases it, leaves Bo's, and confirms once;
 * an unsigned delivery is refused.
 */
const assert = require('assert');
const http = require('http');
const { createNetworkSender, uncovered } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { ids } = require('openvibe-contracts');
const { TABLES, TASK_KEYED } = require('../server/account-data');
const { boot, check, done } = require('./helpers/boot');

const SECRET = `whsec_${'fixture'.repeat(6)}`;

async function startNetworkStub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_codes', token_type: 'Bearer', expires_in: 300 });
            calls.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
            return json(201, {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

(async () => {
    const stub = await startNetworkStub();
    const t = await boot({ env: { CODES_EVENTS_SECRET: SECRET }, accountSend: createNetworkSender({ networkInternalUrl: stub.url, clientId: 'codes', clientSecret: 'shh' }) });
    const db = t.ctx.store.db;
    const ada = ids.newId('user');
    const bo = ids.newId('user');
    const task = async (subject, prompt) => {
        const id = ids.newId('task').replace(/^[a-z]+_/, 'tsk_');
        await db.exec(`INSERT INTO run_tasks (id, subject, project_id, job_id, repo, prompt, state, result, created_at, updated_at)
            VALUES ($1, $2, $3, $4, 'https://github.com/a/b', $5, 'succeeded', '{"ok":true}'::jsonb, 1, 2)`, [id, subject, ids.newId('project'), `job_${ids.ulid()}`, prompt]);
        return id;
    };
    const adaTask = await task(ada, 'Ada’s task');
    const boTask = await task(bo, 'Bo’s task');
    // Everything later stages keep about a person or their tasks (C2 attempts, C3 run tokens, C8 proof, C4b settings,
    // the outbox, telemetry): each must leave with the person, and only theirs.
    for (const [subject, taskId] of [[ada, adaTask], [bo, boTask]]) {
        await db.exec("INSERT INTO codes_attempts (id, task_id, n, state, agent) VALUES ($1, $2, 1, 'done', 'codex')", [`att_${ids.ulid()}`, taskId]);
        await db.exec("INSERT INTO codes_task_proof (id, task_id, attempt_n, n, kind, label, ok) VALUES ($1, $2, 1, 1, 'tests', 'tests', true)", [`prf_${ids.ulid()}`, taskId]);
        await db.exec("INSERT INTO codes_run_tokens (id, task_id, subject, provider, jti, expires_at) VALUES ($1, $2, $3, 'openai', $4, now())", [`rtk_${ids.ulid()}`, taskId, subject, `jti_${ids.ulid()}`]);
        await db.exec("INSERT INTO codes_user_settings (subject, default_agent) VALUES ($1, 'codex')", [subject]);
        await db.exec("INSERT INTO codes_outbox (event_id, topic, subject, payload) VALUES ($1, 'codes.task.updated', $2, '{}'::jsonb)", [`evt_${ids.ulid()}`, subject]);
        await db.exec("INSERT INTO telemetry_samples (at, service, operation, subject) VALUES (now(), 'codes', 'task.start', $1)", [subject]);
        await db.exec("INSERT INTO codes_events_inbox (event_id, event_type, task_id) VALUES ($1, 'run.job.finished', $2)", [`evt_${ids.ulid()}`, taskId]);
        await db.exec("INSERT INTO codes_notices (task_id, kind) VALUES ($1, 'done')", [taskId]);
        await db.exec(`INSERT INTO codes_machine_fleet (subject, machine, name, agent, installed, signed_in, windows, online, reported_at)
            VALUES ($1, 'dev_laptop', 'laptop', 'codex', true, true, '[]'::jsonb, true, now())`, [subject]);
    }
    const deliver = async (event, { secret = SECRET } = {}) => {
        const body = JSON.stringify({ event, seq: 1 });
        const res = await fetch(`${t.base}/internal/events`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...(secret ? signDeliveryHeaders(body, secret) : {}) } });
        return { status: res.status };
    };
    const ev = (id, type, payload) => ({ event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), payload });

    try {
        await check('every table that names a person is covered, task-keyed or exempted with a reason', async () => {
            const missing = await uncovered(db, {
                tables: TABLES,
                taskKeyed: TASK_KEYED.map((k) => k.table),
                exempt: {
                    account_data_events: 'the ledger of requests itself: which export and deletion Codes applied',
                    event_outbox: 'no person column (the SDK outbox keeps envelopes); dropped with the console in 0002 anyway',
                },
            });
            assert.deepStrictEqual(missing, [], `a table with a person column is neither covered nor exempted: ${missing.join(', ')}`);
        });

        await check('an unsigned delivery is refused', async () => {
            const r = await deliver(ev(`evt_${ids.ulid()}`, 'network.account.deleted', { deletion_id: `del_${ids.ulid()}`, subject: ada, aliases: [] }), { secret: null });
            assert.strictEqual(r.status, 401);
            assert.strictEqual(Number(await db.value('SELECT count(*) FROM run_tasks')), 2);
        });

        await check('the export carries the person’s tasks whole', async () => {
            const exportId = `exp_${ids.ulid()}`;
            const r = await deliver(ev(`evt_${ids.ulid()}`, 'network.account.export_requested', { export_id: exportId, subject: ada }));
            assert.ok(r.status < 300, String(r.status));
            const part = stub.calls.find((c) => c.url === `/internal/account-exports/${exportId}/parts`);
            assert.ok(part, JSON.stringify(stub.calls));
            const file = part.body.files.find((f) => f.name === 'run-tasks.json');
            assert.strictEqual(file.content.length, 1);
            assert.strictEqual(file.content[0].prompt, 'Ada’s task');
            assert.deepStrictEqual(file.content[0].result, { ok: true });
            for (const name of ['attempts.json', 'proof.json', 'settings.json', 'run-tokens.json']) {
                const f = part.body.files.find((x) => x.name === name);
                assert.ok(f, `${name} is in the export`);
                assert.strictEqual(f.content.length, 1, `${name} holds Ada’s row only`);
            }
            const tok = part.body.files.find((x) => x.name === 'run-tokens.json').content[0];
            assert.ok(!('jti' in tok), 'a run token’s jti stays out of the export');
            const telemetry = part.body.files.find((x) => x.name === 'telemetry.json');
            assert.ok(telemetry, 'telemetry.json is in the export (the SDK covers the table)');
            assert.strictEqual(telemetry.content.length, 1, 'Ada’s sample only');
            assert.deepStrictEqual(Object.keys(telemetry.content[0]).sort(), ['at', 'latency_ms', 'operation', 'resource', 'service', 'status']);
            const fleet = part.body.files.find((x) => x.name === 'fleet.json');
            assert.ok(fleet, 'fleet.json is in the export');
            assert.strictEqual(fleet.content.length, 1, 'Ada’s fleet only');
            assert.strictEqual(fleet.content[0].agent, 'codex');
        });

        await check('a deletion erases them, keeps everyone else’s, and confirms once', async () => {
            const deletionId = `del_${ids.ulid()}`;
            const event = ev(`evt_${ids.ulid()}`, 'network.account.deleted', { deletion_id: deletionId, subject: ada, aliases: [] });
            assert.ok((await deliver(event)).status < 300);
            assert.ok((await deliver(event)).status < 300, 'a redelivery changes nothing');
            const rows = await db.many('SELECT subject FROM run_tasks');
            assert.deepStrictEqual(rows.map((r) => r.subject), [bo]);
            const confirmations = stub.calls.filter((c) => c.url === `/internal/account-deletions/${deletionId}/confirmations`);
            assert.strictEqual(confirmations.length, 1);
            assert.strictEqual(confirmations[0].body.erased.run_tasks, 1);
            for (const [table, key, who] of [
                ['codes_attempts', 'task_id', [boTask]], ['codes_task_proof', 'task_id', [boTask]], ['codes_events_inbox', 'task_id', [boTask]],
                ['codes_notices', 'task_id', [boTask]], ['codes_machine_fleet', 'subject', [bo]],
                ['codes_run_tokens', 'subject', [bo]], ['codes_user_settings', 'subject', [bo]], ['codes_outbox', 'subject', [bo]],
            ]) {
                const left = (await db.many(`SELECT ${key} FROM ${table}`)).map((r) => r[key]);
                assert.deepStrictEqual(left, who, `${table}: only Bo’s row is left`);
            }
            const samples = await db.many('SELECT subject FROM telemetry_samples ORDER BY subject NULLS FIRST');
            assert.deepStrictEqual(samples.map((r) => r.subject), [null, bo], 'Ada’s telemetry sample stays, without her');
        });
    } finally {
        await t.close();
        await stub.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
