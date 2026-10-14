'use strict';
/**
 * ADR-033: Codes' part of an account export and of an account deletion, through the signed loopback route
 * POST /internal/events with a stand-in Network. Ada and Bo each started a coding task on their own machine
 * (run_tasks, plan T16). Ada's export carries her task whole; her deletion erases it, leaves Bo's, and confirms once;
 * an unsigned delivery is refused.
 */
const assert = require('assert');
const http = require('http');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { ids } = require('openvibe-contracts');
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
    const task = (subject, prompt) => db.exec(`INSERT INTO run_tasks (id, subject, project_id, job_id, repo, prompt, state, result, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'https://github.com/a/b', $5, 'succeeded', '{"ok":true}'::jsonb, 1, 2)`, [ids.newId('task').replace(/^[a-z]+_/, 'tsk_'), subject, ids.newId('project'), `job_${ids.ulid()}`, prompt]);
    await task(ada, 'Ada’s task');
    await task(bo, 'Bo’s task');
    const deliver = async (event, { secret = SECRET } = {}) => {
        const body = JSON.stringify({ event, seq: 1 });
        const res = await fetch(`${t.base}/internal/events`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...(secret ? signDeliveryHeaders(body, secret) : {}) } });
        return { status: res.status };
    };
    const ev = (id, type, payload) => ({ event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), payload });

    try {
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
        });
    } finally {
        await t.close();
        await stub.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
