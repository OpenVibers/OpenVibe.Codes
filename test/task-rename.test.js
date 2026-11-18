'use strict';
// Rename (plan §AD.8, the session's ⋯ menu): the person names their task and its list, page and summary say the name;
// an empty name gives it back the brief's first line; nobody else renames it.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { titleOf } = require('../server/domain/task-summary');

(async () => {
    const t = await boot();
    const ada = t.network.addUser('rename-ada');
    const bo = t.network.addUser('rename-bo');
    const db = t.ctx.store.db;
    const TASK = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5RN1';
    try {
        await db.exec(`INSERT INTO run_tasks (id, subject, project_id, repo, ref, prompt, agent, state, result, created_at, updated_at) VALUES
            ($1, $2, 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAW', 'https://github.com/a/b', 'main', '# Make the footer quieter\\nand smaller', 'codex', 'succeeded', '{}'::jsonb, $3, $3)`,
        [TASK, ada.subject, Date.now() - 60_000]);

        await check('the title is the brief\'s first line until it is named', async () => {
            assert.strictEqual(titleOf({ prompt: '# Make the footer quieter\nand smaller' }), 'Make the footer quieter');
            assert.strictEqual(titleOf({ prompt: 'x', title: '  Footer   work ' }), 'Footer work');
        });

        await check('the person names it; the page and the list say the name', async () => {
            const bearer = t.network.userToken(ada);
            const r = await t.get(`/api/v1/tasks/${TASK}`, { bearer, method: 'PATCH', json: { title: 'Footer work' } });
            assert.strictEqual(r.status, 200, r.text);
            const page = await t.get(`/tasks/${TASK}`, { as: ada });
            assert.ok(page.text.includes('Footer work'), 'the conversation page says the name');
            const list = await t.get('/api/v1/me/tasks', { bearer });   // the list the Frame reads
            assert.ok(list.text.includes('Footer work'), 'the list says the name');
        });

        await check('nobody else renames it, and a name must be words', async () => {
            const other = await t.get(`/api/v1/tasks/${TASK}`, { bearer: t.network.userToken(bo), method: 'PATCH', json: { title: 'Mine' } });
            assert.strictEqual(other.status, 404);
            const bad = await t.get(`/api/v1/tasks/${TASK}`, { bearer: t.network.userToken(ada), method: 'PATCH', json: { title: 7 } });
            assert.strictEqual(bad.status, 422);
        });

        await check('an empty name gives it back the brief\'s first line', async () => {
            const r = await t.get(`/api/v1/tasks/${TASK}`, { bearer: t.network.userToken(ada), method: 'PATCH', json: { title: '' } });
            assert.strictEqual(r.status, 200);
            assert.strictEqual((await db.one('SELECT title FROM run_tasks WHERE id = $1', [TASK])).title, null);
            const page = await t.get(`/tasks/${TASK}`, { as: ada });
            assert.ok(page.text.includes('Make the footer quieter'));
        });
    } finally {
        await done(t);
    }
})();
