'use strict';
/**
 * The harness (harness/index.js) against stand-in agents (test/helpers/fake-agents.js): every CLI adapter turns its
 * agent's output into the shared events with one result; availability comes from PATH and keys; routing leaves out
 * what is not here and says why; a failed or silent attempt hands the task to the next agent with a note on what was
 * done; a crash ends with a reason whose secrets are redacted; runs and their events are kept for `show` and `resume`.
 */
const assert = require('assert');
const { createHarness } = require('../harness');
const { createStore } = require('../harness/sessions');
const { fakeAgents } = require('./helpers/fake-agents');
const { check, done } = require('./helpers/boot');

const collect = async (run) => { const out = []; for await (const e of run) out.push(e); return out; };
const texts = (events) => events.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content.filter((c) => c.type === 'text').map((c) => c.text));
const results = (events) => events.filter((e) => e.type === 'result');

(async () => {
    const f = fakeAgents();
    const harness = (env = f.env) => createHarness({ env, store: createStore({ env }) });

    await check('availability: the CLIs on PATH are here; an API agent needs its key; the reason names what to do', () => {
        const list = harness().agents();
        const by = Object.fromEntries(list.map((a) => [a.id, a]));
        for (const id of ['claude-code', 'codex', 'opencode', 'command-code']) assert.strictEqual(by[id].available, true, id);
        assert.strictEqual(by.aider.available, false);
        assert.match(by.aider.reason, /not on PATH/);
        assert.strictEqual(by.deepseek.available, false);
        assert.match(by.deepseek.reason, /DEEPSEEK_API_KEY/);
        assert.strictEqual(harness({ ...f.env, DEEPSEEK_API_KEY: 'x' }).agents().find((a) => a.id === 'deepseek').available, true);
    });

    await check('routing goes to an available agent; the rest are listed with why', () => {
        const d = harness().route({ task: 'edit' });
        assert.ok(d.selected, JSON.stringify(d));
        assert.ok(['claude-code', 'codex', 'opencode', 'command-code'].includes(d.selected.split(':')[0]), d.selected);
        const aider = d.candidates.find((c) => c.id.startsWith('aider:'));
        assert.strictEqual(aider.included, false);
        assert.match(aider.reason, /not on PATH/);
        const none = createHarness({ env: { PATH: '/nonexistent', OPENVIBE_CODES_HOME: f.env.OPENVIBE_CODES_HOME } }).route({ task: 'edit' });
        assert.strictEqual(none.selected, null);
    });

    for (const [agent, word] of [['claude-code', 'claude'], ['codex', 'codex'], ['opencode', 'opencode'], ['command-code', 'cmd']]) {
        await check(`${agent}: the agent's output becomes the shared events, with one result`, async () => {
            const events = await collect(harness().run({ prompt: 'fix a.js', agent, cwd: f.work, handoff: false }));
            assert.strictEqual(events[0].type, 'system');
            assert.strictEqual(events[0].subtype, 'init');
            assert.ok(events[0].session_id, 'a session id to resume');
            assert.ok(events.some((e) => e.type === 'assistant' && e.message.content.some((c) => c.type === 'tool_use')), 'a tool call');
            assert.ok(events.some((e) => e.type === 'user' && e.message.content.some((c) => c.type === 'tool_result')), 'its result');
            const r = results(events);
            assert.strictEqual(r.length, 1, 'exactly one result');
            assert.strictEqual(r[0].is_error, false, r[0].result);
            assert.match(r[0].result, new RegExp(`${word} did: fix a\\.js`));
            assert.ok(r[0].usage && Number.isFinite(r[0].usage.input_tokens));
        });
    }

    await check('codex: cached input is counted as cache reads, not twice', async () => {
        const events = await collect(harness().run({ prompt: 'x', agent: 'codex', cwd: f.work, handoff: false }));
        const u = results(events)[0].usage;
        assert.deepStrictEqual([u.input_tokens, u.cache_read_input_tokens, u.output_tokens], [60, 40, 7]);
        assert.ok(events.some((e) => e.type === 'assistant' && e.message.content.some((c) => c.type === 'tool_use' && c.name === 'Edit' && c.input.file_path === 'a.js')), 'a file change is an Edit');
    });

    await check('a failed attempt hands the task to the next agent, with the task and what was done', async () => {
        const g = fakeAgents({ codex: 'fail' });
        const h = createHarness({ env: g.env, store: createStore({ env: g.env }) });
        const run = h.run({ prompt: 'rename the variable', agent: 'codex', cwd: g.work, maxAttempts: 3 });
        const events = await collect(run);
        const handoff = events.find((e) => e.type === 'system' && e.subtype === 'handoff');
        assert.ok(handoff, 'a hand-off event');
        assert.strictEqual(handoff.from, 'codex');
        assert.match(handoff.reason, /usage limit/);
        assert.strictEqual(events.filter((e) => e.type === 'system' && e.subtype === 'error').length, 1, 'one failure, reported once');
        const r = results(events);
        assert.strictEqual(r.length, 1, 'the run ends with one result: the last attempt\'s');
        assert.strictEqual(r[0].is_error, false);
        const answer = texts(events).pop();
        assert.match(answer, /taking over a coding task that Codex started/, 'the next agent got the hand-off note');
        assert.match(answer, /rename the variable/, 'with the original task');
        const s = run.summary();
        assert.deepStrictEqual(s.attempts.map((a) => [a.agent, a.ok]).slice(0, 1), [['codex', false]]);
        assert.strictEqual(s.attempts.length, 2);
        assert.ok(s.attempts[1].ok);
        assert.deepStrictEqual(h.store.loadRun(run.runId).attempts.length, 2, 'the run is kept');
        assert.ok(h.store.events(run.runId).some((e) => e.type === 'system' && e.subtype === 'handoff'));
        g.cleanup();
    });

    await check('--no-handoff stops at the first result', async () => {
        const g = fakeAgents({ codex: 'fail' });
        const events = await collect(createHarness({ env: g.env, store: createStore({ env: g.env }) }).run({ prompt: 'x', agent: 'codex', cwd: g.work, handoff: false }));
        assert.ok(!events.some((e) => e.subtype === 'handoff'));
        assert.strictEqual(results(events)[0].is_error, true);
        g.cleanup();
    });

    await check('an agent that goes quiet is stopped and the task handed on', async () => {
        const g = fakeAgents({ claude: 'hang' });
        const run = createHarness({ env: g.env, store: createStore({ env: g.env }) }).run({ prompt: 'x', agent: 'claude-code', cwd: g.work, stallMs: 400, maxAttempts: 2 });
        const events = await collect(run);
        const handoff = events.find((e) => e.subtype === 'handoff');
        assert.ok(handoff, 'handed on');
        assert.match(handoff.reason, /went quiet/);
        assert.strictEqual(results(events)[0].is_error, false, 'the next agent finished');
        g.cleanup();
    });

    await check('a crash ends with a reason a person can act on, and a key in it is redacted', async () => {
        const g = fakeAgents({ claude: 'crash' });
        const events = await collect(createHarness({ env: g.env, store: createStore({ env: g.env }) }).run({ prompt: 'x', agent: 'claude-code', cwd: g.work, handoff: false }));
        const r = results(events)[0];
        assert.strictEqual(r.is_error, true);
        assert.match(r.result, /ended without a result \(exit 3\)/);
        assert.ok(!r.result.includes('sk-test0123456789'), r.result);
        assert.match(r.result, /\[redacted\]/);
        g.cleanup();
    });

    await check('an agent that is not here is refused at once, with why', async () => {
        const events = await collect(harness().run({ prompt: 'x', agent: 'aider', cwd: f.work }));
        assert.strictEqual(results(events)[0].is_error, true);
        assert.match(results(events)[0].result, /not available here.*not on PATH/);
    });

    await check('a run needs a prompt and a known permission level', () => {
        assert.throws(() => harness().run({ prompt: ' ', cwd: f.work }), /needs a prompt/);
        assert.throws(() => harness().run({ prompt: 'x', permission: 'root', cwd: f.work }), /read, edit or full/);
    });

    f.cleanup();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
