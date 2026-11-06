'use strict';
/**
 * Sharing a run task (design 2026-11-06, visibility step 2): the one Share sheet (openvibe-sdk/share) and the one
 * check, canView, on the task page, its live stream and session.json.
 *
 *   - a new task is Only me; the Share button is the owner's;
 *   - Anyone with the link reads the page and the session, without Cancel;
 *   - Specific people shows the gate, never the task's text, to somebody not on the list;
 *   - the person's default for new tasks, and "apply to all", work.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const run = {
        enabled: true,
        async submit() { return { id: 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J1', state: 'queued' }; },
        async read(jobId) { return { id: jobId, state: 'succeeded', result: { ok: true, summary: 'The typo is fixed.', files: [], agents: ['claude-code'] }, error: null }; },
        async cancel(jobId) { return { id: jobId, state: 'cancelled' }; },
        async streamUrl() { return 'http://127.0.0.1:1/stream'; },
    };
    const t = await boot({ run });
    const ada = t.network.addUser('ada');
    const bo = t.network.addUser('bo');
    const cy = t.network.addUser('cy');
    const post = (p, as, form, headers = {}) => t.get(p, { as, form, headers, method: 'POST' });

    const call = (pathname, o = {}) => {
        const { headers, ...rest } = o;
        return t.get(pathname, { ...rest, headers: { 'x-requested-with': 'ov-share', ...(headers || {}) } });
    };
    const share = (id, o = {}) => call(`/api/v1/task/${encodeURIComponent(id)}/share`, o);
    const setShare = async (id, body, as) => {
        const first = await share(id, { as });
        assert.strictEqual(first.status, 200, first.text);
        const etag = first.headers.get('etag');
        assert.ok(etag);
        return await share(id, { as, method: 'PUT', json: body, headers: { 'if-match': etag } });
    };
    const audienceRow = async (id) => await t.ctx.store.db.maybe(
        'SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', ['codes', 'task', id]);

    try {
        let project;
        await check('a project first, so a task can be started', async () => {
            const made = await post('/run/project', ada, { name: 'My code', prompt: 'Fix the typo', repo: 'https://github.com/OpenVibers/OpenVibe.Codes' });
            assert.strictEqual(made.status, 303, made.text);
            const page = await t.get(made.headers.get('location'), { as: ada });
            project = /<option value="(prj_[0-9A-Z]{26})"/.exec(page.text)[1];
            assert.ok(project);
        });

        let taskId;
        await check('a new task is Only me, and its page carries the Share button for its owner', async () => {
            const started = await post('/run', ada, { repo: 'https://github.com/OpenVibers/OpenVibe.Codes', prompt: 'Fix the typo in README', project });
            assert.strictEqual(started.status, 303, started.text);
            taskId = /\/run\/tasks\/(tsk_[0-9A-Z]{26})$/.exec(started.headers.get('location'))[1];
            assert.deepStrictEqual(await audienceRow(taskId), { audience: 'private' });
            const mine = await t.get(`/run/tasks/${taskId}`, { as: ada });
            assert.strictEqual(mine.status, 200, mine.text);
            assert.ok(mine.text.includes('data-ov-share-sheet') && mine.text.includes('data-kind="task"'));
            assert.ok(mine.text.includes('ov-share.js'));
            assert.ok(mine.text.includes('Cancel'));
            const other = await t.get(`/run/tasks/${taskId}`, { as: bo });
            assert.strictEqual(other.status, 404);
            assert.ok(!other.text.includes('Fix the typo in README'), 'the task is never named to somebody else');
            const guest = await t.get(`/run/tasks/${taskId}`);
            assert.strictEqual(guest.status, 404);
        });

        await check('Anyone with the link reads the page and the session, and cannot Cancel', async () => {
            const saved = await setShare(taskId, { audience: 'link' }, ada);
            assert.strictEqual(saved.status, 200, saved.text);
            assert.strictEqual(saved.json().audience, 'link');
            const guest = await t.get(`/run/tasks/${taskId}`);
            assert.strictEqual(guest.status, 200, guest.text);
            assert.ok(guest.text.includes('Fix the typo in README'));
            assert.ok(guest.text.includes('This task was shared with you'));
            assert.ok(!guest.text.includes('action="/run/tasks/' + taskId + '/cancel"'), 'no Cancel for a reader');
            const replay = await t.get(`/run/tasks/${taskId}/session.json`, { as: bo });
            assert.strictEqual(replay.status, 200, replay.text);
            assert.ok(Array.isArray(replay.json().lines));
        });

        await check('Specific people: on the list reads it, a stranger gets the gate and no text', async () => {
            const saved = await setShare(taskId, { audience: 'people', members: [{ name: 'bo', role: 'viewer' }] }, ada);
            assert.strictEqual(saved.status, 200, saved.text);
            assert.strictEqual(saved.json().audience, 'people');
            const member = await t.get(`/run/tasks/${taskId}`, { as: bo });
            assert.strictEqual(member.status, 200, member.text);
            assert.ok(member.text.includes('Fix the typo in README'));
            const stranger = await t.get(`/run/tasks/${taskId}`, { as: cy });
            assert.strictEqual(stranger.status, 404);
            assert.ok(stranger.text.includes('shared with specific people'));
            assert.ok(!stranger.text.includes('Fix the typo in README'));
            const replay = await t.get(`/run/tasks/${taskId}/session.json`, { as: cy });
            assert.strictEqual(replay.status, 404);
        });

        await check('the default applies to the next task, and "apply to all" moves the existing one', async () => {
            const saved = await post('/run/defaults', ada, { audience: 'public', apply_all: '1' });
            assert.strictEqual(saved.status, 303, saved.text);
            assert.deepStrictEqual(await audienceRow(taskId), { audience: 'public' });
            const guest = await t.get(`/run/tasks/${taskId}`);
            assert.strictEqual(guest.status, 200);
            const next = await post('/run', ada, { repo: 'https://github.com/OpenVibers/OpenVibe.Codes', prompt: 'Add a test', project });
            const nextId = /\/run\/tasks\/(tsk_[0-9A-Z]{26})$/.exec(next.headers.get('location'))[1];
            assert.deepStrictEqual(await audienceRow(nextId), { audience: 'public' });
            const start = await t.get('/run', { as: ada });
            assert.ok(start.text.includes('New tasks'), 'the default is on the product page');
        });
    } finally {
        await t.close();
        done();
    }
})();
