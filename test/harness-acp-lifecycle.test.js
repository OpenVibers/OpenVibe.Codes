'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getEventListeners } = require('events');
const { acpAgent } = require('../harness/adapters/acp');
const { check, done } = require('./helpers/boot');

const fixture = path.join(__dirname, 'fixtures', 'acp-lifecycle-agent.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const collect = async (run) => { const events = []; for await (const e of run) events.push(e); return events; };

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-acp-lifecycle-'));
    let serial = 0;
    async function exercise(mode, task = {}, act = null, limit = 2500) {
        const logFile = path.join(dir, `${serial++}.jsonl`);
        const seen = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
        const killFixture = () => { const pid = seen().find((row) => row.pid)?.pid; if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } } };
        const agent = acpAgent({ id: 'lifecycle', name: 'Lifecycle ACP', cmd: process.execPath, args: [fixture, mode, logFile] });
        const started = Date.now();
        const run = agent.start({ prompt: 'test', cwd: dir, permission: 'read', timeoutMs: 15_000, ...task });
        const collected = collect(run);
        let expired = false;
        // A broken implementation must fail without leaking its fixture or hanging the test runner.
        const watchdog = setTimeout(() => { expired = true; killFixture(); }, limit);
        try {
            const until = async (method) => {
                while (!seen().some((row) => row.method === method)) {
                    assert.ok(Date.now() - started < 2000, `${method} was never sent`);
                    await sleep(10);
                }
            };
            if (act) await act(run, until);
            const events = await collected;
            assert.strictEqual(expired, false, `${mode}: fixture needed the ${limit}ms test watchdog to stop`);
            const results = events.filter((e) => e.type === 'result');
            assert.strictEqual(results.length, 1, 'exactly one terminal result');
            return { events, result: results[0], log: seen(), elapsed: Date.now() - started };
        } finally {
            clearTimeout(watchdog);
            killFixture();
            await collected;
        }
    }

    await check('an already aborted task never launches an ACP process', async () => {
        const controller = new AbortController(); controller.abort();
        const r = await exercise('success', { signal: controller.signal });
        assert.strictEqual(r.result.is_error, true);
        assert.match(r.result.result, /was stopped/);
        assert.deepStrictEqual(r.log, [], 'no process, initialization or session creation');
    });

    for (const method of ['initialize', 'session/new', 'session/load', 'session/set_model']) {
        await check(`cancelling during ${method} promptly stops setup`, async () => {
            const controller = new AbortController();
            const task = { signal: controller.signal, ...(method === 'session/load' ? { resume: 'lifecycle' } : {}), ...(method === 'session/set_model' ? { model: 'chosen' } : {}) };
            const r = await exercise(`hang:${method}`, task, async (run, until) => { await until(method); controller.abort(); run.cancel(); });
            assert.strictEqual(r.result.is_error, true);
            assert.match(r.result.result, /was stopped/);
            assert.ok(!r.log.some((row) => row.method === 'session/prompt'), 'no prompt after cancelling setup');
        });
    }

    await check('cancellation remains stopped when the agent answers end_turn', async () => {
        const r = await exercise('late-end', {}, async (run, until) => { await until('session/prompt'); run.cancel(); run.cancel(); });
        assert.strictEqual(r.result.is_error, true);
        assert.match(r.result.result, /was stopped/);
        assert.strictEqual(r.log.filter((row) => row.method === 'session/cancel').length, 1);
    });

    await check('a completed turn retires a child that ignores EOF and SIGTERM', async () => {
        const r = await exercise('stubborn', {}, null, 6500);
        assert.strictEqual(r.result.is_error, false, r.result.result);
        assert.ok(r.log.some((row) => row.signal === 'SIGTERM'), 'tried graceful termination first');
        const pid = r.log.find((row) => row.pid).pid;
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the spawned child is gone');
        console.log(`    stubborn child retired in ${r.elapsed}ms`);
    });

    await check('a time limit also retires a child that ignores EOF and SIGTERM', async () => {
        const r = await exercise('timeout', { timeoutMs: 200 }, null, 7000);
        assert.strictEqual(r.result.is_error, true);
        assert.match(r.result.result, /time limit/);
        assert.ok(r.log.some((row) => row.signal === 'SIGTERM'));
        console.log(`    timed-out child retired in ${r.elapsed}ms`);
    });

    await check('a finished run removes its abort listener', async () => {
        const controller = new AbortController();
        const r = await exercise('success', { signal: controller.signal });
        assert.strictEqual(r.result.is_error, false);
        assert.strictEqual(getEventListeners(controller.signal, 'abort').length, 0);
        controller.abort();
    });

    await check('a result without stopReason is a finished turn (some agents leave it out)', async () => {
        const r = await exercise('missing');
        assert.strictEqual(r.result.is_error, false);
        assert.ok(r.events.some((e) => e.type === 'assistant' && e.message.content.some((c) => c.text === 'Partial answer.')));
    });

    for (const mode of ['null', 'no-result', 'empty-reason', 'bad-reason', 'unknown-reason']) {
        await check(`${mode} completion fails while retaining received text`, async () => {
            const r = await exercise(mode);
            assert.strictEqual(r.result.is_error, true, 'malformed completion is not success');
            assert.match(r.result.result, /invalid.*stopReason/i);
            assert.ok(r.events.some((e) => e.type === 'assistant' && e.message.content.some((c) => c.text === 'Partial answer.')));
        });
    }

    await check('valid empty end_turn succeeds and max_tokens remains a failure', async () => {
        assert.strictEqual((await exercise('empty-success')).result.is_error, false);
        const r = await exercise('max_tokens');
        assert.strictEqual(r.result.is_error, true);
        assert.match(r.result.result, /stopped: max_tokens/);
    });
    fs.rmSync(dir, { recursive: true, force: true });
    done();
})().catch((err) => { console.error(err); process.exit(1); });
