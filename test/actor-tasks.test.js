'use strict';
/**
 * Desktop and browser work handed from Codes to the person's Actor (plan §AD.22). A conductor's codes_actor_task (or
 * the person) starts an Actor task through POST /api/v1/me/actor/tasks; Codes calls Actor with its own service token
 * for openvibe.actor, naming the person in X-OV-Subject, and reads the task back the same way. The answer is a summary
 * a conductor can use: state, what Actor found, any error, the cost and the page.
 */
const assert = require('assert');
const http = require('http');
const { check, done, boot } = require('./helpers/boot');

function claimsOf(header) {
    const raw = String(header || '').replace(/^Bearer\s+/i, '');
    try { return JSON.parse(Buffer.from(raw.split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}

const ID = 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2A7';

function fakeActor() {
    const st = { calls: [], tasks: new Map() };
    const srv = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const u = new URL(req.url, 'http://x');
            const send = (status, doc) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(doc)); };
            const subject = String(req.headers['x-ov-subject'] || '');
            st.calls.push({ method: req.method, path: u.pathname, subject, body: raw ? JSON.parse(raw) : null, claims: claimsOf(req.headers.authorization) });
            if (req.method === 'POST' && u.pathname === '/api/v1/tasks') {
                const t = { id: ID, task: JSON.parse(raw).task, mode: JSON.parse(raw).mode, state: 'queued', requester: subject, result: null, cost: null };
                st.tasks.set(ID, t);
                return send(201, t);
            }
            const m = /^\/api\/v1\/tasks\/([^/]+)$/.exec(u.pathname);
            if (req.method === 'GET' && m) {
                const t = st.tasks.get(m[1]);
                if (!t || t.requester !== subject) return send(404, { code: 'actor.task.not_found' });
                return send(200, { ...t, state: 'succeeded', result: { answer: 'The page shows the new Go live button.' }, cost: { usd: 0.0123 }, finished_at: '2026-11-17T19:00:00Z' });
            }
            send(404, { code: 'route.not_found' });
        });
    });
    return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ st, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) })));
}

(async () => {
    const actor = await fakeActor();
    const t = await boot({ env: { CODES_ACTOR_INTERNAL_URL: actor.url } });
    const ada = t.network.addUser('ada-actor');
    const bo = t.network.addUser('bo-actor');
    const call = (method, path, { as = null, body, origin } = {}) => t.get(`/api/v1/me${path}`, { as, method, ...(body !== undefined ? { json: body } : {}), headers: origin ? { origin } : {} });
    try {
        await check('a guest is refused; an empty or cross-site ask is refused', async () => {
            assert.strictEqual((await call('POST', '/actor/tasks', { body: { task: 'look' } })).status, 401);
            assert.strictEqual((await call('POST', '/actor/tasks', { as: ada, body: { task: '' } })).status, 422);
            assert.strictEqual((await call('POST', '/actor/tasks', { as: ada, body: { task: 'look', mode: 'reckless' } })).status, 422);
            assert.strictEqual((await call('POST', '/actor/tasks', { as: ada, body: { task: 'look' }, origin: 'https://evil.example' })).status, 403);
            assert.strictEqual(actor.st.calls.length, 0, 'nothing reached Actor');
        });

        await check('Codes asks Actor as the person, with its own service token for openvibe.actor', async () => {
            const r = await call('POST', '/actor/tasks', { as: ada, body: { task: 'Open openvibe.live and say what the Go live button looks like', mode: 'fastest' } });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.json().task.id, ID);
            assert.strictEqual(r.json().task.page, `https://openvibe.actor/chat/${ID}`);
            const c = actor.st.calls.find((x) => x.method === 'POST');
            assert.strictEqual(c.subject, ada.subject, 'named in X-OV-Subject');
            assert.strictEqual(c.claims.sub, 'svc:codes', 'the service token, not the person\'s');
            assert.ok(c.claims.aud.includes('openvibe.actor'));
            assert.deepStrictEqual(c.body, { task: 'Open openvibe.live and say what the Go live button looks like', mode: 'fastest' });
        });

        await check('the task reads back as a summary; another person cannot read it', async () => {
            const r = await call('GET', `/actor/tasks/${ID}`, { as: ada });
            assert.strictEqual(r.status, 200, r.text);
            assert.deepStrictEqual({ state: r.json().task.state, result: r.json().task.result, cost: r.json().task.cost_usd },
                { state: 'succeeded', result: { answer: 'The page shows the new Go live button.' }, cost: 0.0123 });
            assert.strictEqual((await call('GET', `/actor/tasks/${ID}`, { as: bo })).status, 404);
            assert.strictEqual((await call('GET', '/actor/tasks/not-an-id', { as: ada })).status, 404);
        });
    } finally {
        await t.close();
        await actor.close();
        done();
    }
})();
