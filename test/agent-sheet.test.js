'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const ada = t.network.addUser('ada');
    const ben = t.network.addUser('ben');
    const db = t.ctx.store.db;
    try {
        await db.exec(`INSERT INTO run_tasks (id, subject, project_id, repo, prompt, agent, state, created_at, updated_at)
            VALUES ('tsk_00000000000000000000000001', $1, 'prj_00000000000000000000000001',
            'https://github.com/example/example', 'Repair the build', 'codex', 'succeeded', 1000, 1000)`, [ada.subject]);
        await db.exec(`INSERT INTO codes_attempts (id, task_id, n, agent, state, kind, cost_usd, why, created_at)
            VALUES ('att_00000000000000000000000001', 'tsk_00000000000000000000000001', 1,
            'codex', 'done', 'first', 0.25, 'Fixed the failing check', now())`);
        await check('one owner read has the coding agent and its real attempt', async () => {
            const r = await t.get('/api/v1/me/agents/codex/sheet', { as: ada });
            assert.strictEqual(r.status, 200, r.text);
            const sheet = r.json();
            assert.strictEqual(sheet.agent.id, 'codex');
            assert.strictEqual(sheet.work.length, 1);
            assert.strictEqual(sheet.work[0].cost_usd, 0.25);
            assert.strictEqual(sheet.activity[0].entries[0].what, 'Fixed the failing check');
            assert.match(sheet.activity[0].day, /^\d{4}-\d{2}-\d{2}$/);
            assert.deepStrictEqual(sheet.memory, []);
            assert.deepStrictEqual(sheet.schedules, []);
            assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        });
        await check('a different owner and a signed-out caller see no work', async () => {
            const other = await t.get('/api/v1/me/agents/codex/sheet', { as: ben });
            assert.strictEqual(other.status, 200);
            assert.deepStrictEqual(other.json().work, []);
            assert.strictEqual((await t.get('/api/v1/me/agents/codex/sheet')).status, 401);
            assert.strictEqual((await t.get('/api/v1/me/agents/unknown-agent/sheet', { as: ada })).status, 404);
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
