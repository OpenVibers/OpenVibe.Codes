'use strict';
/**
 * The Dock's Code tab API (the home composer's three ways, cross-site): the person's tasks as
 * codes.task-summary@1 (GET /api/v1/me/tasks, running first), starting one (POST /api/v1/tasks
 * { text, mode, repo?, attachments? }) and stopping one (POST /api/v1/tasks/:id/stop → { ok }).
 *
 * A session cookie or the person's own Network bearer token; another person's task is 404, never shown.
 * Cross-site reads and uploads from the OpenVibe origins are reflected; anything else is not.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { summarize } = require('../server/domain/task-summary');

const SUMMARY_KEYS = ['id', 'title', 'status', 'mode', 'repo', 'started_at', 'updated_at', 'steps', 'url', 'preview_url', 'pr_url'];
// TODO (contracts 0.401.0): validate the answers with contracts.validate('codes.task-summary@1', …)
// once the pin carries it, instead of this structural mirror of its required keys and enums.
function assertSummary(s) {
    assert.deepStrictEqual(Object.keys(s).sort(), SUMMARY_KEYS.slice().sort());
    assert.match(s.id, /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.ok(typeof s.title === 'string' && s.title.length >= 1 && s.title.length <= 200, 'a title');
    assert.ok(['queued', 'running', 'needs-you', 'done', 'failed', 'stopped'].includes(s.status), `status ${s.status}`);
    assert.ok(['create', 'openvibe', 'repo'].includes(s.mode), `mode ${s.mode}`);
    assert.ok(!Number.isNaN(Date.parse(s.started_at)) && !Number.isNaN(Date.parse(s.updated_at)), 'timestamps');
    assert.ok(Number.isInteger(s.steps) && s.steps >= 0, 'steps');
    assert.ok(s.url.startsWith('https://openvibe.codes/tasks/'), 'the task page');
    assert.ok(s.preview_url === null, 'no preview yet');
    assert.ok(s.pr_url === null || typeof s.pr_url === 'string', 'the pull request or null');
}

(async () => {
    let readState = 'queued';
    let jobs = 0;
    const calls = [];
    const run = {
        enabled: true,
        async submit(o) { calls.push(['submit', o]); jobs += 1; return { id: `job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J${jobs}`, state: 'queued' }; },
        async read(jobId) { return { id: jobId, state: readState, result: null, error: null }; },
        async cancel(jobId, who) { calls.push(['cancel', jobId, who]); return { id: jobId, state: 'cancelled' }; },
        async streamUrl() { throw new Error('not used'); },
    };
    const t = await boot({ run });
    const ada = t.network.addUser('ada');
    const bo = t.network.addUser('bo');
    const adaToken = () => t.network.userToken(ada);

    const api = (method, path, { as = null, bearer = null, body = undefined, origin = undefined } = {}) => {
        const headers = {};
        if (origin) headers.origin = origin;
        if (bearer) headers.authorization = `Bearer ${bearer}`;
        return t.get(`/api/v1${path}`, { as, method, ...(body !== undefined ? { json: body } : {}), headers });
    };
    const startRepo = (over = {}, opts = {}) => api('POST', '/tasks', {
        body: { text: 'Add a test for the date parser.', mode: 'repo', repo: 'https://github.com/octocat/Hello-World', ...over },
        ...opts,
    });

    try {
        await check('a guest is refused everywhere', async () => {
            assert.strictEqual((await api('GET', '/me/tasks')).status, 401);
            assert.strictEqual((await startRepo()).status, 401);
            assert.strictEqual((await api('POST', '/tasks/tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3/stop')).status, 401);
        });

        await check('CORS: an OpenVibe origin is reflected, anything else is not; preflights end here', async () => {
            const yes = await api('GET', '/me/tasks?limit=1', { as: ada, origin: 'https://openvibe.chat' });
            assert.strictEqual(yes.status, 200);
            assert.strictEqual(yes.headers.get('access-control-allow-origin'), 'https://openvibe.chat');
            const no = await api('GET', '/me/tasks?limit=1', { as: ada, origin: 'https://evil.example' });
            assert.strictEqual(no.status, 200);
            assert.strictEqual(no.headers.get('access-control-allow-origin'), null);
            const pre = await t.get('/api/v1/me/tasks', { method: 'OPTIONS', headers: { origin: 'https://openvibe.chat' } });
            assert.strictEqual(pre.status, 204);
            assert.ok((pre.headers.get('access-control-allow-methods') || '').includes('GET'));
        });

        let firstId;
        await check('a repo task starts from the Dock shape, by session and by bearer', async () => {
            const r = await startRepo({}, { as: ada });
            assert.strictEqual(r.status, 201, r.text);
            assert.match(r.json().id, /^tsk_/);
            assert.strictEqual(r.json().url, `https://openvibe.codes/tasks/${r.json().id}`);
            firstId = r.json().id;
            const row = await t.ctx.store.db.maybe('SELECT mode, subject FROM run_tasks WHERE id = $1', [firstId]);
            assert.strictEqual(row.mode, 'repo');
            assert.strictEqual(row.subject, ada.subject);
            const byBearer = await startRepo({ text: 'Fix the off-by-one in the pager.' }, { bearer: adaToken() });
            assert.strictEqual(byBearer.status, 201, byBearer.text);
        });

        await check('the start is validated like the site: words, mode and repository', async () => {
            assert.strictEqual((await api('POST', '/tasks', { as: ada, body: { text: '', mode: 'repo', repo: 'https://github.com/o/r' } })).status, 422);
            assert.strictEqual((await api('POST', '/tasks', { as: ada, body: { text: 'Hi', mode: 'teleport' } })).status, 422);
            assert.strictEqual((await api('POST', '/tasks', { as: ada, body: { text: 'Hi', mode: 'repo' } })).status, 422);
            assert.strictEqual((await api('POST', '/tasks', { as: ada, body: { text: 'Hi', mode: 'repo', repo: 'not a repo' } })).status, 422);
            const before = calls.filter((c) => c[0] === 'submit').length;
            assert.strictEqual((await api('POST', '/tasks', { as: ada, body: { text: 'Hi', mode: 'create', repo: 'https://github.com/o/r' } })).status, 422);
            assert.strictEqual(calls.filter((c) => c[0] === 'submit').length, before, 'a refused start reaches no machine');
        });

        await check('create hands over to OpenVibe AI: no task, the Space address to press Build in', async () => {
            const r = await api('POST', '/tasks', { as: ada, body: { text: 'A bakery site with today\u2019s hours', mode: 'create' } });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().id, null);
            assert.ok(String(r.json().url).startsWith('https://openvibe.space'), r.json().url);
        });

        await check('make works out new or existing from the words (2026-11-13: Create and My code are one)', async () => {
            // Nothing named and nothing of yours mentioned: something new, handed over like create.
            let r = await api('POST', '/tasks', { as: ada, body: { text: 'A bakery site with today\u2019s hours', mode: 'make' } });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().id, null, 'something new: no task yet');
            assert.ok(String(r.json().url).startsWith('https://openvibe.space'), r.json().url);
            // A Git address in the words: work on that repository.
            r = await api('POST', '/tasks', { as: ada, body: { text: 'Add a test for the date parser in https://github.com/octocat/Hello-World', mode: 'make' } });
            assert.ok(r.status === 200 || r.status === 201, r.text);
            assert.match(String(r.json().id), /^tsk_/, 'a task on the named repository');
            let row = await t.ctx.store.db.maybe('SELECT mode, repo FROM run_tasks WHERE id = $1', [r.json().id]);
            assert.strictEqual(row.mode, 'repo');
            // One of yours by its name (the task above made Hello-World one of ada's repositories).
            r = await api('POST', '/tasks', { as: ada, body: { text: 'Now fix the README typo in hello-world', mode: 'make' } });
            assert.ok(r.status === 200 || r.status === 201, r.text);
            assert.match(String(r.json().id), /^tsk_/, 'a task on your repository, found by its name');
            row = await t.ctx.store.db.maybe('SELECT mode, repo FROM run_tasks WHERE id = $1', [r.json().id]);
            assert.match(String(row.repo), /octocat\/Hello-World/i);
        });

        await check('openvibe mode works out the project from the words, like the site', async () => {
            const r = await api('POST', '/tasks', { as: ada, body: { text: 'Make Live faster on phones', mode: 'openvibe' } });
            assert.strictEqual(r.status, 201, r.text);
            const row = await t.ctx.store.db.maybe('SELECT repo, mode FROM run_tasks WHERE id = $1', [r.json().id]);
            assert.strictEqual(row.repo, 'https://github.com/OpenVibers/OpenVibe.Live');
            assert.strictEqual(row.mode, 'openvibe');
            const vague = await api('POST', '/tasks', { as: ada, body: { text: 'Make it faster on phones', mode: 'openvibe' } });
            assert.strictEqual(vague.status, 422, 'no project named, no task');
        });

        await check('a service keeps the contract shape: the Dock shape is the owner\u2019s', async () => {
            const svc = t.network.mintService('svc:actor', 'openvibe.codes', ['codes.task.start']);
            const r = await api('POST', '/tasks', { body: { text: 'Hi', mode: 'repo', repo: 'https://github.com/o/r' }, bearer: svc });
            assert.strictEqual(r.status, 422);
        });

        let attachedId;
        await check('composer attachment ids ride the task: named in the first message, on disk for the runner', async () => {
            const data = new FormData();
            data.append('file', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
            const up = await fetch(`${t.base}/api/v1/attachments`, { method: 'POST', headers: { cookie: t.signIn(bo) }, body: data });
            const upText = await up.text();
            assert.strictEqual(up.status, 201, upText);
            const saved = JSON.parse(upText).attachment;
            const r = await api('POST', '/tasks', { as: bo, body: { text: 'Read the notes.', mode: 'repo', repo: 'https://github.com/octocat/Hello-World', attachments: [saved.id] } });
            assert.strictEqual(r.status, 201, r.text);
            attachedId = r.json().id;
            const linked = await t.ctx.store.db.many('SELECT id, task_id FROM codes_attachments WHERE task_id = $1', [attachedId]);
            assert.strictEqual(linked.length, 1);
            // The task's first turn carries the workspace path (the row keeps the person's own words).
            const submitted = calls.filter((c) => c[0] === 'submit').pop()[1];
            assert.ok(submitted.args.prompt.includes('.openvibe/attachments/') && submitted.args.prompt.includes('notes.txt'), 'the first message names the workspace path');
            assert.ok(Array.isArray(submitted.args.attachments) && submitted.args.attachments.length === 1, 'the file rides the job');
            const foreign = await api('POST', '/tasks', { as: bo, body: { text: 'Read it.', mode: 'repo', repo: 'https://github.com/o/r', attachments: ['att_123'] } });
            assert.strictEqual(foreign.status, 422, 'a foreign id names composer.attachment@1, not this task');
        });

        await check('multipart posts work too, and a program is refused before any task starts', async () => {
            const data = new FormData();
            data.append('text', 'Read the notes.');
            data.append('mode', 'repo');
            data.append('repo', 'https://github.com/octocat/Hello-World');
            data.append('files', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
            const before = calls.filter((c) => c[0] === 'submit').length;
            const r = await fetch(`${t.base}/api/v1/tasks`, { method: 'POST', headers: { cookie: t.signIn(bo) }, body: data });
            assert.strictEqual(r.status, 201, await r.text());
            assert.strictEqual(calls.filter((c) => c[0] === 'submit').length, before + 1);
            const bad = new FormData();
            bad.append('text', 'Run it.');
            bad.append('mode', 'repo');
            bad.append('repo', 'https://github.com/octocat/Hello-World');
            bad.append('files', new Blob(['MZ' + 'x'.repeat(10)], { type: 'application/x-msdownload' }), 'run.exe');
            const refused = await fetch(`${t.base}/api/v1/tasks`, { method: 'POST', headers: { cookie: t.signIn(bo) }, body: bad });
            assert.strictEqual(refused.status, 422);
            assert.strictEqual(calls.filter((c) => c[0] === 'submit').length, before + 1, 'a refused start reaches no machine');
        });

        await check('the list is the person\u2019s latest, running first, as codes.task-summary@1', async () => {
            readState = 'running';
            const row = await t.ctx.store.db.maybe('SELECT * FROM run_tasks WHERE id = $1', [firstId]);
            await t.ctx.tasks.refresh(row, { force: true });
            readState = 'queued';
            const list = await api('GET', '/me/tasks?limit=8', { as: ada });
            assert.strictEqual(list.status, 200);
            const tasks = list.json().tasks;
            assert.ok(tasks.length >= 2 && tasks.length <= 8, 'limit respected');
            assert.strictEqual(tasks[0].id, firstId, 'the running task lists first');
            assert.strictEqual(tasks[0].status, 'running');
            assert.ok(tasks.every((x) => x.mode === 'repo' || x.mode === 'openvibe'), 'every task names its mode');
            for (const s of tasks) assertSummary(s);
            const one = await api('GET', '/me/tasks?limit=1', { as: ada });
            assert.strictEqual(one.json().tasks.length, 1, '?limit= caps the list');
        });

        await check('statuses read in the Dock\u2019s words: done, failed, stopped', async () => {
            const r = await startRepo({ text: 'Another one.' }, { as: bo });
            const id = r.json().id;
            readState = 'succeeded';
            await t.ctx.tasks.refresh(await t.ctx.store.db.maybe('SELECT * FROM run_tasks WHERE id = $1', [id]), { force: true });
            readState = 'queued';
            const doneRow = (await api('GET', '/me/tasks?limit=50', { as: bo })).json().tasks.find((x) => x.id === id);
            assert.strictEqual(doneRow.status, 'done');
            const stop = await api('POST', `/tasks/${firstId}/stop`, { as: ada });
            assert.strictEqual(stop.status, 200, stop.text);
            assert.deepStrictEqual(stop.json(), { ok: true });
            const stopped = (await api('GET', '/me/tasks?limit=50', { as: ada })).json().tasks.find((x) => x.id === firstId);
            assert.strictEqual(stopped.status, 'stopped');
        });

        await check('a person cannot see or stop another\u2019s task', async () => {
            const list = await api('GET', '/me/tasks?limit=50', { as: bo });
            assert.ok(!list.json().tasks.some((x) => x.id === firstId), 'no foreign task in the list');
            assert.strictEqual((await api('GET', `/me/tasks/${firstId}`, { as: bo })).status, 404);
            assert.strictEqual((await api('POST', `/tasks/${firstId}/stop`, { as: bo })).status, 404);
            assert.strictEqual((await api('POST', '/tasks/tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T9/stop', { as: ada })).status, 404);
        });

        await check('the home reads ?prompt=, ?mode= and ?repo= and prefills its composer', async () => {
            const plain = await t.get('/', { as: ada });
            assert.strictEqual(plain.status, 200);
            assert.ok(plain.text.includes('data-ch-upload'), 'the shared upload picker');
            assert.ok(plain.text.includes('image/*'), 'images, text, code, PDF and zip');
            assert.ok(plain.text.includes('https://openvibe.media'), 'the person\u2019s OpenVibe files');
            assert.ok(plain.text.includes('Programs can\u2019t be attached'), 'the limits in the note');
            const pre = await t.get('/?prompt=' + encodeURIComponent('Make it faster') + '&mode=repo&repo=' + encodeURIComponent('octocat/Hello-World'), { as: ada });
            assert.ok(pre.text.includes('>Make it faster</textarea>'), 'the words are in the box');
            assert.ok(pre.text.includes('value="octocat/Hello-World"'), 'the repository is picked');
            assert.ok(/value="code"[^>]*checked|checked[^>]*value="code"/.test(pre.text), 'repo reads as My code');
            const create = await t.get('/?mode=create', { as: ada });
            assert.ok(/value="new"[^>]*checked|checked[^>]*value="new"/.test(create.text), 'create reads as Create');
        });

        await check('another router\u2019s preflight still ends at its own answer', async () => {
            const pre = await fetch(`${t.base}/api/v1/me/agent-view`, {
                method: 'OPTIONS', headers: { origin: 'https://openvibe.live' },
            });
            assert.strictEqual(pre.status, 204);
            assert.strictEqual(pre.headers.get('access-control-allow-origin'), '*', 'agent-view keeps its own wildcard');
        });

        await check('summarize maps rows to the contract: needs-you, old rows, titles', async () => {
            const base = { id: 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3', prompt: 'Fix it\n\nMore words.', repo: 'https://github.com/octocat/Hello-World', created_at: 1, updated_at: 2 };
            const [waiting] = summarize([{ ...base, state: 'running' }], { waitingIds: new Set([base.id]) });
            assert.strictEqual(waiting.status, 'needs-you');
            assert.strictEqual(waiting.steps, 0);
            const [live] = summarize([{ ...base, state: 'running' }], {});
            assert.strictEqual(live.status, 'running');
            const [old] = summarize([{ ...base, state: 'queued', mode: null }], { openvibeUrls: new Set(['https://github.com/OpenVibers/OpenVibe.Live']) });
            assert.strictEqual(old.mode, 'repo');
            assert.strictEqual(old.title, 'Fix it');
            const [ov] = summarize([{ ...base, state: 'queued', mode: null, repo: 'https://github.com/OpenVibers/OpenVibe.Live' }], { openvibeUrls: new Set(['https://github.com/OpenVibers/OpenVibe.Live']) });
            assert.strictEqual(ov.mode, 'openvibe');
            const [cond] = summarize([{ ...base, state: 'queued', kind: 'conductor', prompt: '', folder: '/home/you/work' }], {});
            assert.strictEqual(cond.title, 'Conductor \u00b7 work');
            const [pr] = summarize([{ ...base, state: 'succeeded', result: JSON.stringify({ ok: true, push: { pushed: true, pull_request: 'https://github.com/o/r/pull/1' } }) }], {});
            assert.strictEqual(pr.status, 'done');
            assert.strictEqual(pr.pr_url, 'https://github.com/o/r/pull/1');
        });
    } finally {
        await t.close();
    }

    // The quota: its own boot with the limiter counting, so the other checks stay uncounted.
    const q = await boot({ run, actorLimits: true });
    try {
        const cara = q.network.addUser('cara');
        await check('the start quota refuses the seventh task in a minute, before any work', async () => {
            const before = calls.filter((c) => c[0] === 'submit').length;
            for (let i = 0; i < 6; i++) {
                const r = await q.get('/api/v1/tasks', { as: cara, json: { text: `Task ${i}.`, mode: 'repo', repo: 'https://github.com/octocat/Hello-World' } });
                assert.strictEqual(r.status, 201, r.text);
            }
            const refused = await q.get('/api/v1/tasks', { as: cara, json: { text: 'One too many.', mode: 'repo', repo: 'https://github.com/octocat/Hello-World' } });
            assert.strictEqual(refused.status, 429);
            assert.strictEqual(refused.json().code, 'rate_limited');
            assert.strictEqual(calls.filter((c) => c[0] === 'submit').length - before, 6, 'the refused start reaches no machine');
        });
    } finally {
        await q.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
