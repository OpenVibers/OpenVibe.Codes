'use strict';

/**
 * Full file support in every composer (owner 2026-11-07): any file that is not a program, at most 10 files, 20 MB each
 * and 50 MB per message; images, PDFs, text and code, zips. The page's script uploads first through
 * /api/v1/attachments (a chip, a thumbnail, progress, a ×); without JavaScript the same form posts multipart. Every
 * file is owner-only, listed under its message, and written for the agent under
 * .openvibe/attachments/<message>/<name>, named in the turn's prompt.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');
const { runJob } = require('../harness/job');

const FILE = /^fil_[0-9A-HJKMNP-TV-Z]{26}$/;
const MSG = /^msg_[0-9A-HJKMNP-TV-Z]{26}$/;

function multipart(fields, files) {
    const boundary = `----ovtest${Date.now()}${Math.random().toString(36).slice(2)}`;
    const parts = [];
    for (const [key, value] of Object.entries(fields || {})) {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
    }
    for (const file of files || []) {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field || 'files'}"; filename="${file.name}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`));
        parts.push(file.buffer);
        parts.push(Buffer.from('\r\n'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

(async () => {
    const calls = [];
    let n = 0;
    const run = {
        enabled: true,
        async submit(o) { n++; calls.push(o); return { id: `job_01J8Z3Q4R5S6T7V8W9X0Y1Z2L${String(n).padStart(2, '0')}`, state: 'queued' }; },
        async read(jobId) { return { id: jobId, state: 'queued', result: null }; },
        async cancel(jobId) { return { id: jobId, state: 'cancelled' }; },
        async streamUrl() { throw new Error('not used'); },
    };
    const t = await boot({ run });
    const ada = t.network.addUser('ada-files');
    const bo = t.network.addUser('bo-files');
    const db = t.ctx.store.db;
    const upload = (name, buffer, type = 'application/octet-stream', as = ada) => t.get('/api/v1/attachments', {
        as, method: 'POST', body: buffer, headers: { 'content-type': type, 'x-file-name': name },
    });
    let taskId = null;

    try {
        await check('a text file, a PDF and a zip go up; Codes says what the bytes are, not the client', async () => {
            const txt = await upload('notes.txt', Buffer.from('the plan\nsecond line\n'));
            assert.strictEqual(txt.status, 201, txt.text);
            const one = txt.json().attachment;
            assert.ok(FILE.test(one.id));
            assert.strictEqual(one.name, 'notes.txt');
            assert.strictEqual(one.mime, 'text/plain');
            assert.strictEqual(one.size, 21);
            assert.strictEqual(one.image, false);
            const pdf = await upload('brief.pdf', Buffer.from('%PDF-1.4\n...'));
            assert.strictEqual(pdf.json().attachment.mime, 'application/pdf');
            const zip = await upload('code.zip', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('rest')]));
            assert.strictEqual(zip.json().attachment.mime, 'application/zip');
            // The same bytes with an image MIME claimed: the bytes decide.
            const lie = await upload('not-a-picture.png', Buffer.from('plain words'), 'image/png');
            assert.strictEqual(lie.json().attachment.mime, 'text/plain');
            // Another person's upload is theirs alone.
            assert.strictEqual((await upload('secret.txt', Buffer.from('mine'), 'text/plain', bo)).status, 201);
            assert.strictEqual((await t.get(`/api/v1/attachments/${one.id}`, { as: bo })).status, 404);
        });

        await check('programs are refused by extension and by magic bytes, and an empty file is refused', async () => {
            assert.strictEqual((await upload('setup.exe', Buffer.from('MZ fake'))).status, 422, 'by its extension');
            assert.strictEqual((await upload('innocent.txt', Buffer.from('MZ\x90\x00'))).status, 422, 'a PE renamed .txt is still a PE');
            assert.strictEqual((await upload('run.sh', Buffer.from('#!/bin/sh\nrm -rf /\n'))).status, 422, 'a shebang script');
            const elf = await upload('data.bin', Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from('ELF')]));
            assert.strictEqual(elf.status, 422, 'an ELF with a harmless-looking name');
            assert.strictEqual((await upload('empty.txt', Buffer.alloc(0))).status, 422);
        });

        await check('one file is at most 20 MB, and 10 files / 50 MB is the message cap', async () => {
            const big = await upload('big.dat', Buffer.alloc(20 * 1024 * 1024 + 1));
            assert.strictEqual(big.status, 413);
            // Three 18 MB records: the bytes are not needed to test the sum, only the sizes the rows carry.
            const ids = [];
            for (let i = 0; i < 3; i++) {
                const id = t.ctx.store.newId('fil');
                await db.exec("INSERT INTO codes_attachments (id, subject, name, mime, size, data, created_at) VALUES ($1, $2, $3, 'application/octet-stream', $4, $5, now())",
                    [id, ada.subject, `large-${i}.dat`, 18 * 1024 * 1024, Buffer.from([0])]);
                ids.push(id);
            }
            const posted = await t.get('/chat', { as: ada, form: { mode: 'code', repo: 'https://github.com/OpenVibers/OpenVibe.Codes', text: 'read these', attachment_ids: ids } });
            assert.strictEqual(posted.status, 303);
            assert.match(String(posted.headers.get('location')), /error=.*50%20MB/, 'refused in words, no task started');
            await db.exec('DELETE FROM codes_attachments WHERE id = ANY($1::text[])', [ids]);
            // At most ten: eleven tiny files are refused too.
            const many = [];
            for (let i = 0; i < 11; i++) many.push((await upload(`loose-${i}.txt`, Buffer.from(`file ${i}`))).json().attachment.id);
            const tooMany = await t.get('/chat', { as: ada, form: { mode: 'code', repo: 'https://github.com/OpenVibers/OpenVibe.Codes', text: 'many', attachment_ids: many } });
            assert.strictEqual(tooMany.status, 303);
            assert.match(String(tooMany.headers.get('location')), /error=.*at%20most%2010%20files/);
            for (const id of many) await t.get(`/api/v1/attachments/${id}`, { as: ada, method: 'DELETE' });
        });

        await check('with JavaScript the files are already up, and the form names their ids', async () => {
            const up = await upload('from-script.txt', Buffer.from('uploaded first\n'));
            assert.strictEqual(up.status, 201, up.text);
            const id = up.json().attachment.id;
            const made = await t.get('/chat', { as: ada, form: { mode: 'code', repo: 'https://github.com/OpenVibers/OpenVibe.Codex', text: 'Read the uploaded file.', who: 'codex|', attachment_ids: id } });
            assert.strictEqual(made.status, 303, made.text.slice(0, 300));
            const task = String(made.headers.get('location') || '').split('/').pop();
            const sub = calls.at(-1).args;
            assert.strictEqual(sub.attachments.length, 1);
            assert.strictEqual(sub.attachments[0].name, 'from-script.txt');
            assert.match(sub.prompt, new RegExp(`\\.openvibe/attachments/${sub.attachments[0].dir}/from-script\\.txt`));
            const row = await db.maybe('SELECT * FROM codes_attachments WHERE id = $1', [id]);
            assert.strictEqual(row.task_id, task);
            assert.strictEqual(Number(row.attempt_n), 1);
        });

        await check('without JavaScript a multipart start form carries the files, lists them, and names them in the prompt', async () => {
            const mp = multipart({ mode: 'code', repo: 'https://github.com/OpenVibers/OpenVibe.Codes', text: 'Read the plan and the screenshot.', who: 'codex|' }, [
                { name: 'plan.md', type: 'text/markdown', buffer: Buffer.from('# Plan\ndo the thing\n') },
                { name: 'shot.png', type: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]) },
            ]);
            const made = await t.get('/chat', { as: ada, method: 'POST', body: mp.body, headers: mp.headers });
            assert.strictEqual(made.status, 303, made.text.slice(0, 300));
            taskId = String(made.headers.get('location') || '').split('/').pop();
            const row = await db.one('SELECT * FROM run_tasks WHERE id = $1', [taskId]);
            assert.strictEqual(row.prompt, 'Read the plan and the screenshot.', 'the task keeps the person’s words');
            const sub = calls.at(-1).args;
            assert.strictEqual(sub.attachments.length, 2);
            assert.strictEqual(sub.attachments[0].name, 'plan.md');
            assert.match(sub.attachments[0].url, /\/api\/v1\/attachments\/fil_/);
            const folder = sub.attachments[0].dir;
            assert.ok(MSG.test(folder), `the message folder is a message id (${folder})`);
            assert.match(sub.prompt, new RegExp(`\\.openvibe/attachments/${folder}/plan\\.md`), 'the prompt says where the file is');
            assert.match(sub.prompt, /\.openvibe\/attachments\/.+shot\.png/);
            const rows = await db.many('SELECT * FROM codes_attachments WHERE task_id = $1 ORDER BY name', [taskId]);
            assert.strictEqual(rows.length, 2);
            assert.strictEqual(Number(rows[0].attempt_n), 1);
            assert.strictEqual(rows[0].message_id, folder);
            assert.strictEqual(rows[0].mime, 'text/markdown');
            assert.strictEqual(rows[1].mime, 'image/png');
            const page = await t.get(`/tasks/${taskId}`, { as: ada });
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('plan.md') && page.text.includes('shot.png'), 'listed on the message');
            assert.match(page.text, /href="\/api\/v1\/attachments\/fil_/);
            // Owner-only: another person cannot read the bytes, and the attachment is bound to its message.
            const bytes = await t.get(`/api/v1/attachments/${rows[0].id}`, { as: ada });
            assert.strictEqual(bytes.status, 200);
            assert.strictEqual(bytes.buffer.toString(), '# Plan\ndo the thing\n');
            assert.strictEqual((await t.get(`/api/v1/attachments/${rows[0].id}`, { as: bo })).status, 404);
            // The agent on the person's machine reads it with their Network token, not a browser session.
            const byToken = await t.get(`/api/v1/attachments/${rows[0].id}`, { bearer: t.network.userToken(ada) });
            assert.strictEqual(byToken.status, 200);
            assert.strictEqual(byToken.buffer.toString(), '# Plan\ndo the thing\n');
            assert.strictEqual((await t.get(`/api/v1/attachments/${rows[0].id}`, { bearer: t.network.userToken(bo) })).status, 404);
            assert.strictEqual((await t.get(`/api/v1/attachments/${rows[0].id}`, { as: ada, method: 'DELETE' })).status, 409);
        });

        await check('the composers use the shared picker and keep a multipart fallback', async () => {
            const home = await t.get('/', { as: ada });
            assert.strictEqual(home.status, 200);
            assert.match(home.text, /<form class="ovt-composer" id="ch-start"[^>]*enctype="multipart\/form-data"/, 'the start form posts multipart');
            assert.match(home.text, /data-ch-upload/, 'the shared picker mount');
            assert.match(home.text, /ov-upload\.js/, 'the shared picker script');
            assert.match(home.text, /<noscript><label>Attach files<input type="file" name="files"[^>]*multiple/, 'a native fallback takes files');
            assert.match(home.text, /accept="[^"]*image\/\*/, 'images, text, code, PDF and zip');
            assert.match(home.text, /From your OpenVibe files/, 'the library row');
            const task = await t.get(`/tasks/${taskId}`, { as: ada });
            assert.match(task.text, /enctype="multipart\/form-data"/, 'the reply composer too');
            assert.match(task.text, /data-ch-upload/);
        });

        await check('a multipart reply carries its own files on the next turn', async () => {
            // The first turn ended before the person writes again: the test's Run never sends that event.
            await db.exec("UPDATE run_tasks SET state = 'succeeded', updated_at = $2 WHERE id = $1", [taskId, Date.now()]);
            await db.exec("UPDATE codes_attempts SET state = 'done', finished_at = now() WHERE task_id = $1", [taskId]);
            const before = calls.length;
            const mp = multipart({ text: 'Now the second file.' }, [
                { name: 'next.md', type: 'text/markdown', buffer: Buffer.from('next steps\n') },
            ]);
            const r = await t.get(`/tasks/${taskId}/continue`, { as: ada, method: 'POST', body: mp.body, headers: mp.headers });
            assert.strictEqual(r.status, 303, r.text.slice(0, 300));
            assert.strictEqual(calls.length, before + 1);
            const sub = calls.at(-1).args;
            assert.strictEqual(sub.attachments.length, 1);
            assert.strictEqual(sub.attachments[0].name, 'next.md');
            const folder = sub.attachments[0].dir;
            assert.match(sub.prompt, new RegExp(`\\.openvibe/attachments/${folder}/next\\.md`));
            const row = await db.maybe('SELECT * FROM codes_attachments WHERE task_id = $1 AND attempt_n = 2', [taskId]);
            assert.ok(row && row.name === 'next.md');
            const page = await t.get(`/tasks/${taskId}`, { as: ada });
            assert.ok(page.text.includes('next.md'));
        });

        await check('the agent gets the files in its workspace and the prompt names each path', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-codes-files-'));
            const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/plain'); res.end('the attached words\n'); });
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            const url = `http://127.0.0.1:${server.address().port}/file`;
            let seen = null;
            const harness = {
                run: async function* ({ prompt, cwd }) {
                    seen = { prompt, cwd };
                    const target = path.join(cwd, '.openvibe', 'attachments', 'msg_01J8Z3Q4R5S6T7V8W9X0Y1Z2M1', 'my notes.txt');
                    assert.ok(fs.existsSync(target), `the file is in the workspace (${target})`);
                    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'the attached words\n');
                    yield { type: 'system', subtype: 'init', agent: 'codex', session_id: 'sess-file' };
                    yield { type: 'result', subtype: 'success', is_error: false, result: 'read it' };
                },
            };
            try {
                const input = JSON.stringify({
                    kind: 'conductor', folder: dir, prompt: 'Read the file.', agent: 'codex', safety: 'ask',
                    attachments: [{ name: 'my notes.txt', mime: 'text/plain', url, dir: 'msg_01J8Z3Q4R5S6T7V8W9X0Y1Z2M1' }],
                });
                const result = await runJob({ input, harness, emit() {}, writeResult() {}, env: {}, tmp: os.tmpdir() });
                assert.strictEqual(result.ok, true, JSON.stringify(result));
                assert.ok(seen && seen.cwd === dir);
                assert.match(seen.prompt, /\.openvibe\/attachments\/msg_01J8Z3Q4R5S6T7V8W9X0Y1Z2M1\/my notes\.txt/);
                assert.match(seen.prompt, /Files the owner attached/);
            } finally {
                await new Promise((resolve) => server.close(resolve));
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        await check('GET/PUT /api/v1/me/settings carries who leads your tasks, and a made-up agent is refused', async () => {
            const before = await t.get('/api/v1/me/settings', { as: ada });
            assert.strictEqual(before.status, 200, before.text);
            assert.strictEqual(before.json().settings.conductor_agent, 'claude-code');
            assert.strictEqual(before.json().settings.conductor_model, 'opus');
            const saved = await t.get('/api/v1/me/settings', { as: ada, method: 'PUT', json: { conductor_agent: 'codex', conductor_model: 'gpt-5.5' } });
            assert.strictEqual(saved.status, 200, saved.text);
            assert.strictEqual(saved.json().settings.conductor_agent, 'codex');
            assert.strictEqual(saved.json().settings.conductor_model, 'gpt-5.5');
            const read = await t.get('/api/v1/me/settings', { as: ada });
            assert.strictEqual(read.json().settings.conductor_agent, 'codex');
            const bad = await t.get('/api/v1/me/settings', { as: ada, method: 'PUT', json: { conductor_agent: 'made-up' } });
            assert.strictEqual(bad.status, 422);
            assert.strictEqual(bad.json().code, 'settings.conductor_agent_unknown');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
