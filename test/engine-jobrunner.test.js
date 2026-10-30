'use strict';
/** One attempt of one harness, the way the portal runs one (engine/jobrunner.js). */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, done } = require('./helpers/boot');
const { runAttempt } = require('../engine/jobrunner');
const fakesecrets = require('./helpers/fakesecrets');

/** A stand-in for a CLI: it prints what the real one prints. */
function fake(dir, name, lines) {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const script = ['#!/usr/bin/env node', ...lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`)].join('\n');
    fs.writeFileSync(path.join(bin, name), script);
    fs.chmodSync(path.join(bin, name), 0o755);
    return bin;
}

(async () => {
    await check('an attempt for a harness that does not exist is an error', async () => {
        await assert.rejects(() => runAttempt({ agent: 'nope', prompt: 'x', cwd: os.tmpdir() }), /no adapter/);
    });

    await check('an attempt reports the harness, the session and the answer', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-'));
        const bin = fake(dir, 'cmd', [
            { type: 'event', event: { type: 'run_start', sessionId: 's-1' } },
            { type: 'result', subtype: 'success', finalText: 'landed', sessionId: 's-1' },
        ]);
        const res = await runAttempt({
            agent: 'command-code', prompt: 'do it', cwd: dir, log: path.join(dir, 'f.jsonl'),
            env: { PATH: `${bin}:${process.env.PATH}` },
        });
        assert.equal(res.agent, 'command-code');
        assert.equal(res.sessionId, 's-1');
        assert.equal(res.summary, 'landed');
        assert.equal(res.ok, true);
        assert.ok(fs.existsSync(res.log), 'the feed is kept');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await check('a harness that is not there ends the attempt without an answer', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr2-'));
        const res = await runAttempt({
            agent: 'command-code', prompt: 'x', cwd: dir, log: path.join(dir, 'f.jsonl'),
            env: { PATH: dir },                       // no cmd on this PATH
        });
        assert.equal(res.ok, false);
        assert.ok(res.summary.length > 0, 'the end says what happened');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await check('a secret in the harness\'s output never reaches the feed', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr3-'));
        const bin = fake(dir, 'cmd', [
            { type: 'result', subtype: 'success', finalText: `key ${fakesecrets.providerKey()}`, sessionId: 's' },
        ]);
        const res = await runAttempt({
            agent: 'command-code', prompt: 'x', cwd: dir, log: path.join(dir, 'f.jsonl'),
            env: { PATH: `${bin}:${process.env.PATH}` },
        });
        assert.ok(!fs.readFileSync(res.log, 'utf8').includes('abcdefghijklmnopqrstuvwx'), 'the key stayed out of the feed');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
