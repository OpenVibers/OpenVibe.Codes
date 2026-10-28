'use strict';
/**
 * Session lines in PostgreSQL (plan 2026-10-28 §6, decision 1): the Run stream's output/state/end frames become
 * lines as they arrive, a reconnect does not duplicate them, a 70 KB line is clipped with a marker, the machine's
 * final log back-fills what the stream missed, replay pages with after, the owner or a codes.task.read service reads
 * them (another person cannot), a task from before this change falls back to result.log, and retention only deletes
 * lines of tasks finished longer than the retention window ago.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

const TASK = (n) => `tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T${n}`;
const JOB = (n) => `job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J${n}`;
const NOW = Date.now();

function frame(type, seq, data) {
    return `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ type, seq, ...data })}\n\n`;
}

(async () => {
    const stream = { frames: [], requests: 0 };
    const sse = http.createServer((req, res) => {
        stream.requests++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const f of stream.frames) res.write(f);
        res.end();
    });
    await new Promise((ok) => sse.listen(0, '127.0.0.1', ok));

    let readResult = null;
    const run = {
        enabled: true,
        async submit() { return { id: JOB('1'), state: 'queued' }; },
        async read(jobId) { return { id: jobId, state: 'succeeded', result: readResult, error: null, timings: { started_at: new Date(NOW).toISOString(), finished_at: new Date(NOW + 1000).toISOString() } }; },
        async cancel() { return { state: 'cancelled' }; },
        async streamUrl() { return `http://127.0.0.1:${sse.address().port}/stream`; },
    };
    const t = await boot({ run });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    const bo = t.network.addUser('bo');
    const project = 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1';
    const insert = async (n, { state = 'running', job = JOB('1'), result = null, updatedAt = NOW, finishedAt = null } = {}) => {
        await db.exec(`INSERT INTO run_tasks (id, subject, project_id, job_id, repo, prompt, state, result, finished_at, created_at, updated_at)
            VALUES ($1, $2, $3, $4, 'https://github.com/OpenVibers/OpenVibe.Codes', 'Fix it', $5, $6::jsonb, $7::timestamptz, $8, $9)`,
        [TASK(n), ada.subject, project, job, state, result == null ? null : JSON.stringify(result), finishedAt, NOW, updatedAt]);
    };
    const lines = (n) => db.many('SELECT seq, kind, body FROM codes_session_lines WHERE task_id = $1 ORDER BY seq', [TASK(n)]);
    const replay = (n, query = '') => t.get(`/run/tasks/${TASK(n)}/session.json${query}`, { as: ada });

    const finalLog = [
        { t: 'step', text: 'Cloning' },
        { t: 'tool', id: 't1', name: 'Read', input: { file_path: 'a.js' } },
        { t: 'tool_result', id: 't1', ok: true, output: 'ok' },
        { t: 'done', ok: true, text: 'Finished' },
    ];

    try {
        await check('the output, state and end frames are lines in order, and the final log back-fills what the stream missed', async () => {
            await insert('1');
            stream.frames = [
                frame('output', 1, { chunk: `${JSON.stringify(finalLog[0])}\n` }),
                frame('output', 2, { chunk: `${JSON.stringify(finalLog[1])}\n` }),
                frame('state', 3, { state: 'running' }),
                frame('output', 4, { chunk: `${JSON.stringify(finalLog[2])}\n` }),
                frame('end', 5, { state: 'succeeded' }),
            ];
            readResult = { ok: true, summary: 'Finished', log: finalLog };
            const r = await t.get(`/run/tasks/${TASK('1')}/events`, { as: ada });
            assert.strictEqual(r.status, 200, r.text);
            const rows = await lines('1');
            assert.deepStrictEqual(rows.map((x) => x.kind), ['step', 'tool', 'state', 'tool_result', 'done', 'end']);
            for (let i = 1; i < rows.length; i++) assert.ok(rows[i].seq > rows[i - 1].seq, 'ordered by seq');
            assert.deepStrictEqual(rows[0].body, finalLog[0]);
            assert.deepStrictEqual(rows[4].body, finalLog[3], 'the done line came only from the result log');
            const row = await db.one('SELECT state, session_complete_at FROM run_tasks WHERE id = $1', [TASK('1')]);
            assert.strictEqual(row.state, 'succeeded');
            assert.ok(row.session_complete_at, 'the lines are marked complete');
            const page = await replay('1');
            assert.strictEqual(page.status, 200, page.text);
            assert.strictEqual(page.json().source, 'session');
            assert.strictEqual(page.json().lines.length, 6);
        });

        await check('a reconnect that replays the stream does not duplicate a line', async () => {
            const before = await lines('1');
            const r = await t.get(`/run/tasks/${TASK('1')}/events`, { as: ada });
            assert.strictEqual(r.status, 200);
            const after = await lines('1');
            assert.strictEqual(after.length, before.length);
            assert.deepStrictEqual(after.map((x) => x.seq), before.map((x) => x.seq));
        });

        await check('a 70 KB line is clipped and carries a marker', async () => {
            await insert('2', { job: JOB('2') });
            stream.frames = [
                frame('output', 1, { chunk: `${JSON.stringify({ t: 'text', text: 'x'.repeat(70 * 1024) })}\n` }),
                frame('state', 2, { state: 'succeeded' }),
                frame('end', 3, { state: 'succeeded' }),
            ];
            readResult = { ok: true, log: [] };
            const r = await t.get(`/run/tasks/${TASK('2')}/events`, { as: ada });
            assert.strictEqual(r.status, 200);
            const rows = await lines('2');
            const text = rows.find((x) => x.kind === 'text');
            assert.ok(text);
            assert.ok(text.body.text.length < 70 * 1024);
            assert.match(text.body.text, /\[clipped\]/);
            assert.ok(Buffer.byteLength(JSON.stringify(text.body)) <= 64 * 1024);
        });

        await check('a long session keeps its lines: a stream event past 8 600 does not overflow the seq', async () => {
            await insert('8', { job: JOB('8') });
            stream.frames = [
                frame('output', 12000, { chunk: `${JSON.stringify({ t: 'text', text: 'late in a long run' })}\n` }),
                frame('state', 12001, { state: 'succeeded' }),
                frame('end', 12002, { state: 'succeeded' }),
            ];
            readResult = { ok: true, log: [] };
            const r = await t.get(`/run/tasks/${TASK('8')}/events`, { as: ada });
            assert.strictEqual(r.status, 200);
            const text = (await lines('8')).find((x) => x.kind === 'text');
            assert.ok(text, 'the line is kept');
            assert.ok(text.seq > 2 ** 31, `seq ${text.seq} is past PostgreSQL's integer`);
        });

        await check('replay pages after a seq, at most 500 lines', async () => {
            await insert('3', { state: 'succeeded', job: JOB('3'), updatedAt: NOW - 1000, finishedAt: new Date(NOW - 1000).toISOString() });
            await t.ctx.sessions.append(TASK('3'), Array.from({ length: 510 }, (_, i) => ({
                seq: i + 1, at: new Date(NOW).toISOString(), kind: 'step', body: { t: 'step', text: `line ${i + 1}` },
            })));
            const first = await replay('3', '?after=0');
            assert.strictEqual(first.status, 200, first.text);
            assert.strictEqual(first.json().lines.length, 500);
            assert.strictEqual(first.json().next_after, 500);
            assert.strictEqual(first.json().has_more, true);
            const second = await replay('3', '?after=500');
            assert.strictEqual(second.json().lines.length, 10);
            assert.strictEqual(second.json().lines[0].seq, 501);
            assert.strictEqual(second.json().has_more, false);
            assert.strictEqual((await replay('3', '?after=nope')).status, 422);
        });

        await check('a person cannot read another person’s session; a codes.task.read service can read it for its subject', async () => {
            assert.strictEqual((await t.get(`/run/tasks/${TASK('1')}/session.json`, { as: bo })).status, 404);
            const caps = ['codes.task.read'];
            const watch = t.network.mintService('svc:watch', 'openvibe.codes', caps);
            const ok = await t.get(`/run/tasks/${TASK('1')}/session.json`, { headers: { authorization: `Bearer ${watch}`, 'X-OV-Subject': ada.subject } });
            assert.strictEqual(ok.status, 200, ok.text);
            assert.strictEqual(ok.json().task_id, TASK('1'));
            const wrongPerson = await t.get(`/run/tasks/${TASK('1')}/session.json`, { headers: { authorization: `Bearer ${watch}`, 'X-OV-Subject': bo.subject } });
            assert.strictEqual(wrongPerson.status, 404);
            const noCap = t.network.mintService('svc:watch', 'openvibe.codes', ['codes.task.start']);
            assert.strictEqual((await t.get(`/run/tasks/${TASK('1')}/session.json`, { headers: { authorization: `Bearer ${noCap}`, 'X-OV-Subject': ada.subject } })).status, 403);
            assert.strictEqual((await t.get(`/run/tasks/${TASK('1')}/session.json`)).status, 401);
        });

        await check('a task from before this change falls back to the old result.log on the page and in replay', async () => {
            await insert('4', {
                state: 'succeeded', job: JOB('4'), updatedAt: NOW - 1000, finishedAt: new Date(NOW - 1000).toISOString(),
                result: { ok: true, log: [{ t: 'text', text: 'old line' }, { t: 'done', ok: true, text: 'old done' }] },
            });
            const page = await t.get(`/run/tasks/${TASK('4')}`, { as: ada });
            assert.strictEqual(page.status, 200);
            const kept = JSON.parse(/<script type="application\/json" data-session-log>([\s\S]*?)<\/script>/.exec(page.text)[1]);
            assert.deepStrictEqual(kept.map((x) => x.t), ['text', 'done']);
            const r = await replay('4');
            assert.strictEqual(r.json().source, 'result.log');
            assert.deepStrictEqual(r.json().lines.map((x) => x.body.t), ['text', 'done']);
            assert.strictEqual(r.json().lines[0].seq, 1);
        });

        await check('retention deletes only lines of tasks finished more than 90 days ago', async () => {
            const old = new Date(NOW - 100 * 86_400_000).toISOString();
            await insert('5', { state: 'succeeded', job: JOB('5'), updatedAt: NOW - 100 * 86_400_000, finishedAt: old });
            await insert('6', { state: 'running', job: JOB('6'), updatedAt: NOW - 100 * 86_400_000 });
            await insert('7', { state: 'succeeded', job: JOB('7'), updatedAt: NOW - 1000, finishedAt: new Date(NOW - 1000).toISOString() });
            for (const n of ['5', '6', '7']) {
                await t.ctx.sessions.append(TASK(n), [{ seq: 1, at: new Date(NOW).toISOString(), kind: 'step', body: { t: 'step', text: n } }]);
            }
            await t.ctx.sessionRetention.runOnce();
            assert.strictEqual((await lines('5')).length, 0, 'old finished task');
            assert.strictEqual((await lines('6')).length, 1, 'old but still running');
            assert.strictEqual((await lines('7')).length, 1, 'recently finished');
        });
    } finally {
        await t.close();
        sse.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
