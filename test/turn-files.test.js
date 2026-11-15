'use strict';
// Per-turn diffs (plan §AD.6, Codes next (4)): what each attempt of a task changed by itself is kept on the attempt when
// it ends, and the Changes panel shows the task turn by turn under its whole diff. The harness's checkpoints measure it
// (authored by the turn's own tools, or from elsewhere); an older harness is compared file by file with the turn before;
// a crash that measured nothing is not "everything put back".
const assert = require('assert');
const turnFiles = require('../server/domain/turn-files');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    await check('the harness\'s turn diff, as the turn\'s own files', async () => {
        const out = turnFiles.of({ files: [{ path: 'a.js', added: 9, removed: 1 }], checkpoints: { turn_diff: { files: [
            { path: 'a.js', status: 'M', added: 3, removed: 1, authored: true },
            { path: 'package-lock.json', status: 'M', added: 40, removed: 2, authored: false },
            { path: '', status: 'M' },
        ] } } }, { files: [{ path: 'a.js', added: 6, removed: 0 }] });
        assert.deepStrictEqual(out, { source: 'checkpoints', files: [
            { path: 'a.js', status: 'M', added: 3, removed: 1, authored: true },
            { path: 'package-lock.json', status: 'M', added: 40, removed: 2, authored: false },
        ] });
    });

    await check('without checkpoints: the files whose counts moved, new ones, and ones put back', async () => {
        const out = turnFiles.of(
            { files: [{ path: 'a.js', added: 6, removed: 0 }, { path: 'b.js', added: 4, removed: 2 }, { path: 'c.js', added: 1, removed: 0 }] },
            { files: [{ path: 'a.js', added: 6, removed: 0 }, { path: 'b.js', added: 1, removed: 0 }, { path: 'old.js', added: 5, removed: 0 }] });
        assert.deepStrictEqual(out, { source: 'files', files: [
            { path: 'b.js', status: 'M', added: 4, removed: 2 },
            { path: 'c.js', status: 'A', added: 1, removed: 0 },
            { path: 'old.js', status: 'put back', added: null, removed: null },
        ] }, 'a.js did not move this turn');
        assert.strictEqual(turnFiles.of({ error: 'crashed' }, { files: [{ path: 'a.js', added: 1, removed: 0 }] }), null, 'a crash is not everything put back');
        assert.strictEqual(turnFiles.of({ files: [{ path: 'a.js', added: 1, removed: 0 }] }, { files: [{ path: 'a.js', added: 1, removed: 0 }] }), null, 'nothing moved');
        assert.strictEqual(turnFiles.read('{"bad'), null);
        assert.deepStrictEqual(turnFiles.read('{"source":"files","files":[]}'), { source: 'files', files: [] });
    });

    const t = await boot();
    const ada = t.network.addUser('turns-ada');
    const db = t.ctx.store.db;
    const P = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAW';
    const TASK = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5TF1';
    try {
        await db.exec(`INSERT INTO run_tasks (id, subject, project_id, repo, ref, prompt, agent, state, result, created_at, updated_at) VALUES
            ($1, $2, $3, 'https://github.com/OpenVibers/OpenVibe.Live', 'main', 'Make the footer quieter', 'claude-code', 'succeeded',
             '{"files":[{"path":"public/css/footer.css","added":7,"removed":3},{"path":"package-lock.json","added":40,"removed":2}],"patch":"diff --git a/x b/x"}'::jsonb, $4, $4)`,
        [TASK, ada.subject, P, Date.now() - 60_000]);
        await db.exec(`INSERT INTO codes_attempts (id, task_id, n, agent, model, state, kind, created_at) VALUES
            ('att_01ARZ3NDEKTSV4RRFFQ69G5TF2', $1, 1, 'claude-code', 'opus', 'running', 'first', now() - interval '50 minutes'),
            ('att_01ARZ3NDEKTSV4RRFFQ69G5TF3', $1, 2, 'codex', 'gpt-5', 'running', 'switch', now() - interval '20 minutes')`, [TASK]);
        const store = t.ctx.attempts;

        await check('an attempt keeps what it changed when it ends', async () => {
            await store.end('att_01ARZ3NDEKTSV4RRFFQ69G5TF2', { state: 'done', turn_files: turnFiles.of({ files: [{ path: 'public/css/footer.css', added: 4, removed: 3 }] }, null) });
            await store.end('att_01ARZ3NDEKTSV4RRFFQ69G5TF3', { state: 'done', turn_files: { source: 'checkpoints', files: [
                { path: 'public/css/footer.css', status: 'M', added: 3, removed: 0, authored: true },
                { path: 'package-lock.json', status: 'M', added: 40, removed: 2, authored: false },
            ] } });
            const listed = await store.list(TASK);
            assert.deepStrictEqual(listed.map((a) => [Number(a.n), turnFiles.read(a.turn_files).files.length]), [[1, 1], [2, 2]]);
            assert.ok(!('turn_files' in store.present(listed[0])), 'codes.task@1\'s attempts stay as the contract says');
        });

        await check('each turn of the conversation shows what it changed by itself', async () => {
            const page = await t.get(`/tasks/${TASK}`, { as: ada });
            assert.strictEqual(page.status, 200);
            const h = page.text;
            const one = h.indexOf('This turn: 1 file'), two = h.indexOf('This turn: 2 files');
            assert.ok(one > 0 && two > one, 'under each turn, in order');
            assert.ok(h.includes('<b>This turn: 2 files</b><span class="ch-add">+43</span><span class="ch-del">−2</span><span class="ch-muted">1 from elsewhere</span>'), 'the turn\'s own sum, and what came from elsewhere');
            assert.ok(h.includes('<code>package-lock.json</code><span>from elsewhere</span>'));
            assert.ok(h.includes('Measured file by file against the turn before.'), 'an older harness\'s turn says how it was measured');
            assert.ok(h.indexOf('2 files changed') > two, 'the whole task\'s changes still end the conversation');
        });
    } finally {
        await done(t);
    }
})();
