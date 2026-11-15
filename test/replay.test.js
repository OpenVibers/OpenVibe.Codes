'use strict';
// Replays (plan §AD.6, Codes next (6)): a task's owner makes a link anyone can open to read the task as it happened —
// the brief, every turn, the steps and the answers — with no sign-in, not indexed, and no composer. Only the owner
// shares or stops it; a stopped link is gone for good and sharing again makes a new one; a conductor task is not shared.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const ada = t.network.addUser('replay-ada');
    const bo = t.network.addUser('replay-bo');
    const db = t.ctx.store.db;
    const P = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAW';
    const TASK = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5RP1';
    try {
        await db.exec(`INSERT INTO run_tasks (id, subject, project_id, repo, ref, prompt, agent, state, result, created_at, updated_at) VALUES
            ($1, $2, $3, 'https://github.com/OpenVibers/OpenVibe.Live', 'main', 'Make the footer quieter', 'claude-code', 'succeeded', '{}'::jsonb, $4, $4)`,
            [TASK, ada.subject, P, Date.now() - 60_000]);
        await db.exec(`INSERT INTO codes_attempts (id, task_id, n, agent, model, state, kind, created_at) VALUES
            ('att_01ARZ3NDEKTSV4RRFFQ69G5RP2', $1, 1, 'claude-code', 'opus', 'done', 'first', now() - interval '50 minutes')`, [TASK]);
        await db.exec(`INSERT INTO codes_session_lines (task_id, seq, at, kind, body, attempt_n) VALUES
            ($1, 1, now() - interval '49 minutes', 'tool', '{"t":"tool","name":"Edit","what":"public/css/footer.css"}', 1),
            ($1, 2, now() - interval '48 minutes', 'done', '{"t":"done","ok":true,"text":"The footer is **quieter** now."}', 1)`, [TASK]);
        let token = null;

        await check('the owner sees Share a replay in the task’s panel', async () => {
            const page = await t.get(`/tasks/${TASK}`, { as: ada });
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes(`action="/tasks/${TASK}/share"`) && page.text.includes('Share a replay'));
            assert.ok(page.text.includes('No sign-in, not in search'), 'it says who can see it');
        });

        await check('someone else cannot share it, and a cross-site post is refused', async () => {
            const other = await t.get(`/tasks/${TASK}/share`, { as: bo, form: { x: '1' } });
            assert.strictEqual(other.status, 404);
            const cross = await t.get(`/tasks/${TASK}/share`, { as: ada, form: { x: '1' }, headers: { origin: 'https://evil.example' } });
            assert.strictEqual(cross.status, 403);
            assert.strictEqual(Number((await db.one('SELECT count(*)::int AS n FROM codes_task_shares')).n), 0);
        });

        await check('sharing makes one link; the panel shows it with Copy, Open and Stop sharing', async () => {
            const made = await t.get(`/tasks/${TASK}/share`, { as: ada, form: { x: '1' } });
            assert.strictEqual(made.status, 303);
            await t.get(`/tasks/${TASK}/share`, { as: ada, form: { x: '1' } });
            const rows = await db.many('SELECT token FROM codes_task_shares WHERE task_id = $1 AND revoked_at IS NULL', [TASK]);
            assert.strictEqual(rows.length, 1, 'sharing twice keeps one link');
            token = rows[0].token;
            assert.match(token, /^[A-Za-z0-9_-]{32}$/, '24 random bytes');
            const page = await t.get(`/tasks/${TASK}`, { as: ada });
            assert.ok(page.text.includes(`/r/${token}`) && page.text.includes('data-ch-copy') && page.text.includes(`action="/tasks/${TASK}/unshare"`));
        });

        await check('anyone with the link reads the task as it happened: no sign-in, noindex, no composer', async () => {
            const page = await t.get(`/r/${token}`);
            assert.strictEqual(page.status, 200);
            const text = page.text;
            assert.ok(text.includes('Make the footer quieter'), 'the brief');
            assert.ok(text.includes('<strong>quieter</strong>'), 'the answer');
            assert.ok(text.includes('public/css/footer.css'), 'the steps');
            assert.ok(text.includes('A replay its owner shared'), 'it says what it is');
            assert.match(text, /<meta name="robots" content="noindex/, 'not indexed');
            assert.ok(!text.includes('/continue"') && !text.includes('ch-rail'), 'no composer and no rail of anyone’s conversations');
            assert.strictEqual(page.headers.get('cache-control'), 'private, no-store');
        });

        await check('stopping ends the link for good; sharing again makes a new one', async () => {
            const stop = await t.get(`/tasks/${TASK}/unshare`, { as: ada, form: { x: '1' } });
            assert.strictEqual(stop.status, 303);
            const gone = await t.get(`/r/${token}`);
            assert.strictEqual(gone.status, 404);
            assert.ok(gone.text.includes('This replay is not shared'));
            await t.get(`/tasks/${TASK}/share`, { as: ada, form: { x: '1' } });
            const again = await db.one('SELECT token FROM codes_task_shares WHERE task_id = $1 AND revoked_at IS NULL', [TASK]);
            assert.notStrictEqual(again.token, token, 'a new link, never the old one');
            assert.strictEqual((await t.get(`/r/${token}`)).status, 404);
            assert.strictEqual((await t.get(`/r/${again.token}`)).status, 200);
        });

        await check('the person shares from the API too (the session surface on any site), once a task', async () => {
            const bearer = t.network.userToken(ada);
            const first = await t.get(`/api/v1/tasks/${TASK}/replay`, { bearer, method: 'POST' });
            assert.ok([200, 201].includes(first.status), first.text);
            const out = first.json();
            const live = await db.one('SELECT token FROM codes_task_shares WHERE task_id = $1 AND revoked_at IS NULL', [TASK]);
            assert.ok(out.url.endsWith(`/r/${live.token}`), 'the one live link');
            const again = await t.get(`/api/v1/tasks/${TASK}/replay`, { bearer, method: 'POST' });
            assert.deepStrictEqual([again.status, again.json().url, again.json().created], [200, out.url, false], 'asking again answers the same link');
            const other = await t.get(`/api/v1/tasks/${TASK}/replay`, { bearer: t.network.userToken(bo), method: 'POST' });
            assert.strictEqual(other.status, 404, 'nobody else shares it');
            const stop = await t.get(`/api/v1/tasks/${TASK}/replay`, { bearer, method: 'DELETE' });
            assert.deepStrictEqual([stop.status, stop.json().stopped], [200, true]);
            assert.strictEqual((await t.get(new URL(out.url).pathname)).status, 404, 'a stopped link is gone');
        });

        await check('a malformed link is a plain not-shared page', async () => {
            assert.strictEqual((await t.get('/r/short')).status, 404);
            assert.strictEqual((await t.get(`/r/${'x'.repeat(32)}`)).status, 404);
        });
    } finally {
        await done(t);
    }
})();
