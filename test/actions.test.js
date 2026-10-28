'use strict';
/**
 * Codes' Action Center read (plan 2026-10-28 §3.10, common.action-list-result@1): a first-party service with
 * codes.actions.read names one person and gets their coding tasks, never another person's — running first-class,
 * done and failed from the last 30 days only, newest first, at most 50, plain text, https links and the right
 * actions. A person's token, a service without the capability and a bad subject are refused.
 */
const assert = require('assert');
const crypto = require('crypto');
const { ids, serviceAuth, validate } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const items = require('../server/actions/items');

const DAY = 86_400_000;

(async () => {
    const run = { enabled: true, async submit() { throw new Error('not used'); }, async read() { throw new Error('not used'); }, async cancel() { throw new Error('not used'); }, async streamUrl() { throw new Error('not used'); } };
    const t = await boot({ run });
    try {
        const ada = t.network.addUser('ada');
        const bo = t.network.addUser('bo');
        const now = Date.now();
        const token = (cap = ['codes.actions.read'], sub = 'svc:network') => {
            const at = Math.floor(now / 1000);
            return serviceAuth.signServiceToken({ iss: t.network.url, sub, actor_type: 'service', aud: ['openvibe.codes'], cap, iat: at, exp: at + 300, jti: crypto.randomUUID() }, t.network.privatePem);
        };
        const reader = token();
        const db = t.ctx.store.db;
        const project = ids.newId('project');

        async function addTask({ subject = ada.subject, state = 'queued', created = now, updated = created, prompt = 'Fix the bug', result = null, error = null, id = ids.newId('task') }) {
            await db.query(`INSERT INTO run_tasks (id, subject, project_id, repo, prompt, agent, state, result, error, created_at, updated_at)
                VALUES ($1,$2,$3,'https://github.com/ada/site',$4,'deepseek',$5,$6::jsonb,$7,$8,$9)`,
            [id, subject, project, prompt, state, result == null ? null : JSON.stringify(result), error, created, updated]);
            return id;
        }

        await check('the state → bucket table and the actions each bucket allows', async () => {
            const table = [['queued', 'running'], ['placed', 'running'], ['running', 'running'], ['succeeded', 'done'], ['failed', 'failed'], ['cancelled', 'failed'], ['expired', 'failed']];
            for (const [state, bucket] of table) assert.strictEqual(items.bucketFor(state), bucket, state);
            assert.deepStrictEqual(items.actionsFor('running'), ['open', 'cancel']);
            for (const bucket of ['done', 'failed', 'waiting', 'scheduled']) assert.deepStrictEqual(items.actionsFor(bucket), ['open']);
            assert.strictEqual(items.plain('<b>Fix</b> **the** [bug](https://x) &amp; ship', 160), 'Fix the bug & ship');
            assert.ok(items.plain('x'.repeat(500), 400).length <= 400);
        });

        const queuedOld = ids.newId('task');
        const running = ids.newId('task');
        const doneId = ids.newId('task');
        const failedId = ids.newId('task');
        const cancelledId = ids.newId('task');
        const expiredId = ids.newId('task');
        const oldId = ids.newId('task');
        const theirsId = ids.newId('task');

        await check('only that person\'s tasks, newest first, with the buckets, actions, text and links common.action-item@1 allows', async () => {
            await addTask({ id: queuedOld, state: 'queued', created: now - 40 * DAY, prompt: 'Still waiting' });
            await addTask({ id: running, state: 'running', created: now - 2 * 3600_000, prompt: '# Running **now**' });
            await addTask({ id: doneId, state: 'succeeded', created: now - 2 * DAY, updated: now - DAY, prompt: '<b>Fix</b> **the** [bug](https://example.com)', result: { ok: true, agents: ['deepseek'], summary: '<p>All **done** &amp; shipped.</p>', cost_usd: 0.0011, files: [{ path: 'a.js', added: 1, removed: 0 }], log: [{ t: 'tool' }, { t: 'text' }, { t: 'tool' }] } });
            await addTask({ id: failedId, state: 'failed', created: now - 4 * DAY, updated: now - 3 * DAY, prompt: 'Broken task', error: '<script>it broke</script>', result: { ok: false, error: 'the machine ran out of room', log: [{ t: 'tool' }] } });
            await addTask({ id: cancelledId, state: 'cancelled', created: now - 5 * DAY, updated: now - 4 * DAY, prompt: 'Stopped task' });
            await addTask({ id: expiredId, state: 'expired', created: now - 6 * DAY, updated: now - 5 * DAY, prompt: 'Expired task' });
            await addTask({ id: oldId, state: 'succeeded', created: now - 45 * DAY, updated: now - 40 * DAY, prompt: 'Ancient' });
            await addTask({ id: theirsId, subject: bo.subject, state: 'running', created: now - 60_000, prompt: 'Bo\'s task' });

            const res = await t.get(`/api/v1/actions?subject=${ada.subject}`, { headers: { Authorization: `Bearer ${reader}` } });
            assert.strictEqual(res.status, 200, res.text);
            const body = res.json();
            const v = validate('common.action-list-result@1', body);
            assert.ok(v.valid, JSON.stringify(v.errors));
            const byId = new Map(body.items.map((i) => [i.id, i]));
            assert.deepStrictEqual([byId.get(queuedOld).bucket, byId.get(queuedOld).actions], ['running', ['open', 'cancel']], 'an old queued task still runs');
            assert.deepStrictEqual([byId.get(running).bucket, byId.get(running).actions], ['running', ['open', 'cancel']]);
            assert.deepStrictEqual([byId.get(doneId).bucket, byId.get(doneId).cost_usd, byId.get(doneId).steps, byId.get(doneId).actions], ['done', 0.0011, 2, ['open']]);
            assert.strictEqual(byId.get(doneId).title, 'Fix the bug');
            assert.strictEqual(byId.get(doneId).summary, 'All done & shipped.');
            assert.strictEqual(byId.get(doneId).agent, 'deepseek');
            assert.strictEqual(byId.get(failedId).bucket, 'failed');
            assert.strictEqual(byId.get(failedId).error, 'it broke');
            assert.strictEqual(byId.get(failedId).steps, 1);
            assert.strictEqual(byId.get(failedId).actions[0], 'open');
            assert.ok(!byId.get(failedId).actions.includes('retry'), 'Codes has no retry route');
            assert.deepStrictEqual([byId.get(cancelledId).bucket, byId.get(expiredId).bucket], ['failed', 'failed']);
            assert.ok(!byId.has(oldId), 'done and failed older than 30 days are gone');
            assert.ok(!byId.has(theirsId), 'never another person\'s task');
            for (const it of body.items) {
                assert.match(it.href, /^https:\/\//);
                assert.strictEqual(it.href, `https://openvibe.codes/run/tasks/${it.id}`);
                assert.ok(it.title.length <= 160 && (!it.summary || it.summary.length <= 400) && (!it.error || it.error.length <= 400));
                assert.ok(!/[<>*_`]/.test(it.title) && !/[<>*_`]/.test(it.summary || '') && !/[<>*_`]/.test(it.error || ''));
            }
            const times = body.items.map((i) => i.updated_at);
            assert.deepStrictEqual(times, [...times].sort().reverse(), 'newest updated_at first');
        });

        await check('at most 50 items, newest first', async () => {
            const mara = t.network.addUser('mara');
            const newest = ids.newId('task');
            for (let i = 0; i < 55; i++) {
                await addTask({ id: i === 0 ? newest : ids.newId('task'), subject: mara.subject, state: 'running', prompt: `Task ${i}`, created: now - i * 60_000, updated: now - i * 60_000 });
            }
            const res = await t.get(`/api/v1/actions?subject=${mara.subject}`, { headers: { Authorization: `Bearer ${reader}` } });
            assert.strictEqual(res.status, 200, res.text);
            assert.strictEqual(res.json().items.length, 50);
            assert.strictEqual(res.json().items[0].id, newest);
        });

        await check('a person\'s token, a service without the capability and a bad subject are refused', async () => {
            const person = await t.get(`/api/v1/actions?subject=${ada.subject}`, { headers: { Authorization: `Bearer ${t.network.userToken(ada)}` } });
            assert.strictEqual(person.status, 401);
            const noCap = await t.get(`/api/v1/actions?subject=${ada.subject}`, { headers: { Authorization: `Bearer ${token(['codes.task.read'])}` } });
            assert.strictEqual(noCap.status, 403);
            const none = await t.get(`/api/v1/actions?subject=${ada.subject}`);
            assert.strictEqual(none.status, 401);
            const bad = await t.get('/api/v1/actions?subject=usr_nope', { headers: { Authorization: `Bearer ${reader}` } });
            assert.strictEqual(bad.status, 400);
            assert.strictEqual(bad.json().code, 'subject.invalid');
            const missing = await t.get('/api/v1/actions', { headers: { Authorization: `Bearer ${reader}` } });
            assert.strictEqual(missing.status, 400);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
