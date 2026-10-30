'use strict';
/**
 * `openvibe-codes task` (bin/openvibe-codes.js, bin/task.js) against a stand-in OpenVibe.Codes: the flags become the
 * API's body and query, `--follow` reads the event stream as readable lines until the outcome, and the exit code
 * says what happened (0 the task answered or ended done, 1 the API refused it or the task needs someone, 2 the command
 * line or the token is wrong).
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { check, done } = require('./helpers/boot');

const BIN = path.join(__dirname, '..', 'bin', 'openvibe-codes.js');
const ID = 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T1';

function taskDoc(over = {}) {
    return {
        id: ID, state: 'queued', repo: 'https://github.com/acme/thing', ref: null, agent: 'codex',
        url: `https://openvibe.codes/run/tasks/${ID}`, created_at: '2026-10-30T05:00:00.000Z', updated_at: '2026-10-30T05:00:00.000Z',
        error: null,
        attempts: [{ id: 'att_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1', n: 1, agent: 'codex', model: null, machine: null, job_id: null, session: null, state: 'queued', reason: null, why: 'the task as it was asked', kind: 'first', cost_usd: null, tokens: null, steps: null, started_at: null, finished_at: null, created_at: '2026-10-30T05:00:00.000Z', end_why: null }],
        outcome: { state: null, note: null },
        ...over,
    };
}

(async () => {
    const seen = [];
    let created = false;
    let mode = 'queued';
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        let body = '';
        for await (const chunk of req) body += chunk;
        const json = body ? JSON.parse(body) : null;
        seen.push({ method: req.method, path: url.pathname, query: url.search, body: json, authorization: req.headers.authorization });
        const send = (status, doc, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(JSON.stringify(doc)); };
        if (req.method === 'POST' && url.pathname === '/api/v1/tasks') {
            if (json.idempotency_key === 'cli:c6-run' && created) return send(200, { task: taskDoc(), created: false });
            created = true;
            return send(201, { task: taskDoc(), created: true });
        }
        if (req.method === 'GET' && url.pathname === '/api/v1/tasks') {
            const state = url.searchParams.get('state');
            const t = taskDoc(state === 'needs' ? { state: 'failed', outcome: { state: 'unfinished', note: 'the tests still fail' } } : {});
            return send(200, { tasks: [t] });
        }
        if (req.method === 'GET' && url.pathname === `/api/v1/tasks/${ID}/events`) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
            const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
            res.write(frame('attempt', { type: 'attempt_started', attempt_n: 1, agent: 'codex', why: 'the task as it was asked' }));
            res.write(frame('line', { seq: 1, attempt_n: 1, kind: 'text', body: { t: 'text', text: 'looking at the parser' } }));
            res.write(frame('line', { seq: 2, attempt_n: 1, kind: 'tool', body: { t: 'tool', name: 'Read', input: { file_path: 'lib/parse.js' } } }));
            res.write(frame('attempt', { type: 'attempt_ended', attempt_n: 1, state: 'done', end_why: 'the agent finished' }));
            return res.end();
        }
        if (req.method === 'POST' && url.pathname === `/api/v1/tasks/${ID}/continue`) {
            const t = taskDoc({ attempts: [...taskDoc().attempts, { ...taskDoc().attempts[0], id: 'att_01J8Z3Q4R5S6T7V8W9X0Y1Z2A2', n: 2, why: `carried on by the owner: ${json.note}`, kind: 'manual' }] });
            return send(200, t);
        }
        if (req.method === 'POST' && url.pathname === `/api/v1/tasks/${ID}/stop`) {
            return send(200, taskDoc({ state: 'cancelled', outcome: { state: 'stopped', note: 'the task was stopped on purpose' } }));
        }
        if (req.method === 'GET' && url.pathname === `/api/v1/tasks/${ID}`) {
            if (mode === 'needs') return send(200, taskDoc({ state: 'failed', outcome: { state: 'unfinished', note: 'the tests still fail' }, error: 'two tests fail' }));
            return send(200, taskDoc({ state: 'succeeded', result: { ok: true, summary: 'Renamed getUser to findUser.', files: [{ path: 'lib/user.js', added: 3, removed: 3 }] }, outcome: { state: 'done', note: null } }));
        }
        return send(404, { code: 'codes.task_not_found', detail: 'no such task' }, 'application/problem+json');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const run = (args, env = {}) => new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN, 'task', ...args], { env: { ...process.env, OPENVIBE_CODES_URL: base, OPENVIBE_TOKEN: 'personal-token', ...env } });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => resolve({ code, out, err }));
    });
    const last = () => seen[seen.length - 1];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-task-cli-'));

    try {
        await check('start: the flags become the task; owner/repo, cx, --name, --tier and --permission', async () => {
            const brief = path.join(dir, 'brief.md');
            fs.writeFileSync(brief, 'Rename getUser to findUser.\n');
            const r = await run(['start', '--repo', 'acme/thing', '--agent', 'cx', '--machine', 'auto', '--file', brief, '--name', 'c6-run', '--tier', 'hard', '--permission', 'review']);
            assert.strictEqual(r.code, 0, r.err + r.out);
            assert.match(r.out, new RegExp(`started ${ID}`));
            const s = last();
            assert.strictEqual(s.method, 'POST');
            assert.strictEqual(s.path, '/api/v1/tasks');
            assert.strictEqual(s.authorization, 'Bearer personal-token');
            assert.strictEqual(s.body.repo, 'https://github.com/acme/thing');
            assert.strictEqual(s.body.agent, 'codex');
            assert.strictEqual(s.body.permission, 'review');
            assert.strictEqual(s.body.idempotency_key, 'cli:c6-run');
            assert.match(s.body.prompt, /^Rename getUser to findUser\./);
            assert.match(s.body.prompt, /tier: hard\s*$/);
        });

        await check('start twice with one --name answers the first task', async () => {
            const brief = path.join(dir, 'brief.md');
            const r = await run(['start', '--repo', 'https://github.com/acme/thing', '--file', brief, '--name', 'c6-run']);
            assert.strictEqual(r.code, 0, r.err);
            assert.match(r.out, new RegExp(`already started ${ID}`));
        });

        await check('list --state asks for that state and prints it', async () => {
            const r = await run(['list', '--state', 'running']);
            assert.strictEqual(r.code, 0, r.err);
            assert.strictEqual(last().query, '?state=running');
            assert.match(r.out, new RegExp(`^running\\s+${ID}`));
            const needs = await run(['list', '--state', 'needs', '--json']);
            assert.strictEqual(needs.code, 0, needs.err);
            assert.strictEqual(JSON.parse(needs.out).tasks[0].outcome.state, 'unfinished');
            assert.strictEqual((await run(['list', '--state', 'later'])).code, 2);
        });

        await check('show --follow reads the stream as lines and ends on the outcome, exit 0 when done', async () => {
            const r = await run(['show', ID, '--follow']);
            assert.strictEqual(r.code, 0, r.err + r.out);
            assert.match(r.out, /▶ attempt 1 · codex/);
            assert.match(r.out, /looking at the parser/);
            assert.match(r.out, /→ Read lib\/parse\.js/);
            assert.match(r.out, /✔ attempt 1 ended: done/);
            assert.match(r.out, /outcome: done/);
            assert.match(r.out, /Renamed getUser to findUser/);
            assert.strictEqual(last().path, `/api/v1/tasks/${ID}`);
        });

        await check('show --follow on a task that needs someone exits 1 and says what is left', async () => {
            mode = 'needs';
            const r = await run(['show', ID, '--follow']);
            assert.strictEqual(r.code, 1, r.err + r.out);
            assert.match(r.out, /outcome: unfinished — the tests still fail/);
            mode = 'queued';
        });

        await check('show without --follow prints the task and its attempts', async () => {
            const r = await run(['show', ID]);
            assert.strictEqual(r.code, 0, r.err);
            assert.match(r.out, new RegExp(`${ID} · done · succeeded`));
            assert.match(r.out, /attempt 1/);
        });

        await check('continue sends the note; stop answers the outcome', async () => {
            const c = await run(['continue', ID, '--note', 'and add a test']);
            assert.strictEqual(c.code, 0, c.err + c.out);
            assert.strictEqual(last().path, `/api/v1/tasks/${ID}/continue`);
            assert.strictEqual(last().body.note, 'and add a test');
            assert.match(c.out, /carried on .*running/); assert.match(c.out, /attempt 2 · queued/);
            const s = await run(['stop', ID]);
            assert.strictEqual(s.code, 0, s.err + s.out);
            assert.strictEqual(last().path, `/api/v1/tasks/${ID}/stop`);
            assert.match(s.out, /stopped .*done — stopped/);
        });

        await check('a refused API answer is exit 1; a wrong command line or no token is exit 2', async () => {
            const missing = await run(['show', 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T2']).catch(() => null);
            assert.strictEqual(missing.code, 1, missing.err);
            assert.match(missing.err, /404 codes\.task_not_found/);
            const noToken = await run(['list'], { OPENVIBE_TOKEN: '', OPENVIBE_TOKEN_FILE: path.join(dir, 'absent') });
            assert.strictEqual(noToken.code, 2);
            assert.match(noToken.err, /no Network token/);
            const badOption = await run(['list', '--nope']);
            assert.strictEqual(badOption.code, 2);
            const namedMachine = await run(['start', '--repo', 'acme/thing', '--file', path.join(dir, 'brief.md'), '--machine', 'nod_01J8Z3Q4R5S6T7V8W9X0Y1Z2N1']);
            assert.strictEqual(namedMachine.code, 2);
            assert.match(namedMachine.err, /only --machine auto/);
        });

        await check('the token file is read only when nobody else can read it', async () => {
            const file = path.join(dir, 'token');
            fs.writeFileSync(file, 'file-token\n');
            fs.chmodSync(file, 0o644);
            const loose = await run(['list'], { OPENVIBE_TOKEN: '', OPENVIBE_TOKEN_FILE: file });
            assert.strictEqual(loose.code, 2);
            assert.match(loose.err, /chmod 600/);
            fs.chmodSync(file, 0o600);
            const ok = await run(['list'], { OPENVIBE_TOKEN: '', OPENVIBE_TOKEN_FILE: file });
            assert.strictEqual(ok.code, 0, ok.err);
            assert.strictEqual(last().authorization, 'Bearer file-token');
        });
    } finally {
        await new Promise((r) => server.close(r));
        fs.rmSync(dir, { recursive: true, force: true });
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
