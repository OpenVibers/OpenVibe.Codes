'use strict';
/**
 * Run on your machine (server/http/run.js, plan T16): a guest is asked to sign in; a person with no project they may
 * run jobs in creates one; a task is checked like the job runner checks it, recorded, and started as an OpenVibe Run job
 * for that person in their project (the task id is the idempotency key); its page streams the job's lines through
 * Codes and then shows the summary, the changed files and the patch; another person never sees it; cancelling reaches
 * Run; a form posted from another site is refused.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    // A stand-in OpenVibe.Run: what Codes asked, and the job each read answers.
    const calls = [];
    let state = 'queued';
    let result = null;
    let failSubmit = null;
    const sse = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: output\nid: 1\ndata: {"type":"output","seq":1,"chunk":"{\\"t\\":\\"step\\",\\"text\\":\\"Cloning\\"}\\n"}\n\n');
        res.end('event: end\nid: 2\ndata: {"type":"end","seq":2,"state":"succeeded"}\n\n');
    });
    await new Promise((ok) => sse.listen(0, '127.0.0.1', ok));
    const run = {
        enabled: true,
        async submit(o) { calls.push(['submit', o]); if (failSubmit) throw failSubmit; return { id: 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J1', state: 'queued' }; },
        async read(jobId, who) { calls.push(['read', jobId, who]); return { id: jobId, state, result, error: state === 'failed' ? { code: 'run.job.worker_failed', detail: 'the machine went away' } : null }; },
        async cancel(jobId, who) { calls.push(['cancel', jobId, who]); return { id: jobId, state: 'cancelled' }; },
        async streamUrl(jobId, who) { calls.push(['stream', jobId, who]); return `http://127.0.0.1:${sse.address().port}/stream`; },
    };
    const t = await boot({ run });
    const ada = t.network.addUser('ada');
    const bo = t.network.addUser('bo');
    const post = (p, as, form, headers = {}) => t.get(p, { as, form, headers, method: 'POST' });

    await check('a guest is told what it is and asked to sign in', async () => {
        const r = await t.get('/run');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('Run a coding task on your own machine') && r.text.includes('/auth/login?next=%2Frun') && r.text.includes('openvibe.bot/machines'));
    });

    let project;
    await check('with no project to run in, the person creates one first', async () => {
        const first = await t.get('/run', { as: ada });
        assert.ok(first.text.includes('One thing first: a project') && !first.text.includes('name="repo"'));
        assert.strictEqual((await post('/run/project', ada, { name: 'My code' }, { origin: 'https://evil.example' })).status, 403, 'cross-site');
        const made = await post('/run/project', ada, { name: 'My code' });
        assert.strictEqual(made.status, 303);
        const page = await t.get('/run', { as: ada });
        assert.ok(page.text.includes('name="repo"') && page.text.includes('My code'), page.text.slice(0, 400));
        project = /<option value="(prj_[0-9A-Z]{26})"/.exec(page.text)[1];
    });

    let taskId;
    await check('a task is checked like the runner checks it, then started as a Run job for that person', async () => {
        const bad = await post('/run', ada, { repo: 'http://github.com/a/b', prompt: 'x', project });
        assert.strictEqual(bad.status, 422);
        assert.ok(bad.text.includes('https'));
        assert.strictEqual(calls.length, 0, 'nothing was started');
        assert.strictEqual((await post('/run', ada, { repo: 'https://github.com/a/b', prompt: 'x', project }, { origin: 'https://evil.example' })).status, 403);
        const other = await post('/run', ada, { repo: 'https://github.com/a/b', prompt: 'x', project: 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P9' });
        assert.strictEqual(other.status, 422, 'only one of the person’s own projects');
        const ok = await post('/run', ada, { repo: 'https://github.com/OpenVibers/OpenVibe.Codes', ref: 'main', prompt: 'Fix the typo in README', agent: 'claude-code', project, push: '1', pull_request: '1' });
        assert.strictEqual(ok.status, 303, ok.text);
        taskId = /\/run\/tasks\/(tsk_[0-9A-Z]{26})$/.exec(ok.headers.get('location'))[1];
        const [kind, sent] = calls.find((c) => c[0] === 'submit');
        assert.strictEqual(kind, 'submit');
        assert.deepStrictEqual([sent.subject, sent.project, sent.key], [ada.subject, project, taskId]);
        assert.deepStrictEqual(sent.args, { repo: 'https://github.com/OpenVibers/OpenVibe.Codes', ref: 'main', prompt: 'Fix the typo in README', permission: 'edit', push: { branch: null, pull_request: true }, agent: 'claude-code', model: null });
        const row = await t.ctx.store.db.one('SELECT subject, project_id, job_id, state FROM run_tasks WHERE id = $1', [taskId]);
        assert.deepStrictEqual({ ...row }, { subject: ada.subject, project_id: project, job_id: 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J1', state: 'queued' });
    });

    await check('its page is its owner’s: live lines through Codes while it runs, the result after', async () => {
        assert.strictEqual((await t.get(`/run/tasks/${taskId}`, { as: bo })).status, 404, 'another person');
        const live = await t.get(`/run/tasks/${taskId}`, { as: ada });
        assert.ok(live.text.includes(`data-events="/run/tasks/${taskId}/events"`) && live.text.includes('Waiting for your machine'));
        const events = await t.get(`/run/tasks/${taskId}/events`, { as: ada });
        assert.strictEqual(events.status, 200);
        assert.match(events.headers.get('content-type'), /text\/event-stream/);
        assert.ok(events.text.includes('Cloning') && events.text.includes('event: end'));
        assert.strictEqual((await t.get(`/run/tasks/${taskId}/events`, { as: bo })).status, 404);
        const stream = calls.find((c) => c[0] === 'stream');
        assert.deepStrictEqual(stream[2], { subject: ada.subject, project });
        state = 'succeeded';
        result = { protocol: '1.0.0', lines: '1.1', log: [{ t: 'agent', agent: 'claude-code' }, { t: 'text', text: 'I fix <b>it</b></script>' }, { t: 'tool', id: 'e1', name: 'Edit', input: { file_path: 'README.md', old_string: 'teh', new_string: 'the' } }, { t: 'tool_result', id: 'e1', ok: true, output: 'ok' }, { t: 'mystery', x: 1 }, { t: 'done', ok: true, text: 'Fixed', duration_ms: 900 }], ok: true, agents: ['claude-code'], summary: 'Fixed <the> typo', files: [{ path: 'README.md', added: 1, removed: 1 }], patch: '@@ -1 +1 @@\n-teh\n+the\n', patch_truncated: false, push: { pushed: true, branch: 'openvibe-codes/x', branch_url: 'https://github.com/OpenVibers/OpenVibe.Codes/tree/openvibe-codes%2Fx', pull_request: 'https://github.com/OpenVibers/OpenVibe.Codes/pull/9' }, duration_ms: 42000 };
        const done_ = await t.get(`/run/tasks/${taskId}`, { as: ada });
        // With the session on the page, its closing card says how it ended and what the agents said: the page does not repeat it.
        assert.ok(!done_.text.includes('The agents finished the task') && !done_.text.includes('What the agent said') && done_.text.includes('README.md'));
        assert.ok(done_.text.includes('pull/9') && done_.text.includes('data-patch') && !done_.text.includes('data-events'));
        // The session the result kept, for openvibe-shared/agent-session.js: known lines only, and nothing in them can end
        // the page's script early.
        assert.ok(done_.text.includes('data-session') && /<script src="[^"]*agent-session\.js[^"]*" defer>/.test(done_.text), 'the session and the component');
        const kept = JSON.parse(/<script type="application\/json" data-session-log>([\s\S]*?)<\/script>/.exec(done_.text)[1]);
        assert.deepStrictEqual(kept.map((l) => l.t), ['agent', 'text', 'tool', 'tool_result', 'done'], 'lines of an unknown kind are left out');
        assert.ok(!/<\/script>I|<b>it/.test(/data-session-log>([\s\S]*?)<\/script>/.exec(done_.text)[1]), 'no markup inside the data');
        assert.strictEqual(kept[1].text, 'I fix <b>it</b></script>', 'and the text reads back as it was');
        const api = await t.get(`/api/v1/tasks/${taskId}`, { as: ada });
        if (api.status === 200) assert.ok(!('log' in ((api.json && api.json.result) || {})), 'the task API passes codes.task@1\'s fields only');
        const row = await t.ctx.store.db.one('SELECT state, result FROM run_tasks WHERE id = $1', [taskId]);
        assert.strictEqual(row.state, 'succeeded');
        assert.strictEqual(row.result.summary, 'Fixed <the> typo');
        const list = await t.get('/run', { as: ada });
        assert.ok(list.text.includes(`/run/tasks/${taskId}`) && list.text.includes('Finished'));
    });

    await check('cancel reaches Run for a running task; a Run refusal at start leaves a failed task that says why', async () => {
        state = 'running';
        result = null;
        const ok = await post('/run', ada, { repo: 'https://github.com/a/b', prompt: 'Long task', project });
        const id = /tsk_[0-9A-Z]{26}/.exec(ok.headers.get('location'))[0];
        await t.ctx.store.db.exec("UPDATE run_tasks SET job_id = 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J2' WHERE id = $1", [id]);
        assert.strictEqual((await post(`/run/tasks/${id}/cancel`, bo, {})).status, 404);
        const c = await post(`/run/tasks/${id}/cancel`, ada, {});
        assert.strictEqual(c.status, 303);
        assert.ok(calls.some((x) => x[0] === 'cancel' && x[1] === 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J2'));
        const { RunError } = require('../server/domain/run-client');
        failSubmit = new RunError(403, 'project.not_delegated', 'not an admin of that project');
        const refused = await post('/run', ada, { repo: 'https://github.com/a/b', prompt: 'x', project });
        const rid = /tsk_[0-9A-Z]{26}/.exec(refused.headers.get('location'))[0];
        state = 'failed';
        const page = await t.get(`/run/tasks/${rid}`, { as: ada });
        assert.ok(page.text.includes('project.not_delegated'), page.text.slice(-800));
    });

    await t.close();
    sse.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
