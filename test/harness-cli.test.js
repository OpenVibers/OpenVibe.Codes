'use strict';
/**
 * The `openvibe-codes` command (bin/openvibe-codes.js) with stand-in agents on PATH: agents, route, run (a readable log
 * and --json), runs, show and resume, and the exit code following the result.
 */
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { fakeAgents } = require('./helpers/fake-agents');
const { check, done } = require('./helpers/boot');

const BIN = path.join(__dirname, '..', 'bin', 'openvibe-codes.js');

(async () => {
    const f = fakeAgents({ codex: 'fail' });
    const cli = (...args) => {
        const r = spawnSync(process.execPath, [BIN, ...args], { cwd: f.work, env: { ...process.env, ...f.env }, encoding: 'utf8', timeout: 60_000 });
        return { code: r.status, out: r.stdout, err: r.stderr };
    };

    await check('agents: what is here and why not the rest', () => {
        const r = cli('agents');
        assert.strictEqual(r.code, 0, r.err);
        assert.match(r.out, /✔ claude-code/);
        assert.match(r.out, /· aider .*not on PATH/);
        const json = JSON.parse(cli('agents', '--json').out);
        assert.ok(json.find((a) => a.id === 'codex').available);
    });

    await check('route: the decision, its reasons and every candidate', () => {
        const r = cli('route', '--task', 'review');
        assert.strictEqual(r.code, 0, r.err);
        assert.match(r.out, /^→ \S+:/m);
        assert.match(r.out, /aider:aider-default — `aider` is not on PATH/);
    });

    let runId;
    await check('run: a readable log, a hand-off, and exit 0 when the last agent succeeded', () => {
        const r = cli('run', '--agent', 'codex', 'rename', 'the', 'variable');
        assert.strictEqual(r.code, 0, r.out + r.err);
        runId = (r.out.match(/^run (run_\S+)/m) || [])[1];
        assert.ok(runId, r.out);
        assert.match(r.out, /▶ codex/);
        assert.match(r.out, /⇢ handing over from codex: .*usage limit/);
        assert.match(r.out, /✔ done/);
    });

    await check('run --json: one event per line, ending with the result', () => {
        const r = cli('run', '--agent', 'claude-code', '--no-handoff', '--json', 'x');
        const lines = r.out.trim().split('\n').map((l) => JSON.parse(l));
        assert.strictEqual(lines[0].subtype, 'init');
        assert.strictEqual(lines[lines.length - 1].type, 'result');
        assert.strictEqual(r.code, 0);
    });

    await check('runs, show and resume', () => {
        const list = cli('runs');
        assert.ok(list.out.includes(runId), list.out);
        assert.match(list.out, /codex ⇢ /);
        const show = cli('show', runId);
        assert.strictEqual(show.code, 0);
        assert.match(show.out, /✗ codex/);
        const events = cli('show', runId, '--json').out.trim().split('\n').map((l) => JSON.parse(l));
        assert.ok(events.some((e) => e.subtype === 'handoff'));
        const resumed = cli('resume', runId, 'and', 'add', 'a', 'test');
        assert.strictEqual(resumed.code, 0, resumed.out + resumed.err);
        assert.match(resumed.out, /did: and add a test/);
        assert.strictEqual(cli('resume', 'run_nope', 'x').code, 1);
    });

    await check('a failed run exits 1', () => {
        assert.strictEqual(cli('run', '--agent', 'codex', '--no-handoff', 'x').code, 1);
        assert.strictEqual(cli('run').code, 1, 'no prompt');
    });

    f.cleanup();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
