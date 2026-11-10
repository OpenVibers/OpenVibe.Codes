'use strict';
/**
 * The agent face of `openvibe-codes`: `--for-agent` (one compact JSON line per event, fixed fields, typed errors) and
 * `skills get` (the version-matched guide shipped inside the binary). The human log and --json stay as they were.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { version } = require('../package.json');
const { fakeAgents } = require('./helpers/fake-agents');
const { check, done } = require('./helpers/boot');

const BIN = path.join(__dirname, '..', 'bin', 'openvibe-codes.js');

(async () => {
    const f = fakeAgents({ codex: 'ok' });
    const cli = (...args) => {
        const r = spawnSync(process.execPath, [BIN, ...args], { cwd: f.work, env: { ...process.env, ...f.env }, encoding: 'utf8', timeout: 60_000 });
        return { code: r.status, out: r.stdout, err: r.stderr };
    };
    const lines = (out) => out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

    await check('skills get: the guide is shipped with this binary, at its version', () => {
        const r = cli('skills', 'get');
        assert.strictEqual(r.code, 0, r.err);
        assert.match(r.out, new RegExp(`Version: ${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
        assert.match(r.out, /--for-agent/);
        assert.match(r.out, /skills get/);
        assert.ok(!r.out.includes('{{version}}'), 'the version placeholder is replaced');
        const list = JSON.parse(cli('skills', 'list', '--json').out);
        assert.deepStrictEqual(list.map((g) => g.name), ['openvibe-codes']);
        assert.strictEqual(list[0].version, version);
        const where = cli('skills', 'path').out.trim();
        assert.ok(fs.existsSync(where), where);
        assert.strictEqual(cli('skills', 'get', 'nope').code, 1);
    });

    await check('run --for-agent: one compact JSON line per event, a fixed envelope and a bounded result', () => {
        const r = cli('run', '--agent', 'codex', '--no-handoff', '--for-agent', 'x'.repeat(1200));
        assert.strictEqual(r.code, 0, r.out + r.err);
        const rows = lines(r.out);
        assert.ok(rows.length >= 3, r.out);
        assert.strictEqual(rows[0].event, 'init');
        assert.strictEqual(rows[0].agent, 'codex');
        assert.ok(rows[0].run, 'the run id is on every line');
        assert.deepStrictEqual(rows.map((x) => x.seq), rows.map((_, i) => i + 1), 'seq counts the lines');
        assert.ok(rows.every((x) => x.run === rows[0].run));
        assert.ok(rows.some((x) => x.event === 'tool' && x.ref === 'a.js'), r.out);
        const result = rows[rows.length - 1];
        assert.strictEqual(result.event, 'result');
        assert.strictEqual(result.ok, true);
        assert.ok(result.text.length <= 400, 'the answer is bounded');
        assert.ok(!/\x1b\[/.test(r.out), 'no ANSI in the agent output');
        assert.ok(!r.out.includes('▶'), 'not the human log');
    });

    await check('a failed run ends with {code, retry, suggestion}; a missing agent is unavailable', () => {
        f.env.FAKE_CODEX = 'fail';
        const r = cli('run', '--agent', 'codex', '--no-handoff', '--for-agent', 'x');
        assert.strictEqual(r.code, 1);
        const result = lines(r.out).pop();
        assert.strictEqual(result.event, 'result');
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.code, 'agent_failed');
        assert.strictEqual(result.retry, false);
        assert.match(result.suggestion, /resume/);
        f.env.FAKE_CODEX = 'ok';

        const missing = cli('run', '--agent', 'not-an-agent', '--for-agent', 'x');
        assert.strictEqual(missing.code, 1);
        const refused = lines(missing.out).pop();
        assert.strictEqual(refused.code, 'unavailable');
        assert.strictEqual(refused.retry, false);
        assert.match(refused.suggestion, /agents --for-agent/);

        const none = cli('run', '--for-agent');
        assert.strictEqual(none.code, 1);
        assert.strictEqual(lines(none.out)[0].code, 'no_prompt');
    });

    await check('show, runs, agents and route answer the same envelope', () => {
        const run = cli('run', '--agent', 'codex', '--no-handoff', '--for-agent', 'hello');
        const runId = lines(run.out)[0].run;
        const show = cli('show', runId, '--for-agent');
        assert.strictEqual(show.code, 0, show.out + show.err);
        const rows = lines(show.out);
        assert.deepStrictEqual(rows.map((x) => x.event), ['run', 'attempt', 'result']);
        assert.strictEqual(rows[0].run, runId);
        assert.strictEqual(rows[2].ok, true);
        assert.strictEqual(cli('show', 'run_nope', '--for-agent').code, 1);

        const runs = lines(cli('runs', '--for-agent').out);
        assert.ok(runs.some((x) => x.run === runId && x.event === 'run'));

        const agents = lines(cli('agents', '--for-agent').out);
        assert.ok(agents.find((a) => a.id === 'codex' && a.available === true));
        assert.ok(agents.find((a) => a.id === 'aider' && a.available === false && a.reason));

        const route = lines(cli('route', '--task', 'review', '--for-agent').out);
        assert.strictEqual(route.length, 1);
        assert.strictEqual(route[0].event, 'route');
        assert.ok(route[0].selected);
    });

    f.cleanup();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
