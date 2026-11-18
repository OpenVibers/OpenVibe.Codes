'use strict';
/**
 * The API harness's second compaction tier (harness/adapters/api.js compactPlan): a resumed conversation still over its
 * limit after old tool output is dropped has its earlier turns replaced by a summary the model writes. The task (the
 * first words) and the current turn stay; the cut falls on a person's message so tool calls keep their results; a
 * summary that fails leaves the conversation as it was; compact: false turns it off.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createHarness } = require('../harness');
const { createStore } = require('../harness/sessions');
const { compactPlan, spanTranscript } = require('../harness/adapters/api');
const { check, done } = require('./helpers/boot');

const collect = async (run) => { const out = []; for await (const e of run) out.push(e); return out; };

(async () => {
    const requests = [];
    let answers = [];
    let summaryMode = 'ok';
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            const b = JSON.parse(body);
            requests.push(b);
            const summary = !b.tools && /^You compress/.test(b.messages[0].content);
            if (summary && summaryMode === 'fail') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"message":"down"}}'); return; }
            const content = summary ? 'SUMMARY: task one and two are done; a.js was read.' : (answers.shift() || 'done');
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-compact-'));
    const work = path.join(dir, 'work');
    fs.mkdirSync(work);
    const env = { PATH: path.dirname(process.execPath), OPENVIBE_CODES_HOME: path.join(dir, 'home'), OPENVIBE_CODES_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OPENVIBE_CODES_MODEL: 'tiny', OPENVIBE_CODES_API_KEY: 'k', OPENVIBE_CODES_RG: 'off', OPENVIBE_CODES_RETRY_MS: '0' };
    const h = createHarness({ env, store: createStore({ env }) });
    const run = (prompt, opts = {}) => collect(h.run({ prompt, agent: 'openai-compatible', cwd: work, permission: 'read', handoff: false, ...opts }));
    const sessionOf = (events) => events.find((e) => e.type === 'result').session_id;

    // Two long turns in one session: 60,000 characters of answers.
    answers = ['A'.repeat(30_000)];
    const s1 = sessionOf(await run('task one: read a.js'));
    answers = ['B'.repeat(30_000)];
    const s2 = sessionOf(await run('task two', { resume: s1, task: 'resume' }));
    assert.strictEqual(s2, s1, 'one session');

    await check('over the limit: the earlier turns become a summary; the task and the current turn stay', async () => {
        requests.length = 0;
        answers = ['done three'];
        const events = await run('task three', { resume: s1, task: 'resume', adapterOptions: { contextChars: 40_000 } });
        const r = events.find((e) => e.type === 'result');
        assert.strictEqual(r.is_error, false, r.result);
        assert.strictEqual(r.result, 'done three');
        assert.strictEqual(requests.length, 2, 'the summary, then the turn');
        assert.ok(!requests[0].tools && /A{100}/.test(requests[0].messages[1].content) && /\[person\] task two/.test(requests[0].messages[1].content), 'the span went to the summary');
        const sent = requests[1].messages;
        assert.deepStrictEqual(sent.map((m) => m.role), ['system', 'user', 'user', 'user']);
        assert.strictEqual(sent[1].content, 'task one: read a.js', 'the task stays word for word');
        assert.ok(sent[2].content.startsWith('[The earlier conversation, summarized to save context]\nSUMMARY: task one and two'));
        assert.strictEqual(sent[3].content, 'task three');
        assert.ok(!JSON.stringify(sent).includes('A'.repeat(1000)), 'the long turns are gone');
        assert.ok(events.some((e) => e.subtype === 'warning' && /3 messages\) was summarized/.test(e.text)));
        assert.strictEqual(r.usage.input_tokens + (r.usage.cache_read_input_tokens || 0), 200, 'the summary\'s tokens count');
    });

    await check('a summary that fails leaves the conversation as it was; compact: false never asks', async () => {
        answers = ['C'.repeat(30_000)];
        const s3 = sessionOf(await run('task one again'));
        answers = ['D'.repeat(30_000)];
        await run('more', { resume: s3, task: 'resume' });
        requests.length = 0;
        summaryMode = 'fail';
        answers = ['still fine'];
        const events = await run('last', { resume: s3, task: 'resume', adapterOptions: { contextChars: 40_000 } });
        assert.strictEqual(events.find((e) => e.type === 'result').result, 'still fine');
        assert.ok(events.some((e) => e.subtype === 'warning' && /could not be summarized \(HTTP 500\)/.test(e.text)));
        assert.ok(JSON.stringify(requests[1].messages).includes('C'.repeat(1000)), 'sent as it was');
        summaryMode = 'ok';
        requests.length = 0;
        answers = ['off'];
        await run('and again', { resume: s3, task: 'resume', adapterOptions: { contextChars: 40_000, compact: false } });
        assert.strictEqual(requests.length, 1, 'no summary call');
    });

    await check('the plan: nothing under the limit, never the task or the current turn, always at a person\'s message', async () => {
        const big = (n) => 'x'.repeat(n);
        const sys = { role: 'system', content: 's' };
        assert.strictEqual(compactPlan([sys, { role: 'user', content: 'task' }, { role: 'assistant', content: big(50) }], 100), null);
        assert.strictEqual(compactPlan([sys, { role: 'user', content: 'task' }, { role: 'assistant', content: big(90_000) }], 20_000), null, 'one turn: nothing before it to summarize');
        const convo = [sys, { role: 'user', content: 'task' },
            { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'c1', content: big(30_000) },
            { role: 'user', content: 'next' }, { role: 'assistant', content: big(30_000) }, { role: 'user', content: 'now' }];
        const plan = compactPlan(convo, 40_000);
        assert.deepStrictEqual(plan, { from: 2, to: 6 }, 'the call and its result go together; the current turn stays');
        assert.strictEqual(convo[plan.to].role, 'user');
        assert.match(spanTranscript(convo.slice(2, 4)), /^\[agent called\] read_file\(\{\}\)\n\[tool result\] x+/);
    });

    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    done();
})().catch((e) => { console.error(e); process.exit(1); });
