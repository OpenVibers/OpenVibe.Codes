'use strict';
/**
 * Per-turn checkpoints (harness/checkpoints.js, harness/job.js): a job's clone is pinned under
 * `refs/codes/checkpoints/<task>/<run>/<n>` before each tool batch, the turn diff splits the files the agent wrote
 * (authored) from the ones that came from elsewhere (imported), and a checkpoint can be restored. The job result
 * carries the refs and the diffs, never a push of them.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const { createCheckpoints, toolPaths } = require('../harness/checkpoints');
const { createHarness } = require('../harness');
const { runJob } = require('../harness/job');
const { check, done } = require('./helpers/boot');

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

(async () => {
    await check('a checkpoint is a git ref; the turn diff splits authored paths from imported ones', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-cp-'));
        const repo = path.join(dir, 'repo');
        fs.mkdirSync(repo);
        git(repo, ['init', '-q']);
        fs.writeFileSync(path.join(repo, 'a.js'), 'const a = 1;\n');
        git(repo, ['add', '-A']);
        git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
        try {
            const cp = createCheckpoints({ cwd: repo, task: 'tsk_test', run: 'run_test' });
            const zero = cp.capture('start');
            assert.strictEqual(zero.n, 0);
            assert.strictEqual(zero.ref, 'refs/codes/checkpoints/tsk_test/run_test/0');
            assert.strictEqual(git(repo, ['rev-parse', '--verify', zero.ref]), zero.sha);
            assert.deepStrictEqual(cp.list().map((e) => e.n), [0]);

            fs.writeFileSync(path.join(repo, 'a.js'), 'const a = 2;\n');
            cp.authored(['a.js']);
            const one = cp.capture('turn 1');
            fs.writeFileSync(path.join(repo, 'b.js'), 'imported\n');
            const two = cp.capture('turn 2');

            const first = cp.diff(zero, one);
            assert.deepStrictEqual(first.files, [{ path: 'a.js', status: 'M', added: 1, removed: 1, authored: true }]);
            assert.deepStrictEqual(cp.diff(one, two).files, [{ path: 'b.js', status: 'A', added: 1, removed: 0, authored: false }]);
            assert.deepStrictEqual(cp.turns().map((t) => t.n), [1, 2]);
            assert.strictEqual(cp.turns()[1].authored, 0);
            assert.strictEqual(cp.turns()[1].imported, 1);

            // Restore the last good checkpoint: a.js back, the imported file and an untracked broken one gone.
            fs.writeFileSync(path.join(repo, 'junk.js'), 'broken\n');
            assert.deepStrictEqual(cp.restore(zero), { n: 0, ref: zero.ref, sha: zero.sha });
            assert.strictEqual(fs.readFileSync(path.join(repo, 'a.js'), 'utf8'), 'const a = 1;\n');
            assert.strictEqual(fs.existsSync(path.join(repo, 'b.js')), false);
            assert.strictEqual(fs.existsSync(path.join(repo, 'junk.js')), false);
            assert.strictEqual(cp.restore(99), null);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    await check('toolPaths reads the file a tool call names, never a command', () => {
        assert.deepStrictEqual(toolPaths({ type: 'assistant', message: { content: [
            { type: 'tool_use', input: { file_path: 'src/a.js' } },
            { type: 'tool_use', input: { path: 'src/b.js' } },
            { type: 'tool_use', input: { command: 'ls' } },
            { type: 'tool_use', input: { files: ['src/c.js', 7] } },
        ] } }), ['src/a.js', 'src/b.js', 'src/c.js']);
        assert.deepStrictEqual(toolPaths({ type: 'user', message: { content: [{ type: 'tool_result' }] } }), []);
    });

    await check('a job carries its checkpoint refs and the final turn diff; the agent\'s own file is authored', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-cp-job-'));
        const repo = path.join(dir, 'repo');
        const bin = path.join(dir, 'bin');
        const home = path.join(dir, 'home');
        fs.mkdirSync(repo); fs.mkdirSync(bin);
        fs.writeFileSync(path.join(repo, 'a.js'), 'const a = 1;\n');
        git(repo, ['init', '-q']);
        git(repo, ['add', '-A']);
        git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);

        // Codex writes a file (it prints the file_change after writing, as the real CLI does), then hits its limit.
        // Claude Code takes over and finishes: the note is the agent's own work, not an import, whichever attempt did it.
        fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
'use strict';
const fs = require('fs');
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'thread.started', thread_id: 'cx-cp' });
out({ type: 'turn.started' });
fs.mkdirSync('notes', { recursive: true });
fs.writeFileSync('notes/turn.txt', 'written by codex\\n');
out({ type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'notes/turn.txt', kind: 'add' }], status: 'completed' } });
out({ type: 'error', message: 'You have hit your usage limit.' });
out({ type: 'turn.failed', error: { message: 'You have hit your usage limit.' } });
process.exit(1);
`, { mode: 0o755 });
        fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
'use strict';
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'system', subtype: 'init', session_id: 'cl-cp', model: 'fake-claude' });
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'finished the note' }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'finished the note', session_id: 'cl-cp' });
`, { mode: 0o755 });

        const env = {
            ...process.env, PATH: bin, OPENVIBE_CODES_HOME: home, OPENVIBE_CODES_ALLOW_FILE_REPO: '1',
            DEEPSEEK_API_KEY: '', OPENVIBE_AI_TOKEN: '', OPENVIBE_APP_ID: '', OPENVIBE_APP_SECRET: '',
        };
        const harness = createHarness({ env });
        const lines = [];
        let doc = null;
        try {
            await runJob({
                input: JSON.stringify({ kind: 'code', repo: pathToFileURL(repo).href, prompt: 'Add the note', agent: 'codex', task_id: 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T1' }),
                harness, env, emit: (line) => lines.push(JSON.parse(line)), writeResult: (d) => { doc = d; },
            });
            assert.ok(doc, 'the job wrote a result');
            // The agent hit its limit, so the job is not ok; the checkpoints of what it did are still there.
            assert.strictEqual(doc.ok, false);
            assert.deepStrictEqual(doc.agents, ['codex']);
            assert.ok(doc.checkpoints, 'the result carries its checkpoints');
            assert.match(doc.checkpoints.root, /^refs\/codes\/checkpoints\/tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T1\/run_/);
            assert.ok(doc.checkpoints.count >= 2, `count ${doc.checkpoints.count}`);
            const note = doc.checkpoints.turns.flatMap((t) => t.files).find((f) => f.path === 'notes/turn.txt');
            assert.ok(note, JSON.stringify(doc.checkpoints.turns));
            assert.strictEqual(note.authored, true);
            assert.ok(doc.checkpoints.turn_diff.files.some((f) => f.path === 'notes/turn.txt' && f.authored === true));
            assert.ok(doc.checkpoints.turns.some((t) => t.files_total > 0));
            assert.ok(!lines.some((l) => l.t === 'note' && /Checkpoints are off/.test(l.text)), 'checkpoints did not fail');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
