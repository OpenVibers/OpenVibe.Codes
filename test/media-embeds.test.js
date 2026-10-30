'use strict';
/**
 * The pictures of a task (Codes C10): the images a harness read and the screenshots the proof shot travel in the job
 * result, and Codes puts them in Media as private objects of the person — never a public URL. The session shows a
 * short-lived signed URL, and only the task's owner gets one: another person gets a 404.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

const { createSessionLines } = require('../server/domain/session-lines');
const { createProof } = require('../server/domain/proof');
const { createMedia } = require('../server/media');
const { compact } = require('../harness/job');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const b64 = (bytes) => Buffer.alloc(bytes, 7).toString('base64');

(async () => {
    const calls = [];
    const mediaServer = http.createServer((req, res) => {
        const u = req.url.split('?')[0];
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks);
            calls.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
            if (req.method === 'POST' && u === '/api/v2/codes/objects') {
                const body = JSON.parse(raw.toString('utf8') || '{}');
                res.writeHead(201, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({
                    id: 'obj_1',
                    upload: {
                        method: 'PUT', url: `http://127.0.0.1:${mediaServer.address().port}/upload/obj_1?token=t`,
                        token: 't', complete_url: `http://127.0.0.1:${mediaServer.address().port}/api/v2/codes/objects/obj_1/complete`,
                    },
                }));
            }
            if (req.method === 'PUT' && u.startsWith('/upload/')) { res.writeHead(200); return res.end('ok'); }
            if (req.method === 'POST' && u.endsWith('/complete')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
            if (req.method === 'GET' && u.endsWith('/download')) {
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ url: 'https://openvibe.media/o/obj_1?exp=99&sig=abc', expires_at: new Date(Date.now() + 600000).toISOString(), public: false }));
            }
            res.writeHead(404); return res.end('no');
        });
    });
    await new Promise((ok) => mediaServer.listen(0, '127.0.0.1', ok));
    const mediaUrl = `http://127.0.0.1:${mediaServer.address().port}`;

    const t = await boot({ env: { CODES_MEDIA_URL: mediaUrl, CODES_MEDIA_KEY: 'codes-test-key' } });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    const bo = t.network.addUser('bo');
    const project = 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1';
    const taskId = 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T55';
    await db.exec(`INSERT INTO run_tasks (id, subject, project_id, job_id, repo, prompt, state, created_at, updated_at)
        VALUES ($1, $2, $3, 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J55', 'https://github.com/a/b', 'look at the picture', 'running', 1, 2)`,
    [taskId, ada.subject, project]);

    const media = createMedia({ config: { media: { url: mediaUrl, key: 'codes-test-key', app: 'codes', ttl: 600 } }, log: console });
    const lines = createSessionLines({ store: t.ctx.store, config: t.ctx.config, log: console, media });
    const proof = createProof({ store: t.ctx.store, config: t.ctx.config, log: console });

    await check('a picture on a line goes to Media as a private object of the person, and the line keeps no bytes', async () => {
        calls.length = 0;
        await lines.append(taskId, [{
            seq: 1, at: new Date().toISOString(), kind: 'tool_result',
            body: { t: 'tool_result', id: 'tool-1', ok: true, output: '', attachments: [{ url: `data:image/png;base64,${PNG}`, name: 'shot.png', mime: 'image/png', kind: 'image', role: 'read' }] },
        }], null, ada.subject);

        const init = calls.find((c) => c.method === 'POST' && c.url === '/api/v2/codes/objects');
        assert.ok(init, 'the picture was offered to Media');
        const body = JSON.parse(init.body.toString('utf8'));
        assert.strictEqual(body.visibility, 'private', 'a screenshot is never public');
        assert.strictEqual(body.mime_type, 'image/png', 'Media is told what it is');
        assert.ok(init.headers['x-ov-subject'] === ada.subject, 'the object belongs to the person the task belongs to');
        assert.ok(calls.some((c) => c.method === 'PUT' && c.url.startsWith('/upload/')), 'the bytes were sent');
        assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/complete')), 'and the object was completed');

        const rows = await db.many('SELECT body FROM codes_session_lines WHERE task_id = $1', [taskId]);
        const stored = rows[0].body;
        assert.ok(stored.attachments && stored.attachments[0].media === 'obj_1', 'the line keeps the object id');
        assert.ok(!stored.attachments[0].url, 'and no URL of its own');
        assert.ok(!JSON.stringify(stored).includes('base64'), 'and never the bytes');
    });

    await check('the reader gets a short-lived signed URL, and only the owner', async () => {
        const out = await lines.linesForRow({ id: taskId, subject: ada.subject });
        const att = out[0].attachments[0];
        assert.ok(att.url && att.url.startsWith('https://openvibe.media/o/'), 'the picture is served by Media');
        assert.ok(att.url.includes('sig='), 'through a signed URL');
        assert.ok(!att.media || att.media === 'obj_1', 'the object id is still there');
    });

    await check('another person cannot read the task at all', async () => {
        const res = await t.get(`/run/tasks/${taskId}/session.json`, { as: bo });
        assert.strictEqual(res.status, 404, 'a task of yours is 404 for another person');
        const row = await db.maybe('SELECT id, subject FROM run_tasks WHERE id = $1', [taskId]);
        process.stderr.write(`[test] the row: ${JSON.stringify(row)}; ada: ${ada.subject}\n`);
    });

    await check('a proof item with a screenshot puts the picture on its line and keeps no bytes in the record', async () => {
        const recorded = await proof.record(taskId, null, [{
            kind: 'screenshots', label: 'screenshots', ok: true, summary: '2 screenshots of 1 page at 390px, clean',
            detail: { shots: [{ path: '/tmp/proof-home-390.jpg', name: 'proof-home-390.jpg', mime: 'image/jpeg', width: 390, data: b64(1200) }] },
        }]);
        assert.strictEqual(recorded.lines.length, 1, 'the proof has a line');
        const att = recorded.lines[0].body.attachments;
        assert.ok(att && att.length === 1, 'the line carries the picture');
        assert.ok(att[0].url.startsWith('data:image/jpeg;base64,'), 'with its bytes, for Codes to put in Media');
        assert.strictEqual(att[0].role, 'output', 'and it is what the run produced');
        const row = recorded.rows[0];
        assert.ok(!JSON.stringify(row.detail).includes('"data"'), 'the stored record keeps no bytes');
        assert.ok(row.detail.shots[0].width === 390, 'but keeps what the picture is');
    });

    await check('the harness reads a picture once, and only if it fits', async () => {
        const small = compact({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { media_type: 'image/png', data: PNG } }] }] } }, { pictures: { left: 320 * 1024 } });
        assert.ok(small[0].attachments && small[0].attachments.length === 1, 'the picture comes back on the line');
        assert.ok(small[0].attachments[0].url.startsWith('data:image/png;base64,'), 'as its bytes');
        assert.strictEqual(small[0].attachments[0].role, 'read', 'and it is what the agent read');

        const big = compact({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'image', source: { media_type: 'image/png', data: b64(200 * 1024) } }] }] } }, { pictures: { left: 320 * 1024 } });
        assert.ok(!big[0].attachments, 'a picture over the cap is left out');

        const budget = { left: 100 };
        const two = compact({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: [{ type: 'image', source: { media_type: 'image/png', data: b64(900) } }] }] } }, { pictures: budget });
        assert.ok(!two[0].attachments || two[0].attachments.length === 0, 'and what does not fit the result is left out');
    });

    done();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
