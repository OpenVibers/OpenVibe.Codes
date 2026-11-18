'use strict';
/**
 * `kind: 'check'` jobs (harness/check.js): the input is checked, a workflow job that needs services, a container, a
 * non-GITHUB_TOKEN secret, a Docker action or a non-ubuntu runner is skipped with its reason, act is started in host
 * mode with a pinned binary and without a token in its argv or environment, its output becomes step lines and a
 * result, and a timeout is answered `timed_out`. A stubbed act (OPENVIBE_CODES_ACT_BIN) records what it was given;
 * the small file:// repositories are the same test hook a task uses.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runJob } = require('../harness/job');
const {
    ACT_VERSION, ACT_URL, ACT_SHA256, parseCheckArgs, skipReason, parseActLine, outputText, prepareAct, runCheck, tail, calledRef,
} = require('../harness/check');
const { check, done } = require('./helpers/boot');

const sh = (cwd, ...args) => execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
});
const temps = [];
const tmpDir = (prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(dir); return dir; };

/** A small repository with the workflows a test names, as a file:// URL. */
function repository(workflows) {
    const dir = tmpDir('codes-check-src-');
    sh(dir, 'init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    for (const [name, source] of Object.entries(workflows)) fs.writeFileSync(path.join(dir, '.github', 'workflows', name), source);
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', 'first');
    return { dir, url: `file://${dir}`, sha: sh(dir, 'rev-parse', 'HEAD').toString().trim() };
}

const workflow = ({ job = 'test', runsOn = 'ubuntu-latest', steps = '- run: echo hello' } = {}) => `name: ci
on: push
jobs:
  ${job}:
    runs-on: ${runsOn}
    steps:
      ${steps}
`;

/** A stand-in act: records argv and environment, prints recorded output, then exits (or keeps running for a timeout). */
function stubAct({ output = '', code = 0, sleep = 0 } = {}) {
    const dir = tmpDir('codes-check-stub-');
    const record = path.join(dir, 'record.json');
    const script = path.join(dir, 'act');
    const source = `#!${process.execPath}
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
process.stdout.write(${JSON.stringify(output)});
process.exitCode = ${code};
${sleep ? `setTimeout(() => {}, ${sleep});` : ''}
`;
    fs.writeFileSync(script, source, { mode: 0o755 });
    return { dir, script, record, read: () => JSON.parse(fs.readFileSync(record, 'utf8')) };
}

const checkInput = (repo, extra = {}) => JSON.stringify({
    kind: 'check', repo: repo.url, sha: repo.sha, workflow: '.github/workflows/ci.yml', job: 'test', event: 'push', ...extra,
});

(async () => {
    const env = { ...process.env, OPENVIBE_CODES_ALLOW_FILE_REPO: '1' };

    await check('the input is checked: repository, commit, workflow path, job, event, matrix and timeout', () => {
        const ok = parseCheckArgs(JSON.stringify({
            kind: 'check', repo: 'https://github.com/OpenVibers/OpenVibe.Codes.git', sha: 'A'.repeat(40),
            workflow: '.github/workflows/ci.yml', job: 'test', event: 'push', ref: 'main', matrix: { node: 20 }, timeout_ms: 60_000,
        }), env);
        assert.strictEqual(ok.repo, 'https://github.com/OpenVibers/OpenVibe.Codes');
        assert.strictEqual(ok.sha, 'a'.repeat(40));
        assert.deepStrictEqual([ok.workflow, ok.job, ok.event, ok.ref], ['.github/workflows/ci.yml', 'test', 'push', 'main']);
        assert.deepStrictEqual(ok.matrix, { node: '20' });
        assert.strictEqual(ok.timeout_ms, 60_000);
        assert.strictEqual(parseCheckArgs({ ...JSON.parse(checkInput({ url: 'https://git.openvibe.codes/o/r', sha: 'b'.repeat(40) })) }, env).repo, 'https://git.openvibe.codes/o/r');

        const base = { kind: 'check', repo: 'https://github.com/a/b', sha: 'a'.repeat(40), workflow: '.github/workflows/ci.yml', job: 'test', event: 'push' };
        for (const [bad, why] of [
            [{ ...base, repo: 'http://github.com/a/b' }, /https/],
            [{ ...base, repo: 'https://evil.example/a/b' }, /github\.com|git\.openvibe\.codes/],
            [{ ...base, repo: 'https://user:pw@github.com/a/b' }, /credentials/],
            [{ ...base, repo: 'https://github.com/a/b?x=1' }, /query|fragment/],
            [{ ...base, sha: 'abc' }, /sha/],
            [{ ...base, sha: 'g'.repeat(40) }, /sha/],
            [{ ...base, workflow: 'ci.yml' }, /workflow/],
            [{ ...base, workflow: '.github/workflows/../ci.yml' }, /workflow/],
            [{ ...base, workflow: '.github/workflows/ci.txt' }, /workflow/],
            [{ ...base, workflow: '/etc/passwd' }, /workflow/],
            [{ ...base, job: 'test job' }, /job/],
            [{ ...base, job: '-x' }, /job/],
            [{ ...base, event: 'schedule' }, /event/],
            [{ ...base, matrix: { node: { version: 20 } } }, /matrix/],
            [{ ...base, timeout_ms: 0 }, /timeout_ms/],
            [{ ...base, timeout_ms: '5' }, /timeout_ms/],
            [{ ...base, kind: 'code' }, /check/],
        ]) assert.throws(() => parseCheckArgs(JSON.stringify(bad), env), why);
        assert.throws(() => parseCheckArgs(JSON.stringify({ ...base, repo: 'file:///tmp/x' }), process.env), /https/);
        assert.throws(() => parseCheckArgs('not json', env), /JSON/);
    });

    await check('the skip rules: services, container, another secret, a Docker action, a non-ubuntu runner', () => {
        const base = workflow();
        assert.strictEqual(skipReason(base, 'test'), null);
        assert.match(skipReason(workflow().replace('    runs-on:', '    services:\n      redis:\n        image: redis\n    runs-on:'), 'test'), /services:/);
        assert.match(skipReason(workflow().replace('    runs-on:', '    container: node:20\n    runs-on:'), 'test'), /container:/);
        assert.match(skipReason(workflow({ steps: '- run: echo "${{ secrets.MY_SECRET }}"' }), 'test'), /MY_SECRET/);
        assert.strictEqual(skipReason(workflow({ steps: '- run: echo "${{ secrets.GITHUB_TOKEN }}"' }), 'test'), null, 'GITHUB_TOKEN alone is allowed (and never passed)');
        assert.match(skipReason(workflow({ steps: '- run: echo "${{ secrets[matrix.name] }}"' }), 'test'), /computes/);
        assert.match(skipReason(workflow().replace('jobs:', 'env:\n  TOKEN: ${{ secrets.WORKFLOW_SECRET }}\njobs:'), 'test'), /WORKFLOW_SECRET/);
        assert.match(skipReason(workflow({ steps: '- uses: docker://alpine:3\n        run: echo x' }), 'test'), /Docker action/);
        assert.match(skipReason(workflow({ runsOn: 'macos-latest' }), 'test'), /macos-latest.*ubuntu/);
        assert.match(skipReason(workflow({ runsOn: '[self-hosted, linux]' }), 'test'), /self-hosted.*ubuntu/);
        assert.match(skipReason(workflow({ runsOn: 'ubuntu-24.04-arm' }), 'test'), /arm.*x64/);
        assert.match(skipReason(workflow({ runsOn: '${{ matrix.os }}' }).replace('    steps:', '    strategy:\n      matrix:\n        os: [ubuntu-latest, macos-latest]\n    steps:'), 'test'), /macos-latest/);
        assert.strictEqual(skipReason(workflow({ runsOn: '${{ matrix.os }}' }).replace('    steps:', '    strategy:\n      matrix:\n        os: [ubuntu-latest, macos-latest]\n    steps:'), 'test', { os: 'ubuntu-latest' }), null, 'the scheduler selected the ubuntu matrix value');
        assert.match(skipReason(workflow({ runsOn: '${{ inputs.os }}' }), 'test'), /cannot resolve/);
    });

    await check('a skipped job answers skipped with the reason, before act is fetched or run', async () => {
        const repo = repository({
            'services.yml': workflow().replace('    runs-on:', '    services:\n      redis:\n        image: redis\n    runs-on:'),
            'macos.yml': workflow({ runsOn: 'macos-latest' }),
        });
        const docs = [];
        const lines = [];
        const services = await runCheck({
            input: JSON.stringify({ kind: 'check', repo: repo.url, sha: repo.sha, workflow: '.github/workflows/services.yml', job: 'test', event: 'push' }),
            emit: (l) => lines.push(JSON.parse(l)), writeResult: (d) => docs.push(d), env, tmp: tmpDir('codes-check-tmp-'),
        });
        assert.strictEqual(docs.length, 1);
        assert.strictEqual(docs[0], services);
        assert.deepStrictEqual([services.ok, services.kind, services.conclusion], [true, 'check', 'skipped']);
        assert.match(services.reason, /services:/);
        assert.deepStrictEqual(services.steps, []);
        assert.ok(lines.some((l) => l.t === 'step' && /Skipped/.test(l.text)));
        const mac = await runCheck({
            input: JSON.stringify({ kind: 'check', repo: repo.url, sha: repo.sha, workflow: '.github/workflows/macos.yml', job: 'test', event: 'push' }),
            emit: () => {}, writeResult: () => {}, env, tmp: tmpDir('codes-check-tmp-'),
        });
        assert.strictEqual(mac.conclusion, 'skipped');
        assert.match(mac.reason, /macos-latest/);
        // act exits 0 with no line for a job whose if: is false or a matrix value it does not have: not green.
        const emptyRepo = repository({ 'ci.yml': workflow() });
        const quiet = stubAct();
        const none = await runCheck({
            input: checkInput(emptyRepo), emit: () => {}, writeResult: () => {},
            env: { ...env, OPENVIBE_CODES_ACT_BIN: quiet.script }, tmp: tmpDir('codes-check-tmp-'),
        });
        assert.strictEqual(none.conclusion, 'skipped');
        assert.match(none.reason, /ran no step/);
    });

    await check('runJob hands a kind check input to check.js (and leaves a bad task input to parseArgs)', async () => {
        const repo = repository({ 'ci.yml': workflow().replace('    runs-on:', '    container: node:20\n    runs-on:') });
        const docs = [];
        const doc = await runJob({
            input: JSON.stringify({ kind: 'check', repo: repo.url, sha: repo.sha, workflow: '.github/workflows/ci.yml', job: 'test', event: 'push' }),
            harness: {}, emit: () => {}, writeResult: (d) => docs.push(d), env, tmp: tmpDir('codes-check-tmp-'),
        });
        assert.strictEqual(doc.kind, 'check');
        assert.strictEqual(doc.conclusion, 'skipped');
        assert.deepStrictEqual(docs, [doc]);
        const bad = await runJob({ input: '{"kind":"check","repo":"http://x"}', harness: {}, emit: () => {}, writeResult: () => {}, env });
        assert.deepStrictEqual([bad.kind, bad.ok, bad.conclusion], ['check', false, 'failure']);
    });

    const SHARED_SHA = 'a'.repeat(40);
    const callerOf = (uses, extra = '') => `name: ci
on: push
jobs:
  test:
    uses: ${uses}
${extra}    with:
      syntax-dirs: server
`;
    const reusable = workflow().replace('on: push', 'on:\n  workflow_call:');

    await check('a job that calls another workflow is judged by the jobs it calls (11-18: Live and MediaHub were always skipped)', () => {
        const key = `OpenVibers/OpenVibe.Shared/.github/workflows/test.yml@${SHARED_SHA}`;
        const caller = callerOf(key);
        const called = (source) => new Map([[key, source]]);
        assert.strictEqual(skipReason(caller, 'test', {}, called(reusable)), null, 'every called job can run here');
        assert.match(skipReason(caller, 'test'), /could not be read here/, 'not read: left to Actions');
        assert.match(skipReason(caller, 'test', {}, called(reusable.replace('    runs-on:', '    services:\n      pg:\n        image: postgres\n    runs-on:'))),
            /whose job test cannot run here \(it uses services:/);
        assert.match(skipReason(caller, 'test', {}, called(workflow({ runsOn: 'macos-latest' }))), /macos-latest/);
        assert.match(skipReason(caller, 'test', {}, called(workflow({ steps: '- run: echo "${{ secrets.NPM_TOKEN }}"' }))), /NPM_TOKEN/);
        assert.match(skipReason(callerOf(key, '    secrets: inherit\n'), 'test', {}, called(reusable)), /passes secrets/);
        assert.match(skipReason(caller.replace('syntax-dirs: server', 'token: ${{ secrets.DEPLOY_KEY }}'), 'test', {}, called(reusable)), /DEPLOY_KEY/);
        assert.match(skipReason(caller, 'test', {}, called('name: n\non: workflow_call\njobs:\n  inner:\n    uses: ./.github/workflows/other.yml\n')), /calls another workflow in turn/);
        assert.match(skipReason(caller, 'test', {}, called('name: n\non: workflow_call\njobs: {}\n')), /has no jobs/);
        for (const bad of ['https://evil.example/x.yml', `OpenVibers/OpenVibe.Shared/.github/workflows/test.yml@../../x`, 'OpenVibers/OpenVibe.Shared/.github/workflows/test.yml@-x', 'docker://alpine:3', './x.yml']) {
            assert.match(skipReason(callerOf(bad), 'test', {}, new Map([[bad, reusable]])), /not a workflow a node can read/, bad);
        }
        assert.deepStrictEqual(calledRef({ uses: './.github/workflows/t.yml' }), { key: './.github/workflows/t.yml', local: true, file: '.github/workflows/t.yml' });
        assert.deepStrictEqual(calledRef({ uses: `o/r/.github/workflows/t.yaml@v1.2.3` }), { key: 'o/r/.github/workflows/t.yaml@v1.2.3', owner: 'o', repo: 'r', file: '.github/workflows/t.yaml', ref: 'v1.2.3' });
        assert.strictEqual(calledRef({ 'runs-on': 'ubuntu-latest' }), null);
    });

    await check('a calling job runs: the called workflow is fetched at its ref, act is given the caller, discovery picks it', async () => {
        // "GitHub" here is a directory of repositories: <base>/octo/lib holds the workflow ci.yml calls.
        const base = tmpDir('codes-check-called-');
        const lib = path.join(base, 'octo', 'lib');
        fs.mkdirSync(path.join(lib, '.github', 'workflows'), { recursive: true });
        sh(lib, 'init', '-q', '-b', 'main');
        fs.writeFileSync(path.join(lib, '.github', 'workflows', 'test.yml'), reusable);
        sh(lib, 'add', '-A');
        sh(lib, 'commit', '-q', '-m', 'lib');
        const libSha = sh(lib, 'rev-parse', 'HEAD').toString().trim();
        const repo = repository({ 'ci.yml': callerOf(`octo/lib/.github/workflows/test.yml@${libSha}`) });
        const stub = stubAct({ output: '[ci/test/test] ⭐ Run Main say hello\n[ci/test/test]   ✅  Success - Main say hello [3ms]\n[ci/test/test] 🏁  Job succeeded\n' });
        const jobEnv = { ...process.env, OPENVIBE_CODES_ALLOW_FILE_REPO: '1', OPENVIBE_CODES_ACT_BIN: stub.script, OPENVIBE_CODES_CALLED_BASE: `file://${base}` };
        const lines = [];
        const result = await runCheck({ input: checkInput(repo), emit: (l) => lines.push(JSON.parse(l)), env: jobEnv, tmp: tmpDir('codes-check-tmp-') });
        assert.strictEqual(result.conclusion, 'success', result.reason);
        assert.ok(lines.some((l) => /Read octo\/lib\/\.github\/workflows\/test\.yml@/.test(l.text || '')), 'the read is in the log');
        const argv = stub.read().argv;
        assert.strictEqual(argv[argv.indexOf('-j') + 1], 'test');
        assert.strictEqual(argv[argv.indexOf('-P') + 1], 'ubuntu-latest=-self-hosted');

        // Without a job named, discovery picks the calling job too.
        const found = await runCheck({ input: JSON.stringify({ kind: 'check', repo: repo.url, sha: repo.sha, event: 'push' }), env: jobEnv, tmp: tmpDir('codes-check-tmp-') });
        assert.strictEqual(found.conclusion, 'success', found.reason);

        // A called workflow that cannot be fetched: skipped with the reason, act never started.
        const missing = repository({ 'ci.yml': callerOf('octo/gone/.github/workflows/test.yml@main') });
        const idle = stubAct();
        const skipped = await runCheck({ input: checkInput(missing), env: { ...jobEnv, OPENVIBE_CODES_ACT_BIN: idle.script }, tmp: tmpDir('codes-check-tmp-') });
        assert.strictEqual(skipped.conclusion, 'skipped');
        assert.match(skipped.reason, /could not be read here/);
        assert.ok(!fs.existsSync(idle.record), 'act is not started for a skipped check');

        // One in the same repository is read from the checkout.
        const local = repository({ 'ci.yml': callerOf('./.github/workflows/reuse.yml'), 'reuse.yml': reusable });
        const ran = await runCheck({ input: checkInput(local), env: jobEnv, tmp: tmpDir('codes-check-tmp-') });
        assert.strictEqual(ran.conclusion, 'success', ran.reason);
    });

    await check('the checkout act copies keeps a ref, so git in the job finds its repository (11-18: act leaves empty refs/ out)', async () => {
        const dir = tmpDir('codes-check-stub-');
        const record = path.join(dir, 'refs.json');
        const script = path.join(dir, 'act');
        fs.writeFileSync(script, `#!${process.execPath}
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(fs.readdirSync('.git/refs/heads')));
process.stdout.write('[ci/test] \u2b50 Run Main x\\n[ci/test]   \u2705  Success - Main x [1ms]\\n[ci/test] \ud83c\udfc1  Job succeeded\\n');
`, { mode: 0o755 });
        const repo = repository({ 'ci.yml': workflow() });
        const jobEnv = { ...process.env, OPENVIBE_CODES_ALLOW_FILE_REPO: '1', OPENVIBE_CODES_ACT_BIN: script };
        const named = await runCheck({ input: checkInput(repo, { ref: 'feature/x' }), env: jobEnv, tmp: tmpDir('codes-check-tmp-') });
        assert.strictEqual(named.conclusion, 'success', named.reason);
        assert.ok(fs.existsSync(record), 'the stand-in act ran in the checkout');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(record, 'utf8')), ['feature'], 'a branch named like the ref (feature/x lives under heads/feature/)');
        await runCheck({ input: checkInput(repo), env: jobEnv, tmp: tmpDir('codes-check-tmp-') });
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(record, 'utf8')), ['check'], 'no ref: a branch named check');
    });

    await check('act runs with a pinned binary, the expected argv, and no GITHUB_TOKEN or job environment variable', async () => {
        const repo = repository({ 'ci.yml': workflow() });
        const stub = stubAct({
            output: '[ci/test] ⭐ Run Main say hello\n[ci/test]   | hello\n[ci/test]   ✅  Success - Main say hello [11.75651ms]\n[ci/test] 🏁  Job succeeded\n',
        });
        const jobEnv = {
            ...process.env, OPENVIBE_CODES_ALLOW_FILE_REPO: '1', OPENVIBE_CODES_ACT_BIN: stub.script,
            GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123', CHECK_JOB_SECRET: 'this must not reach act',
        };
        const lines = [];
        const docs = [];
        const result = await runCheck({
            input: checkInput(repo, { matrix: { node: 20 } }),
            emit: (l) => lines.push(JSON.parse(l)), writeResult: (d) => docs.push(d), env: jobEnv, tmp: tmpDir('codes-check-tmp-'),
        });
        assert.strictEqual(docs.length, 1);
        assert.strictEqual(docs[0], result);
        assert.deepStrictEqual([result.ok, result.kind, result.conclusion], [true, 'check', 'success']);
        assert.deepStrictEqual(result.steps, [
            { name: 'say hello', conclusion: 'success', ms: 12 },
        ]);
        const record = stub.read();
        assert.strictEqual(record.argv[0], 'push');
        assert.ok(record.argv.includes('-W') && record.argv[record.argv.indexOf('-W') + 1] === '.github/workflows/ci.yml');
        assert.ok(record.argv.includes('-j') && record.argv[record.argv.indexOf('-j') + 1] === 'test');
        assert.ok(record.argv.includes('-P') && record.argv[record.argv.indexOf('-P') + 1] === 'ubuntu-latest=-self-hosted');
        assert.ok(record.argv.includes('--eventpath'));
        // The cache server listens on loopback inside the job (a sandbox drops its link-local outbound address).
        assert.strictEqual(record.argv[record.argv.indexOf('--cache-server-addr') + 1], '127.0.0.1');
        assert.ok(record.argv[record.argv.indexOf('--cache-server-path') + 1].endsWith('actcache'));
        assert.ok(record.argv.includes('--matrix') && record.argv[record.argv.indexOf('--matrix') + 1] === 'node:20');
        assert.ok(!record.argv.includes('--secret') && !record.argv.includes('-s'));
        assert.ok(!record.argv.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'));
        assert.strictEqual(record.env.GITHUB_TOKEN, undefined);
        assert.strictEqual(record.env.CHECK_JOB_SECRET, undefined);
        assert.strictEqual(record.env.PATH, process.env.PATH, 'PATH stays so the job can find its tools');
        assert.ok(record.env.HOME && record.env.HOME !== os.homedir(), 'act gets a HOME inside the job directory, not the host home');
        // The step lines are the check lines; the output is the job's existing text line.
        assert.deepStrictEqual(lines.find((l) => l.name === 'say hello' && l.state === 'started'), { t: 'step', name: 'say hello', state: 'started' });
        assert.deepStrictEqual(lines.find((l) => l.name === 'say hello' && l.state === 'completed'), { t: 'step', name: 'say hello', state: 'completed', conclusion: 'success', ms: 12 });
        assert.ok(lines.some((l) => l.t === 'step' && l.text === 'hello'));
        assert.ok(result.log_tail.includes('hello') && result.log_tail.includes('Job succeeded'));
        assert.ok(result.ms >= 0);

        // The pinned release is a real, reproducible constant (and a wrong digest is refused before anything runs).
        assert.match(ACT_VERSION, /^\d+\.\d+\.\d+$/);
        assert.strictEqual(ACT_URL, `https://github.com/nektos/act/releases/download/v${ACT_VERSION}/act_Linux_x86_64.tar.gz`);
        assert.match(ACT_SHA256, /^[0-9a-f]{64}$/);
        await assert.rejects(prepareAct(tmpDir('codes-check-act-'), {
            env: {},
            fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('not the act release') }),
        }), /sha256/);
    });

    await check('a failed act job is a failure, its step and output are kept, and tokens in the log are scrubbed', async () => {
        const repo = repository({ 'ci.yml': workflow() });
        const stub = stubAct({
            output: [
                '[ci/test] ⭐ Run Main fail me',
                '[ci/test]   | token ghp_abcdefghijklmnopqrstuvwxyz0123 and https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/a/b.git',
                '[ci/test]   ❌  Failure - Main fail me [5.317803ms]',
                '[ci/test] 🏁  Job failed',
            ].join('\n') + '\n',
            code: 1,
        });
        const lines = [];
        const result = await runCheck({
            input: checkInput(repo), emit: (l) => lines.push(JSON.parse(l)), writeResult: () => {},
            env: { ...env, OPENVIBE_CODES_ACT_BIN: stub.script }, tmp: tmpDir('codes-check-tmp-'),
        });
        assert.deepStrictEqual([result.ok, result.conclusion], [false, 'failure']);
        assert.match(result.reason, /exit code 1/);
        assert.deepStrictEqual(result.steps, [{ name: 'fail me', conclusion: 'failure', ms: 5 }]);
        assert.ok(!/ghp_abcdefghijklmnopqrstuvwxyz0123/.test(JSON.stringify(result)), 'the result carries no token');
        assert.ok(!/ghp_abcdefghijklmnopqrstuvwxyz0123/.test(JSON.stringify(lines)), 'no line carries a token');
        assert.ok(result.log_tail.includes('Job failed'));
        assert.ok(!/x-access-token:/.test(result.log_tail));
    });

    await check('a timeout stops act and answers timed_out', async () => {
        const repo = repository({ 'ci.yml': workflow() });
        const stub = stubAct({ sleep: 30_000 });
        const started = Date.now();
        const result = await runCheck({
            input: checkInput(repo, { timeout_ms: 250 }), emit: () => {}, writeResult: () => {},
            env: { ...env, OPENVIBE_CODES_ACT_BIN: stub.script }, tmp: tmpDir('codes-check-tmp-'),
        });
        assert.deepStrictEqual([result.ok, result.conclusion], [false, 'timed_out']);
        assert.match(result.reason, /250 ms/);
        assert.ok(Date.now() - started < 10_000, 'the stub did not outlive its timeout');
    });

    await check('act output lines and the 16 KB tail', () => {
        assert.deepStrictEqual(parseActLine('[ci/test] ⭐ Run Main say hello'), { type: 'started', phase: 'Main', name: 'say hello' });
        assert.deepStrictEqual(parseActLine('[ci/test]   ✅  Success - Main say hello [11.75651ms]'), { type: 'completed', phase: 'Main', name: 'say hello', conclusion: 'success', ms: 12 });
        assert.deepStrictEqual(parseActLine('[ci/test]   ✅  Success - Main slow [1m2.3s]'), { type: 'completed', phase: 'Main', name: 'slow', conclusion: 'success', ms: 62_300 });
        assert.deepStrictEqual(parseActLine('[ci/test]   ⚠️  Skipped - Post cleanup'), { type: 'completed', phase: 'Post', name: 'cleanup', conclusion: 'skipped', ms: null });
        assert.strictEqual(outputText('[ci/test]   | hello'), 'hello');
        assert.strictEqual(outputText('time="2026" level=info msg="using docker"'), 'time="2026" level=info msg="using docker"');
        const big = `${'x'.repeat(30_000)} ghp_abcdefghijklmnopqrstuvwxyz0123`;
        const cut = tail(big);
        assert.ok(cut.length <= 16 * 1024);
        assert.ok(!/ghp_abcdefghijklmnopqrstuvwxyz0123/.test(cut));
    });

    for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
    done();
})().catch((e) => { console.error(e); process.exit(1); });
