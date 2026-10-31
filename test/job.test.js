'use strict';
/**
 * `openvibe-codes job` (harness/job.js): one coding task as an OpenVibe Run job on the person's own machine. Its input
 * is checked (an https repository with no credentials, a prompt, a branch name); it clones, runs the harness there and
 * prints one short JSON line per event; the result (the agents' summary, the changed files and the patch) goes to the
 * result channel once; a push is only ever a new branch on github.com, and no token is ever printed. The scratch
 * directory is gone afterwards.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { runJob, parseArgs, compact, sessionLog, scrub, githubRepo, JOB_PROTOCOL } = require('../harness/job');
const { check, done } = require('./helpers/boot');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

/** A small repository to clone, as a file:// URL. */
function repository() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-src-'));
    sh(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\n');
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', 'first');
    return { dir, url: `file://${dir}` };
}

/** A stand-in harness: the "agent" edits README.md in the clone and says so. */
function fakeHarness({ fail = false } = {}) {
    const calls = [];
    return {
        calls,
        run(opts) {
            calls.push(opts);
            return (async function* run() {
                yield { type: 'system', subtype: 'init', agent: 'claude-code', model: 'test-model' };
                fs.appendFileSync(path.join(opts.cwd, 'README.md'), '\nAdded by the agent.\n');
                yield { type: 'assistant', message: { content: [{ type: 'text', text: 'I updated the README.' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'README.md' } }] } };
                yield { type: 'result', is_error: fail, result: fail ? 'gave up' : 'Done: README updated.', duration_ms: 1200, total_cost_usd: 0.0021 };
            })();
        },
    };
}

