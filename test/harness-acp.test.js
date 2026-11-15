'use strict';
/**
 * The ACP adapter (harness/adapters/acp.js) against a stand-in ACP agent (test/fixtures/acp-mock-agent.js): the session
 * opens, the agent's text, tool calls and results become Codes' events; its file reads and writes go through this client
 * inside the working directory only; its permission requests are answered by the task's level (read, edit, full); a
 * model the agent offers is set; resume loads the earlier session without replaying it as new text; a stop cancels the
 * turn; an agent that dies mid-turn is a failure in words. And every npx/uvx agent in harness/acp-agents.json has a
 * launch line pinned to an exact version.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { acpAgent, launchOf, permissionChoice, contentText } = require('../harness/adapters/acp');
const { check, done } = require('./helpers/boot');

const MOCK = path.join(__dirname, 'fixtures', 'acp-mock-agent.js');
const collect = async (run) => { const out = []; for await (const e of run) out.push(e); return out; };

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-acp-'));
    const work = path.join(dir, 'work');
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, 'note.txt'), 'hello from the note\nsecond line\n');
    const logFile = path.join(dir, 'mock.log');
    const agent = acpAgent({ id: 'mock-acp', name: 'Mock ACP', cmd: process.execPath, args: [MOCK], env: { MOCK_ACP_LOG: logFile } });
    const seen = () => fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const reset = () => { fs.writeFileSync(logFile, ''); fs.rmSync(path.join(work, 'out.txt'), { force: true }); };
    const result = (events) => events.find((e) => e.type === 'result');

    await check('an edit task: text, a tool call and its result, the file read and written through the client, edit allowed and a command refused', async () => {
        reset();
        const events = await collect(agent.start({ prompt: 'do it', cwd: work, permission: 'edit' }, { env: {} }));
        const r = result(events);
        assert.strictEqual(r.is_error, false, r.result);
        assert.strictEqual(r.result, 'Done: hello from the note');
        assert.strictEqual(r.session_id, 'mock-1');
        assert.ok(Math.abs(r.total_cost_usd - 0.0125) < 1e-9, 'the cost the agent reported');
        const init = events.find((e) => e.subtype === 'init');
        assert.strictEqual(init.session_id, 'mock-1');
        const texts = events.filter((e) => e.type === 'assistant' && e.message.content[0].type === 'text').map((e) => e.message.content[0].text);
        assert.deepStrictEqual(texts, ['Reading the note.', 'Done: hello from the note'], 'chunks joined into whole messages');
        const use = events.find((e) => e.type === 'assistant' && e.message.content[0].type === 'tool_use');
        assert.deepStrictEqual([use.message.content[0].id, use.message.content[0].name], ['t1', 'Read note.txt']);
        const res = events.find((e) => e.type === 'user').message.content[0];
        assert.deepStrictEqual([res.tool_use_id, res.content, res.is_error], ['t1', 'hello from the note', false]);
        assert.ok(events.some((e) => e.subtype === 'warning' && /plan: · read the note/.test(e.text)), 'the plan is shown');
        assert.strictEqual(fs.readFileSync(path.join(work, 'out.txt'), 'utf8'), 'written by the agent\n');
        const log = seen();
        assert.deepStrictEqual(log.find((m) => m.permission_edit).permission_edit, { outcome: { outcome: 'selected', optionId: 'yes' } });
        assert.deepStrictEqual(log.find((m) => m.permission_execute).permission_execute, { outcome: { outcome: 'selected', optionId: 'skip' } }, 'a command needs full');
        assert.strictEqual(log.find((m) => m.read).read.result.content, 'hello from the note', 'line and limit honoured');
        const initMsg = log.find((m) => m.method === 'initialize');
        assert.deepStrictEqual([initMsg.params.protocolVersion, initMsg.params.clientCapabilities.fs], [1, { readTextFile: true, writeTextFile: true }]);
        assert.deepStrictEqual(log.find((m) => m.method === 'session/new').params, { cwd: fs.realpathSync(work) === work ? work : path.resolve(work), mcpServers: [] });
    });

    await check('a read task writes nothing: the edit is refused and so is the write', async () => {
        reset();
        const events = await collect(agent.start({ prompt: 'do it', cwd: work, permission: 'read' }, { env: {} }));
        assert.strictEqual(result(events).is_error, false);
        assert.ok(!fs.existsSync(path.join(work, 'out.txt')), 'nothing written');
        assert.deepStrictEqual(seen().find((m) => m.permission_edit).permission_edit, { outcome: { outcome: 'selected', optionId: 'no' } });
        assert.ok(events.some((e) => e.subtype === 'warning' && /refused at the read level/.test(e.text)));
    });

    await check('a full task allows the command', async () => {
        reset();
        await collect(agent.start({ prompt: 'do it', cwd: work, permission: 'full' }, { env: {} }));
        assert.deepStrictEqual(seen().find((m) => m.permission_execute).permission_execute, { outcome: { outcome: 'selected', optionId: 'run' } });
    });

    await check('a model the agent offers is set; one it does not offer is said so', async () => {
        reset();
        await collect(agent.start({ prompt: 'do it', cwd: work, permission: 'read', model: 'mock-large' }, { env: {} }));
        assert.deepStrictEqual(seen().find((m) => m.method === 'session/set_model').params, { sessionId: 'mock-1', modelId: 'mock-large' });
        reset();
        const events = await collect(agent.start({ prompt: 'do it', cwd: work, permission: 'read', model: 'gpt-nope' }, { env: {} }));
        assert.ok(!seen().some((m) => m.method === 'session/set_model'));
        assert.ok(events.some((e) => e.subtype === 'warning' && /does not offer the model gpt-nope/.test(e.text)));
    });

    await check('resume loads the earlier session and does not replay it as new text', async () => {
        reset();
        const events = await collect(agent.start({ prompt: 'do it', cwd: work, permission: 'read', resume: 'mock-1' }, { env: {} }));
        assert.deepStrictEqual(seen().find((m) => m.method === 'session/load').params, { sessionId: 'mock-1', cwd: path.resolve(work), mcpServers: [] });
        assert.ok(!seen().some((m) => m.method === 'session/new'));
        assert.ok(!events.some((e) => e.type === 'assistant' && /the earlier answer/.test(JSON.stringify(e))), 'the replay stays out of the stream');
        assert.strictEqual(result(events).result, 'Done: hello from the note');
    });

    await check('a stop cancels the turn: session/cancel, then a stopped result', async () => {
        reset();
        const run = agent.start({ prompt: 'wait', cwd: work, permission: 'read' }, { env: {} });
        const events = [];
        const t0 = Date.now();
        for await (const e of run) { events.push(e); if (e.subtype === 'init') setTimeout(() => run.cancel(), 50); }
        assert.ok(Date.now() - t0 < 5000, 'ended at once, not after the kill timer');
        const r = result(events);
        assert.strictEqual(r.is_error, true);
        assert.match(r.result, /was stopped/);
        assert.ok(seen().some((m) => m.method === 'session/cancel' && m.params.sessionId === 'mock-1'));
    });

    await check('a read outside the working directory is refused; an agent that dies mid-turn fails in words', async () => {
        reset();
        await collect(agent.start({ prompt: 'escape', cwd: work, permission: 'full' }, { env: {} }));
        const esc = seen().find((m) => m.escape).escape;
        assert.ok(esc.error && /outside the working directory/.test(esc.error.message), JSON.stringify(esc));
        reset();
        const events = await collect(agent.start({ prompt: 'die', cwd: work, permission: 'read' }, { env: {} }));
        const r = result(events);
        assert.strictEqual(r.is_error, true);
        assert.match(r.result, /Mock ACP: Mock ACP ended/);
        const limited = result(await collect(agent.start({ prompt: 'limit', cwd: work, permission: 'read' }, { env: {} })));
        assert.strictEqual(limited.result, 'Mock ACP: Internal error (it said: You have hit your usage limit.)', 'the agent\'s own words ride a bare error');
        const missing = await collect(acpAgent({ id: 'nope', name: 'Nope', cmd: path.join(dir, 'no-such-agent') }).start({ prompt: 'x', cwd: work }, { env: {} }));
        assert.strictEqual(result(missing).is_error, true);
    });

    await check('permission choices, content words and registry launch lines', async () => {
        const opts = [{ optionId: 'a', kind: 'allow_always' }, { optionId: 'o', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }];
        assert.deepStrictEqual(permissionChoice({ toolCall: { kind: 'read' }, options: opts }, 1), { allowed: true, optionId: 'o' }, 'once before always');
        assert.deepStrictEqual(permissionChoice({ toolCall: { kind: 'edit' }, options: opts }, 1), { allowed: false, optionId: 'r' });
        assert.deepStrictEqual(permissionChoice({ toolCall: { kind: 'something_new' }, options: opts }, 2), { allowed: false, optionId: 'r' }, 'an unknown kind needs full');
        assert.deepStrictEqual(permissionChoice({ toolCall: { kind: 'edit' }, options: [] }, 3), { allowed: true, optionId: null });
        assert.strictEqual(contentText([{ type: 'content', content: { type: 'text', text: 'a' } }, { type: 'diff', path: 'x.js', oldText: '1', newText: '2' }]), 'a\nchanged x.js');
        assert.deepStrictEqual(launchOf({ distribution: { npx: { package: '@google/gemini-cli@0.68.0', args: ['--acp'] } } }), { cmd: 'npx', args: ['-y', '@google/gemini-cli@0.68.0', '--acp'], env: {} });
        assert.deepStrictEqual(launchOf({ distribution: { uvx: { package: 'fast-agent-acp==0.10.1', args: ['-x'] } } }), { cmd: 'uvx', args: ['fast-agent-acp==0.10.1', '-x'], env: {} });
        assert.strictEqual(launchOf({ distribution: { binary: {} } }), null, 'a binary is not run');
        const agents = require('../harness/acp-agents.json').agents;
        assert.ok(agents.length >= 8);
        for (const a of agents) {
            assert.ok(/^[a-z0-9][a-z0-9-]{0,39}$/.test(a.id), a.id);
            const l = launchOf(a);
            assert.ok(l, `${a.id} has an npx or uvx launch`);
            assert.ok(/@\d+\.\d+\.\d+|==\d+\.\d+\.\d+/.test(l.args.join(' ')), `${a.id} is pinned to an exact version`);
        }
    });

    fs.rmSync(dir, { recursive: true, force: true });
    done();
})().catch((e) => { console.error(e); process.exit(1); });
