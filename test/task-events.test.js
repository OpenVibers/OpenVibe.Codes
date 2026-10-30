'use strict';

/**
 * A task's event stream (GET /api/v1/tasks/:id/events): the session's lines in the order they happened, the attempt
 * each line belongs to, and the attempts themselves (started, ended with why). A client that reconnects sends the last
 * line's seq as Last-Event-ID and gets only what came after it; a heartbeat keeps the connection alive.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const calls = [];
    let counter = 0;
    const run = {
        enabled: true,
        async submit(o) {
            counter++;
            const id = `job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J${String(counter).padStart(2, '0')}`;
            calls.push(['submit', o]);
            return { id, state: 'queued' };
        },
        async read(jobId) { return { id: jobId, state: 'queued' }; },
        async cancel(jobId) { return { id: jobId, state: 'cancelled' }; },
        async streamUrl() { throw new Error('not used'); },
    };
    const t = await boot({ run, env: { CODES_SSE_HEARTBEAT_MS: '300' } });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    const bo = t.network.addUser('bo');
    const CAPS = ['codes.task.start', 'codes.task.read', 'codes.task.cancel'];
    const actor = t.network.mintService('svc:actor', 'openvibe.codes', CAPS);

    const call = async (method, path, { token = actor, subject = ada.subject, body, headers = {} } = {}) => {
        const h = { Accept: 'text/event-stream', ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(subject ? { 'X-OV-Subject': subject } : {}) };
        if (body !== undefined) h['Content-Type'] = 'application/json';
        const res = await fetch(`${t.base}/api/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, text: await res.text() };
    };

    /** The stream, read until it ends (a finished task) or until the marker arrives. */
    const stream = (path, { headers = {}, until = null, ms = 8000 } = {}) => new Promise((resolve, reject) => {
        const req = http.get(`${t.base}${path}`, { headers }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            const timer = setTimeout(() => { req.destroy(); resolve({ status: res.statusCode, text }); }, ms);
            res.on('data', (chunk) => {
                text += chunk;
                if (until && text.includes(until)) { clearTimeout(timer); req.destroy(); resolve({ status: res.statusCode, text }); }
            });
            res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, text }); });
        });
        req.on('error', (e) => (e.code === 'ECONNRESET' ? resolve({ status: 0, text: '' }) : reject(e)));
    });

    /** A task of Ada's with two attempts and three lines of session. */
    const makeTask = async () => {
        const r = await fetch(`${t.base}/api/v1/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${actor}`, 'X-OV-Subject': ada.subject },
            body: JSON.stringify({ repo: 'https://github.com/octocat/Hello-World', prompt: 'Add a test for the date parser.', idempotency_key: `act_${Math.random().toString(36).slice(2, 10)}` }),
        });
        const json = await r.json();
        const id = json.task.id;
        await db.exec(`INSERT INTO codes_session_lines (task_id, seq, at, kind, body, attempt_n) VALUES
            ($1, 1, now(), 'text', '{"t":"text","text":"first"}'::jsonb, 1),
            ($1, 2, now(), 'text', '{"t":"text","text":"second"}'::jsonb, 1),
            ($1, 3, now(), 'text', '{"t":"text","text":"third"}'::jsonb, 2)`, [id]);
        return id;
    };

    try {
        // Ada ran a task on /run before (so Codes knows her project).
        await db.exec(`INSERT INTO run_tasks (id, subject, project_id, job_id, repo, prompt, state, created_at, updated_at)
            VALUES ('tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T1', $1, 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1', 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J00', 'https://github.com/a/b', 'by hand', 'succeeded', 1, 2)`, [ada.subject]);

        await check('the stream: the lines in order, the attempt each belongs to, and the attempts themselves', async () => {
            const id = await makeTask();
            // The task ends, so the stream ends with it.
            const row = await db.one('SELECT * FROM run_tasks WHERE id = $1', [id]);
            const job = { id: row.job_id, state: 'succeeded', result: { ok: true, summary: 'done', files: [], log: [{ t: 'done', ok: true, text: 'done' }] }, error: null };
            await t.ctx.tasks.applyEvent(row, { state: 'succeeded', job });
            await t.ctx.tasks.afterEnd(id);
            const s = await call('GET', `/tasks/${id}/events`);
            assert.strictEqual(s.status, 200);
            assert.ok(s.text.includes('event: line'), s.text.slice(0, 300));
            const seqs = [...s.text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
            assert.deepStrictEqual(seqs.slice(0, 3), [1, 2, 3], 'the lines in order, each with its seq');
            const bodies = [...s.text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]));
            const lines = bodies.filter((b) => b.seq);
            assert.deepStrictEqual(lines.slice(0, 3).map((l) => l.attempt_n), [1, 1, 2], 'each line says which attempt it belongs to');
            assert.deepStrictEqual(lines.slice(0, 3).map((l) => l.body.text), ['first', 'second', 'third']);
            const attempts = bodies.filter((b) => b.type);
            assert.strictEqual(attempts[0].type, 'attempt_started');
            assert.strictEqual(attempts[attempts.length - 1].type, 'attempt_ended');
            assert.strictEqual(attempts[attempts.length - 1].state, 'done');
        });

        await check('a client that reconnects gets only what came after the line it last saw', async () => {
            const id = await makeTask();
            const row = await db.one('SELECT * FROM run_tasks WHERE id = $1', [id]);
            const job = { id: row.job_id, state: 'succeeded', result: { ok: true, summary: 'done', files: [], log: [{ t: 'done', ok: true, text: 'done' }] }, error: null };
            await t.ctx.tasks.applyEvent(row, { state: 'succeeded', job });
            await t.ctx.tasks.afterEnd(id);
            const s = await call('GET', `/tasks/${id}/events`, { headers: { 'Last-Event-ID': '2' } });
            assert.strictEqual(s.status, 200);
            const seqs = [...s.text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
            assert.deepStrictEqual(seqs[0], 3, 'only the line after the last one it saw');
            assert.ok(!seqs.includes(1) && !seqs.includes(2), 'and not the ones before');
            assert.ok(!s.text.includes('"first"') && !s.text.includes('"second"'), 'and not the ones before');
        });

        await check('the heartbeat keeps the connection alive', async () => {
            const id = await makeTask();
            const s = await stream(`/api/v1/tasks/${id}/events`, {
                headers: { Authorization: `Bearer ${actor}`, 'X-OV-Subject': ada.subject },
                until: ': heartbeat',
                ms: 5000,
            });
            assert.ok(s.text.includes(': heartbeat'), s.text.slice(0, 200));
        });

        await check('the auth of the stream: no token, another person, another service', async () => {
            const id = await makeTask();
            assert.strictEqual((await call('GET', `/tasks/${id}/events`, { token: null })).status, 401);
            assert.strictEqual((await call('GET', `/tasks/${id}/events`, { subject: bo.subject })).status, 404);
            const other = t.network.mintService('svc:other', 'openvibe.codes', CAPS);
            assert.strictEqual((await call('GET', `/tasks/${id}/events`, { token: other })).status, 404);
            // The owner needs no token (the task runs, so the stream is read until the heartbeat).
            const mine = await stream(`/api/v1/tasks/${id}/events`, { headers: { cookie: t.signIn(ada) }, until: ': heartbeat', ms: 5000 });
            assert.strictEqual(mine.status, 200);
            assert.ok(mine.text.includes('event: line'), mine.text.slice(0, 200));
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
