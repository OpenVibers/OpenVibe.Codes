'use strict';

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const ada = t.network.addUser('c4-ada');
    try {
        await check('all C4 pages render readable server content without JavaScript', async () => {
            for (const [path, label] of [['/', 'What should an agent do?'], ['/tasks', 'Tasks'], ['/agents', 'Agents'], ['/machines', 'Machines'], ['/usage', 'Usage'], ['/settings', 'Settings']]) {
                const r = await t.get(path);
                assert.strictEqual(r.status, 200, `${path} status`);
                assert.ok(r.text.includes(label), `${path} content`);
                assert.ok(r.text.includes('c4-mobile'), `${path} workspace navigation`);
            }
            const task = await t.get('/tasks/tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV');
            assert.strictEqual(task.status, 200);
            assert.ok(task.text.includes('Sign in to see your work'));
        });

        await check('task details are owner scoped and management pages honor sign-in', async () => {
            const settings = await t.get('/settings', { as: ada });
            assert.strictEqual(settings.status, 200);
            assert.ok(settings.text.includes('Safety'));
            assert.strictEqual((settings.text.match(/Arrives with connections\./g) || []).length, 1);
            assert.ok(!settings.text.includes('Sign in to see your work'));
            const hidden = await t.get('/tasks/tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV', { as: ada });
            assert.strictEqual(hidden.status, 404);
        });

        await check('signed-in workspace and task details use the reviewed layout', async () => {
            const home = await t.get('/', { as: ada });
            assert.ok(!home.text.includes('Built for the way you work'));
            assert.ok(!home.text.includes('Recently shipped on'));
            assert.ok(!home.text.includes('OPENVIBE.CODES'));
            assert.ok(!home.text.includes('Your coding workspace'));
            assert.ok(home.text.includes('Paste a repository URL'));
            const id = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV';
            await t.ctx.store.db.exec(`INSERT INTO run_tasks (id, subject, project_id, repo, ref, prompt, agent, state, result, error, created_at, updated_at)
                VALUES ($1,$2,'prj_01ARZ3NDEKTSV4RRFFQ69G5FAW','https://github.com/OpenVibers/OpenVibe.Codes','main','Fix the full brief and keep the workspace readable on a phone','codex','failed','{"cost":0.42}'::jsonb,'The machine stopped.',$3,$3)`, [id, ada.subject, Date.now()]);
            const task = await t.get(`/tasks/${id}`, { as: ada });
            assert.strictEqual(task.status, 200);
            assert.ok(task.text.includes('Show the whole brief'));
            assert.ok(task.text.includes('aria-selected="true" data-c4-tab="live"'));
            assert.ok(task.text.includes('Retry') && task.text.includes('Switch') && task.text.includes('Fine'));
            assert.ok(task.text.includes('data-task-api="/api/v1/tasks/' + id + '"'));
            assert.ok(task.text.includes('data-c4-stream="/api/v1/tasks/' + id + '/events"'));
            assert.ok(!task.text.includes('Continue or switch agent in Run'));
            assert.ok(!task.text.includes('>Stop task</button>'));
            assert.ok(!task.text.includes('<pre class="c4-log" aria-live="polite"></pre>'));
            assert.ok(task.text.includes('>OpenVibe.Codes</a>'));
            assert.ok(!task.text.includes('>https://github.com/'));
            assert.ok(!task.text.includes('<details open id="live"'));
            assert.ok(!task.text.includes('<details id="changes"'));
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
