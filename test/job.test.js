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
const { runJob, parseArgs, compact, scrub, githubRepo, JOB_PROTOCOL } = require('../harness/job');
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
        ]) assert.throws(() => parseArgs(JSON.stringify(input)), why);
        assert.throws(() => parseArgs('not json'), /JSON/);
        assert.strictEqual(parseArgs(JSON.stringify({ repo: 'file:///tmp/x', prompt: 'x' }), env).repo, 'file:///tmp/x');
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
        assert.deepStrictEqual(compact({ type: 'result', is_error: false, result: 'ok', duration_ms: 5 }), { t: 'done', ok: true, text: 'ok', duration_ms: 5, cost_usd: 0 });
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
