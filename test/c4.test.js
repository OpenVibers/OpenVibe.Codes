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
            assert.ok(task.text.includes('Sign in to see this task'));
        });

        await check('task details are owner scoped and management pages honor sign-in', async () => {
            const settings = await t.get('/settings', { as: ada });
            assert.strictEqual(settings.status, 200);
            assert.ok(settings.text.includes('Safety'));
            assert.ok(!settings.text.includes('Sign in to see your work'));
            const hidden = await t.get('/tasks/tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV', { as: ada });
            assert.strictEqual(hidden.status, 404);
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
