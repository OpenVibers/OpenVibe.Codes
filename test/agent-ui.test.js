'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { createSessionLines } = require('../server/domain/session-lines');
const { createMapper, initial } = require('../server/agent-ui/mapper');
const { clean } = require('../server/agent-ui/codes');
(async () => {
    await check('table titles, source titles, long result and redaction', async () => {
        const s = initial('run', 'codes', '2026-11-11T00:00:00Z'), m = createMapper(s, { clean });
        await m.push({ t: 'tool', id: 'search', name: 'WebSearch', input: { query: 'AG-UI events' } }, 1);
        await m.push({ t: 'tool_result', id: 'search', output: JSON.stringify({ results: [{ url: 'https://docs.ag-ui.com/', title: 'AG-UI' }, { url: 'https://docs.ag-ui.com/', title: 'AG-UI' }] }) }, 2);
        assert.equal(s.steps[0].title, 'Searched the web for AG-UI events');
        assert.deepEqual(s.sources, [{ url: 'https://docs.ag-ui.com/', title: 'AG-UI', site: 'docs.ag-ui.com' }]);
        const value = clean({ password: 'not-a-real-password', text: 'Bearer ' + 'x'.repeat(30) });
        assert.equal(value.password, '[redacted]');
        let calls = 0;
        const unknown = createMapper(s, { clean, fallback: async () => { calls++; return 'Checked the project'; } });
        await unknown.push({ t: 'tool', id: 'x', name: 'custom_action', input: { path: 'src' } }, 3);
        await unknown.push({ t: 'tool', id: 'y', name: 'custom_action', input: { path: 'src' } }, 4);
        assert.equal(calls, 1);
    });
    const t = await boot({ env: { CODES_AGENT_UI: '1' } });
    try {
        const owner = t.network.addUser('agui-owner'), other = t.network.addUser('agui-other');
        const id = 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T1';
        await t.ctx.store.db.exec(`INSERT INTO run_tasks (id, subject, project_id, job_id, repo, prompt, state, created_at, updated_at)
            VALUES ($1, $2, 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1', 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z200', 'https://github.com/a/b', 'test', 'succeeded', 1, 2)`, [id, owner.subject]);
        const lines = createSessionLines({ store: t.ctx.store, config: t.config });
        await lines.append(id, [
            { seq: 1, body: { t: 'tool', id: 'r1', name: 'Read', input: { file_path: 'server/auth/handoff.js' } } },
            { seq: 2, body: { t: 'tool_result', id: 'r1', output: 'summary', full_output: 'line\n'.repeat(15000) } },
            { seq: 3, body: { t: 'done', ok: true, text: 'Finished.' } },
        ]);
        await t.ctx.store.db.exec("UPDATE run_tasks SET via = 'service:actor' WHERE id = $1", [id]);
        await check('snapshot access matches tasks, full output persists, replay is exact', async () => {
            const snapshot = await t.get(`/api/v1/runs/${id}`, { as: owner });
            assert.equal(snapshot.status, 200, snapshot.text);
            assert.equal(snapshot.json().steps[0].title, 'Read server/auth/handoff.js');
            assert.equal((await t.get(`/api/v1/runs/${id}`, { as: other })).status, 404);
            assert.equal((await t.get(`/api/v1/runs/${id}/events`, { as: other })).status, 404);
            assert.equal((await t.get(`/api/v1/runs/${id}`)).status, 401);
            const a = await t.get(`/api/v1/runs/${id}/events`, { as: owner });
            const frames = a.text.split('\n\n').filter((s) => s.startsWith('id:'));
            const events = frames.map((s) => JSON.parse(s.split('\ndata: ')[1]));
            assert.equal(events[0].type, 'RUN_STARTED');
            assert.equal(events.at(-1).type, 'RUN_FINISHED');
            assert.equal(events.find((e) => e.type === 'TOOL_CALL_RESULT').content.length, 75000);
            const ids = frames.map((s) => Number(s.match(/^id: (\d+)/)[1]));
            const after = ids[3];
            const b = await t.get(`/api/v1/runs/${id}/events`, { as: owner, headers: { 'Last-Event-ID': String(after) } });
            assert.deepEqual([...b.text.matchAll(/^id: (\d+)$/gm)].map((m) => +m[1]), ids.filter((n) => n > after));
            const c = await t.get(`/api/v1/runs/${id}/events`, { as: owner });
            assert.equal(c.text, a.text);
        });
        await check('existing service scopes and shared-reader grants also govern runs', async () => {
            const service = t.network.mintService('svc:actor', 'openvibe.codes', ['codes.task.read']);
            const headers = { 'X-OV-Subject': owner.subject };
            assert.equal((await t.get(`/api/v1/runs/${id}`, { bearer: service, headers })).status, 200);
            const wrong = t.network.mintService('svc:chat', 'openvibe.codes', ['codes.task.read']);
            assert.equal((await t.get(`/api/v1/runs/${id}`, { bearer: wrong, headers })).status, 404);
            await require('../server/sharing').createSharing({ db: t.ctx.store.db, config: t.config }).register({ subject: owner.subject }, id);
            const sharePath = `/api/v1/task/${id}/share`;
            const first = await t.get(sharePath, { as: owner, headers: { 'x-requested-with': 'ov-share' } });
            const saved = await t.get(sharePath, { as: owner, method: 'PUT', json: { audience: 'link' }, headers: { 'x-requested-with': 'ov-share', 'if-match': first.headers.get('etag') } });
            assert.equal(saved.status, 200, saved.text);
            assert.equal((await t.get(`/api/v1/runs/${id}`, { as: other })).status, 200);
            assert.equal((await t.get(`/api/v1/runs/${id}/events`, { as: other })).status, 200);
            assert.equal((await t.get(`/api/v1/runs/${id}`, { bearer: wrong, headers })).status, 404);
        });
        await check('owner switch hides both endpoints', async () => {
            t.config.agentUi = false;
            t.config.agentUiSetting = () => false;
            assert.equal((await t.get(`/api/v1/runs/${id}`, { as: owner })).status, 404);
            assert.equal((await t.get(`/api/v1/runs/${id}/events`, { as: owner })).status, 404);
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