(async () => {
    const env = { ...process.env, OPENVIBE_CODES_ALLOW_FILE_REPO: '1' };

    await check('the input is checked: an https repository without credentials, a prompt, branch names', () => {
        const ok = parseArgs(JSON.stringify({ repo: 'https://github.com/OpenVibers/OpenVibe.Codes', prompt: 'Fix the typo', ref: 'main', push: { branch: 'fix/typo' } }));
        assert.deepStrictEqual([ok.repo, ok.ref, ok.permission, ok.push.branch], ['https://github.com/OpenVibers/OpenVibe.Codes', 'main', 'edit', 'fix/typo']);
        for (const [input, why] of [
            [{ repo: 'http://github.com/a/b', prompt: 'x' }, /https/],
            [{ repo: 'https://user:pw@github.com/a/b', prompt: 'x' }, /credentials/],
            [{ repo: 'file:///tmp/x', prompt: 'x' }, /https/],
            [{ repo: 'https://github.com/a/b', prompt: '   ' }, /prompt/],
            [{ repo: 'https://github.com/a/b', prompt: 'x', ref: '--upload-pack=evil' }, /ref/],
            [{ repo: 'https://github.com/a/b', prompt: 'x', push: { branch: '-x' } }, /push.branch/],
            [{ repo: 'https://github.com/a/b', prompt: 'x', push: { branch: 'main' } }, /never main/],
            [{ repo: 'https://github.com/a/b', prompt: 'x', push: { branch: 'release/2.0' } }, /never release\/2\.0/],
        ]) assert.throws(() => parseArgs(JSON.stringify(input)), why);
        assert.throws(() => parseArgs('not json'), /JSON/);
        assert.strictEqual(parseArgs(JSON.stringify({ repo: 'file:///tmp/x', prompt: 'x' }), env).repo, 'file:///tmp/x');
    });

    await check('a bench job accepts no repository and returns the model output without a repository diff', async () => {
        const parsed = parseArgs(JSON.stringify({ kind: 'bench', prompt: 'Return a small HTML artifact', agent: 'claude-code', model: 'cheap-model', limits: { ms: 5000, tokens: 10000, usd: 0.05 } }));
        assert.strictEqual(parsed.repo, null);
        assert.strictEqual(parsed.kind, 'bench');
        assert.deepStrictEqual(parsed.limits, { ms: 5000, tokens: 10000, usd: 0.05 });
        const docs = [];
        const harness = fakeHarness();
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-bench-tmp-'));
        const doc = await runJob({ input: JSON.stringify({ kind: 'bench', prompt: 'Return a small HTML artifact' }), harness,
            emit: () => {}, writeResult: (d) => docs.push(d), env, tmp });
        assert.strictEqual(doc.kind, 'bench');
        assert.strictEqual(doc.output, 'Done: README updated.');
        assert.deepStrictEqual(doc.files, []);
        assert.strictEqual(docs.length, 1);
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    await check('a task clones, runs the agent there, streams short lines and hands over the patch once', async () => {
        const src = repository();
        const lines = [];
        const docs = [];
        const harness = fakeHarness();
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-tmp-'));
        const doc = await runJob({
            input: JSON.stringify({ repo: src.url, prompt: 'Add a line to the README', push: { pull_request: true } }),
            harness, emit: (l) => lines.push(JSON.parse(l)), writeResult: (d) => docs.push(d), env, tmp,
        });
        assert.strictEqual(docs.length, 1);
        assert.strictEqual(doc, docs[0]);
        assert.strictEqual(doc.protocol, JOB_PROTOCOL);
        assert.strictEqual(doc.ok, true, JSON.stringify(doc));
        assert.deepStrictEqual(doc.agents, ['claude-code']);
        assert.strictEqual(doc.base, 'main');
        assert.deepStrictEqual(doc.files, [{ path: 'README.md', added: 2, removed: 0 }]);
        assert.ok(doc.patch.includes('+Added by the agent.') && doc.patch_truncated === false);
        assert.strictEqual(doc.summary, 'Done: README updated.');
        assert.strictEqual(doc.cost_usd, 0.0021);
        // The agent worked inside the clone, with edit permission and hand-offs (no agent was named).
        assert.strictEqual(harness.calls[0].permission, 'edit');
        assert.strictEqual(harness.calls[0].handoff, true);
        assert.ok(harness.calls[0].cwd.startsWith(tmp));
        const kinds = lines.map((l) => l.t);
        for (const k of ['step', 'agent', 'text', 'tool', 'done']) assert.ok(kinds.includes(k), `${k} in ${kinds}`);
        // A push of a non-GitHub repository is declined, with the reason.
        assert.strictEqual(doc.push.pushed, false);
        assert.match(doc.push.reason, /github\.com/);
        assert.deepStrictEqual(fs.readdirSync(tmp), [], 'the scratch directory is gone');
        // The source repository is untouched.
        assert.strictEqual(fs.readFileSync(path.join(src.dir, 'README.md'), 'utf8'), '# Demo\n');
    });

    await check('a conversation\'s next turn starts from the work of the turns before it (L31 CH4)', async () => {
        const src = repository();
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-tmp-'));
        const turn = (extra) => runJob({ input: JSON.stringify({ repo: src.url, prompt: 'Add a line', ...extra }), harness: fakeHarness(), emit: () => {}, writeResult: () => {}, env, tmp });
        const first = await turn({});
        assert.ok(first.patch && first.patch.includes('+Added by the agent.'), 'the first turn\'s diff');
        const lines = [];
        const second = await runJob({ input: JSON.stringify({ repo: src.url, prompt: 'Add another', base_patch: first.patch }), harness: fakeHarness(), emit: (l) => lines.push(JSON.parse(l)), writeResult: () => {}, env, tmp });
        assert.strictEqual(second.base_patch, 'applied', 'the earlier work was picked up');
        assert.strictEqual((second.patch.match(/\+Added by the agent\./g) || []).length, 2, 'and the new diff holds both turns');
        assert.ok(lines.some((l) => /Picked up the changes from the earlier turns/.test(JSON.stringify(l))), 'and says so');
        const stale = await turn({ base_patch: 'diff --git a/NOPE.md b/NOPE.md\n--- a/NOPE.md\n+++ b/NOPE.md\n@@ -1 +1 @@\n-x\n+y\n' });
        assert.strictEqual(stale.base_patch, 'failed', 'a diff that no longer applies is said');
        assert.ok(stale.patch && stale.patch.includes('+Added by the agent.'), 'and the turn still runs from the branch as it is');
    });

    await check('a push is only ever a new branch: never the base, a protected name, an existing branch, or unchecked', () => {
        const { pushTarget } = require('../harness/job');
        assert.deepStrictEqual(pushTarget('fix/typo', 'main'), { branch: 'fix/typo' });
        assert.match(pushTarget(null, 'main', { now: 1 }).branch, /^openvibe-codes\/1$/);
        assert.match(pushTarget('dev', 'dev').refused, /started from/);
        for (const name of ['main', 'master', 'develop', 'production', 'release/1.2', 'gh-pages', 'Main']) assert.match(pushTarget(name, 'feature').refused, /never/, name);
        assert.match(pushTarget('fix/typo', 'main', { exists: true }).refused, /already exists/);
        assert.match(pushTarget('fix/typo', 'main', { exists: null }).refused, /could not say/);
        assert.match(fs.readFileSync(path.join(__dirname, '..', 'harness', 'job.js'), 'utf8'), /\['push', remoteUrl, `HEAD:refs\/heads\/\$\{branch\}`\]/, 'never a forced refspec');
    });

    await check('a failed agent or a bad clone ends with a reason, never a crash', async () => {
        const src = repository();
        const failed = await runJob({ input: JSON.stringify({ repo: src.url, prompt: 'x' }), harness: fakeHarness({ fail: true }), emit: () => {}, writeResult: () => {}, env });
        assert.strictEqual(failed.ok, false);
        assert.strictEqual(failed.summary, 'gave up');
        const missing = await runJob({ input: JSON.stringify({ repo: `file://${path.join(os.tmpdir(), 'no-such-repo-here')}`, prompt: 'x' }), harness: fakeHarness(), emit: () => {}, writeResult: () => {}, env });
        assert.strictEqual(missing.ok, false);
        assert.ok(missing.error, JSON.stringify(missing));
        const bad = await runJob({ input: '{"repo":"http://x"}', harness: fakeHarness(), emit: () => {}, writeResult: () => {} });
        assert.deepStrictEqual([bad.ok, bad.protocol], [false, JOB_PROTOCOL]);
    });

    await check('tokens never reach a line or a result', () => {
        assert.strictEqual(scrub('fatal: https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/a/b.git'), 'fatal: https://***@github.com/a/b.git');
        assert.strictEqual(scrub('token ghs_abcdefghijklmnopqrstuvwxyz0123 leaked'), 'token *** leaked');
        assert.deepStrictEqual(githubRepo('https://github.com/OpenVibers/OpenVibe.Codes.git'), { owner: 'OpenVibers', name: 'OpenVibe.Codes' });
        assert.strictEqual(githubRepo('https://gitlab.com/a/b'), null);
        assert.deepStrictEqual(compact({ type: 'result', is_error: false, result: 'ok', duration_ms: 5 }), { t: 'done', ok: true, text: 'ok', duration_ms: 5, cost_usd: 0, turns: 0 });
    });

    // Lines 1.1 (openvibe-shared/agent-session.js reads them): a step keeps its id and what a reader needs of its input,
    // a result its output, a helper's line its parent; secrets never pass, in any string.
    await check('lines 1.1: steps with their input, results with their output, helpers nested, secrets scrubbed', () => {
        const [said, step] = compact({ type: 'assistant', parent_tool_use_id: 'T1', message: { content: [{ type: 'text', text: 'key sk-abcdefghijklmnopqrstuv' }, { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'curl -H "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123" https://x', description: 'Call the API', timeout: 5 } }] } });
        assert.deepStrictEqual(said, { t: 'text', text: 'key [redacted]', parent: 'T1' });
        assert.deepStrictEqual([step.t, step.id, step.name, step.parent, Object.keys(step.input).sort()], ['tool', 'b1', 'Bash', 'T1', ['command', 'description']], 'only what a reader needs of the input');
        assert.ok(!/ghp_/.test(JSON.stringify(step)), 'no token in the command');
        const [edit] = compact({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'a.js', old_string: 'x', new_string: 'y' } }] } });
        assert.deepStrictEqual(edit.input, { file_path: 'a.js', old_string: 'x', new_string: 'y' }, 'an edit carries its change');
        assert.deepStrictEqual(compact({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: [{ type: 'text', text: 'boom ghs_abcdefghijklmnopqrstuvwxyz0123' }] }] } }),
            [{ t: 'tool_result', id: 'b1', ok: false, output: 'boom [redacted]' }], 'a result with its output, scrubbed');
        assert.deepStrictEqual(compact({ type: 'system', subtype: 'tool_progress', tool_use_id: 'b1', text: 'line\n' }), { t: 'tool_progress', id: 'b1', chunk: 'line\n' });
        assert.deepStrictEqual(compact({ type: 'system', subtype: 'handoff', from: 'claude', to: 'codex', reason: 'limit' }), { t: 'handoff', from: 'claude', to: 'codex', reason: 'limit' });
        const todos = compact({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'p', name: 'TodoWrite', input: { todos: [{ content: 'A', status: 'in_progress', activeForm: 'Doing A' }] } }] } })[0];
        assert.deepStrictEqual(todos.input.todos, [{ content: 'A', status: 'in_progress', activeForm: 'Doing A' }], 'the plan travels');
    });

    await check('the session log a result keeps fits: outputs are cut shorter first, the steps survive', () => {
        const lines = [];
        for (let i = 0; i < 120; i++) { lines.push({ t: 'tool', id: `s${i}`, name: 'Bash', what: 'npm test', input: { command: 'npm test' } }); lines.push({ t: 'tool_progress', id: `s${i}`, chunk: 'p'.repeat(3000) }); lines.push({ t: 'tool_result', id: `s${i}`, ok: true, output: 'o'.repeat(4000) }); }
        const kept = sessionLog(lines);
        assert.ok(JSON.stringify(kept).length <= 250000, 'within the result\'s room');
        assert.strictEqual(kept.filter((l) => l.t === 'tool').length, 120, 'every step is still there');
        assert.ok(!kept.some((l) => l.t === 'tool_progress'), 'progress whose step ended goes first');
        assert.ok(kept.every((l) => l.t !== 'tool_result' || l.output.length <= 1500), 'outputs cut shorter');
        assert.deepStrictEqual(sessionLog([{ t: 'text', text: 'hi' }]), [{ t: 'text', text: 'hi' }], 'a short session is kept as it is');
    });

    await check('the command reads its input on stdin and prints its result when fd 3 is not open', () => {
        const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'openvibe-codes.js'), 'job'], { input: '{"repo":"ftp://x","prompt":"y"}\n', encoding: 'utf8', env: { ...process.env, OPENVIBE_CODES_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'codes-home-')) } });
        assert.strictEqual(r.status, 0, 'a handed-over result ends the job 0 (ok or not is in the document)');
        const last = JSON.parse(r.stdout.trim().split('\n').pop());
        assert.strictEqual(last.t, 'result_doc');
        assert.match(last.result.error, /https/);
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
