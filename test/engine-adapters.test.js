'use strict';
/**
 * The adapters (C5): the argv and the environment each harness is started with, the feed each prints read into the one
 * transcript shape, the resume, the wrap-up after a budget stop, the effort fitted to the harness, and the secrets that
 * never reach the stream.
 *
 * The argv and the environment are the portal's (cc-run.sh, cx-run.sh, cm-run.sh, mm-run.sh, oc-run.sh), and the
 * DRY_RUN form of each is what a test can read without running a CLI.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, done } = require('./helpers/boot');
const fake = require('./helpers/fakesecrets');
const { adapterFor, ids } = require('../engine/adapters');
const { effortFor } = require('../engine/adapters/base');
const { claudeCode, claudeOther } = require('../engine/adapters/claude-code');
const { codex } = require('../engine/adapters/codex');
const { commandCode } = require('../engine/adapters/command-code');
const { opencode } = require('../engine/adapters/opencode');
const { minimaxCode } = require('../engine/adapters/minimax-code');
const transcript = require('../engine/transcript');
const { runAttempt } = require('../engine/jobrunner');
const { assemble } = require('../engine/prompt');
const { caps } = require('../engine/budget');

/** The DRY_RUN form of an adapter: the command, its arguments and its environment. */
function dry(adapter, ctx = {}) {
    const built = adapter.build({ prompt: 'do the thing', cwd: '/tmp/work', ...ctx });
    return { cmd: built.cmd, argv: built.argv, env: built.env, stdin: built.stdin };
}

(async () => {
    await check('every harness Codes can run is an adapter, and each one names the portal script it came from', () => {
        assert.deepStrictEqual(ids().sort(), ['claude-code', 'claude-other', 'codex', 'command-code', 'minimax-code', 'opencode']);
        for (const id of ids()) {
            const a = adapterFor(id);
            assert.ok(a.portal, `${id} names no portal script`);
            assert.ok(typeof a.build === 'function' && typeof a.feed === 'function', `${id} is not a full adapter`);
        }
        assert.equal(adapterFor('nope'), null);
    });

    await check('Claude Code: the portal\'s argv and the cm-style environment', () => {
        const d = dry(claudeCode, { model: 'M', effort: 'high', permission: 'edit', maxTurns: 200 });
        assert.equal(d.cmd, 'claude');
        assert.ok(d.argv.includes('-p'));
        assert.deepStrictEqual(d.argv.slice(d.argv.indexOf('--output-format'), d.argv.indexOf('--output-format') + 2), ['--output-format', 'stream-json']);
        assert.ok(d.argv.includes('--verbose'));
        assert.ok(d.argv.includes('--include-partial-messages'));
        assert.ok(d.argv.includes('--exclude-dynamic-system-prompt-sections'));
        assert.deepStrictEqual(d.argv.slice(d.argv.indexOf('--max-turns'), d.argv.indexOf('--max-turns') + 2), ['--max-turns', '200']);
        assert.deepStrictEqual(d.argv.slice(d.argv.indexOf('--permission-mode'), d.argv.indexOf('--permission-mode') + 2), ['--permission-mode', 'acceptEdits']);
        assert.equal(d.env.CLAUDE_CODE_EFFORT_LEVEL, 'high');
        assert.equal(d.env.ANTHROPIC_MODEL, 'M');
        // The brief is the user turn: it goes in on stdin.
        assert.equal(d.stdin, 'do the thing');
    });

    await check('Claude Code on another provider: the cm-style environment', () => {
        const d = dry(claudeOther, {
            model: 'MiniMax-M3.1-Flash',
            effort: 'max',
            provider: { baseUrl: 'https://api.minimax.io/anthropic', authToken: `sk-cp-${'1234567890'}` },
        });
        assert.equal(d.env.ANTHROPIC_BASE_URL, 'https://api.minimax.io/anthropic');
        assert.equal(d.env.ANTHROPIC_AUTH_TOKEN, `sk-cp-${'1234567890'}`);
        assert.equal(d.env.ANTHROPIC_MODEL, 'MiniMax-M3.1-Flash');
        assert.equal(d.env.CLAUDE_CODE_EFFORT_LEVEL, 'max');
    });

    await check('Codex: the portal\'s argv, the sandbox and the prompt on stdin', () => {
        const d = dry(codex, { model: 'gpt-5-codex', effort: 'medium', permission: 'edit', cwd: '/tmp/work', extraDir: '/tmp/notes' });
        assert.equal(d.cmd, 'codex');
        assert.ok(d.argv.includes('exec'));
        assert.ok(d.argv.includes('--json'));
        assert.ok(d.argv.includes('--skip-git-repo-check'));
        assert.deepStrictEqual(d.argv.slice(d.argv.indexOf('-C'), d.argv.indexOf('-C') + 2), ['-C', '/tmp/work']);
        assert.deepStrictEqual(d.argv.slice(d.argv.indexOf('-s'), d.argv.indexOf('-s') + 2), ['-s', 'workspace-write']);
        assert.ok(d.argv.includes('-c') && d.argv.includes('model_reasoning_effort=medium'));
        assert.equal(d.argv[d.argv.length - 1], '-', 'the prompt comes on stdin');
        assert.equal(d.stdin, 'do the thing');
        // A read-only job stays in Codex's own sandbox.
        assert.ok(dry(codex, { permission: 'read' }).argv.includes('read-only'));
        assert.ok(dry(codex, { permission: 'full' }).argv.includes('danger-full-access'));
    });

    await check('Codex on a resume: the same session, its own flag set', () => {
        const d = dry(codex, { resume: 'thread-7', effort: 'medium', permission: 'edit', cwd: '/tmp/work' });
        assert.deepStrictEqual(d.argv.slice(0, 3), ['exec', 'resume', 'thread-7']);
        assert.ok(d.argv.includes('--all'));
        assert.ok(!d.argv.includes('-C'), 'a resume takes no -C');
        assert.ok(d.argv.some((a) => a.startsWith('sandbox_mode=')), 'the sandbox goes in as an override');
        assert.ok(d.argv.some((a) => a.startsWith('sandbox_workspace_write.writable_roots=')), 'the writable roots go in as an override');
    });

    await check('Command Code: the portal\'s argv', () => {
        const d = dry(commandCode, { model: 'cm-model', effort: 'high', permission: 'full', maxTurns: 150 });
        assert.equal(d.cmd, 'cmd');
        assert.ok(d.argv.includes('--print=do the thing'));
        assert.deepStrictEqual(d.argv.slice(d.argv.indexOf('-m'), d.argv.indexOf('-m') + 2), ['-m', 'cm-model']);
        assert.deepStrictEqual(d.argv.slice(d.argv.indexOf('--effort'), d.argv.indexOf('--effort') + 2), ['--effort', 'high']);
        assert.deepStrictEqual(d.argv.slice(d.argv.indexOf('--output-format'), d.argv.indexOf('--output-format') + 2), ['--output-format', 'json']);
        assert.deepStrictEqual(d.argv.slice(d.argv.indexOf('--max-turns'), d.argv.indexOf('--max-turns') + 2), ['--max-turns', '150']);
        assert.ok(d.argv.includes('--config') && d.argv.includes('compact-mode=fast'));
        assert.ok(d.argv.includes('--skip-onboarding') && d.argv.includes('--no-auto-update') && d.argv.includes('-t'));
        assert.ok(d.argv.includes('--yolo'), 'the full permission runs unattended');
        assert.ok(!dry(commandCode, { permission: 'edit' }).argv.includes('--yolo'));
    });

    await check('Command Code: the permission rules go in the project, never on the command line', () => {
        const settings = JSON.parse(commandCode.settings({ permission: 'edit' }));
        assert.ok(settings.permissions.deny.includes('Shell(git push:*)'));
        assert.ok(settings.permissions.deny.includes('Read(.env*)'));
        const read = JSON.parse(commandCode.settings({ permission: 'read' }));
        assert.ok(read.permissions.deny.includes('Edit(**)'), 'a read-only job may not edit');
        // The portal's "full" (yolo) list: only git push and the pattern kills stay denied.
        const full = JSON.parse(commandCode.settings({ permission: 'full' }));
        assert.deepStrictEqual(full.permissions.deny, ['Shell(git push:*)', 'Shell(pkill:*)', 'Shell(killall:*)']);
    });

    await check('OpenCode: the portal\'s argv and the effort as the model variant', () => {
        const d = dry(opencode, { model: 'opencode-go/kimi-k2.7-code', effort: 'high', permission: 'edit', title: 'job-1' });
        assert.ok(d.argv.includes('run'));
        assert.ok(d.argv.includes('--standalone'));
        assert.deepStrictEqual(d.argv.slice(d.argv.indexOf('--format'), d.argv.indexOf('--format') + 2), ['--format', 'json']);
        assert.ok(d.argv.includes('--auto'));
        assert.ok(d.argv.includes('opencode-go/kimi-k2.7-code#high'), 'the effort is the model variant');
        assert.ok(d.argv.includes('--title') && d.argv.includes('job-1'));
        assert.equal(d.argv[d.argv.length - 1], 'do the thing');
        assert.ok(!dry(opencode, { permission: 'read' }).argv.includes('--auto'), 'a read-only job asks for nothing');
        assert.equal(opencode.variantFor('m', 'low'), 'm#low');
        assert.equal(opencode.variantFor('m', 'medium'), 'm', 'medium is the default');
        assert.equal(opencode.variantFor('m#high', 'low'), 'm#high', 'a model with a variant keeps it');
    });

    await check('OpenCode: the permission rules go in the project', () => {
        const settings = JSON.parse(opencode.settings({ permission: 'edit' }));
        assert.ok(settings.permissions.some((r) => r.resource === 'git push *' && r.effect === 'deny'));
        assert.ok(settings.permissions.some((r) => r.resource === '.env*'));
    });

    await check('MiniMax Code: the portal\'s argv', () => {
        const d = dry(minimaxCode, { model: 'MiniMax-M2', effort: 'high', permission: 'edit', cwd: '/tmp/work', maxSteps: 150, rules: '/tmp/rules.md' });
        assert.equal(d.cmd, 'mcode');
        assert.deepStrictEqual(d.argv.slice(0, 3), ['exec', '--input', '-']);
        assert.deepStrictEqual(d.argv.slice(d.argv.indexOf('--output-format'), d.argv.indexOf('--output-format') + 2), ['--output-format', 'stream-json']);
        assert.deepStrictEqual(d.argv.slice(d.argv.indexOf('--prompt-mode'), d.argv.indexOf('--prompt-mode') + 2), ['--prompt-mode', 'coding']);
        assert.deepStrictEqual(d.argv.slice(d.argv.indexOf('--permission'), d.argv.indexOf('--permission') + 2), ['--permission', 'smart']);
        assert.ok(d.argv.includes('--ptc'), 'Programmatic Tool Calling is on by default');
        assert.ok(d.argv.includes('/tmp/rules.md'));
        assert.deepStrictEqual(d.argv.slice(d.argv.indexOf('--max-steps'), d.argv.indexOf('--max-steps') + 2), ['--max-steps', '150']);
        assert.equal(d.stdin, 'do the thing');
        assert.ok(dry(minimaxCode, { permission: 'full' }).argv.includes('full'));
    });

    await check('the harness caps follow Settings → Limits: the set limits, and No limit means none', () => {
        const set = caps({ steps: 350, minutes: 45 });
        const none = caps({ steps: null, minutes: null });
        const arg = (adapter, ctx, flag) => {
            const argv = dry(adapter, ctx).argv;
            return argv[argv.indexOf(flag) + 1];
        };
        // The three harnesses that had a hard-coded cap now take the owner's (steps + 25).
        assert.equal(arg(claudeCode, set, '--max-turns'), '375');
        assert.equal(arg(commandCode, set, '--max-turns'), '375');
        assert.equal(arg(minimaxCode, { cwd: '/tmp/work', ...set }, '--max-steps'), '375');
        assert.equal(arg(minimaxCode, { cwd: '/tmp/work', ...set }, '--timeout'), '50m');
        // No limit means no cap: 100000 turns and no wall clock (the portal's MAXTURNS 100000, JOBTIMEOUT 0).
        assert.equal(arg(claudeCode, none, '--max-turns'), '100000');
        assert.equal(arg(commandCode, none, '--max-turns'), '100000');
        assert.equal(arg(minimaxCode, { cwd: '/tmp/work', ...none }, '--max-steps'), '100000');
        assert.equal(arg(minimaxCode, { cwd: '/tmp/work', ...none }, '--timeout'), '100000m');
        // An adapter with no cap of its own gets none either: an absent cap is not the old 150/200.
        assert.equal(arg(claudeCode, { maxTurns: undefined }, '--max-turns'), '100000');
        assert.equal(arg(commandCode, { maxTurns: undefined }, '--max-turns'), '100000');
        assert.equal(arg(minimaxCode, { cwd: '/tmp/work', maxSteps: undefined }, '--max-steps'), '100000');
    });

    await check('Claude-family harnesses may call the Know MCP tools, when the machine registered the server', () => {
        const allowed = (adapter, know) => {
            const argv = dry(adapter, { know }).argv;
            return argv[argv.indexOf('--allowedTools') + 1].split(' ');
        };
        for (const adapter of [claudeCode, claudeOther]) {
            assert.ok(!allowed(adapter, false).includes('mcp__ov_know'), `${adapter.id}: no Know server, no tools`);
            assert.ok(allowed(adapter, true).includes('mcp__ov_know'), `${adapter.id}: the Know tools are allowed`);
            assert.ok(allowed(adapter, true).includes('Bash'), 'the allow list keeps the tools a job needs');
        }
        // The machine's own registration is what decides it by default: ~/.claude.json → mcpServers.ov_know.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'know-registered-'));
        const registered = path.join(dir, 'claude.json');
        fs.writeFileSync(registered, JSON.stringify({ mcpServers: { ov_know: { command: 'node', args: ['know/mcp.js'] } } }));
        const absent = path.join(dir, 'none.json');
        fs.writeFileSync(absent, JSON.stringify({ mcpServers: {} }));
        const list = (file) => {
            const argv = dry(claudeCode, { claudeConfig: file }).argv;
            return argv[argv.indexOf('--allowedTools') + 1].split(' ');
        };
        assert.ok(list(registered).includes('mcp__ov_know'), 'the registered server makes its tools callable');
        assert.ok(!list(absent).includes('mcp__ov_know'), 'an unregistered machine gets no allow it cannot use');
        assert.ok(!list(path.join(dir, 'missing.json')).includes('mcp__ov_know'), 'a config that is not there changes nothing');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await check('the effort is fitted to the harness, never handed over as it came', () => {
        // The 2026-10-29 incident: Codex's "medium" killed Command Code before its first step.
        assert.equal(effortFor('command-code', 'medium'), 'high');
        assert.equal(effortFor('command-code', 'xhigh'), 'max');
        assert.equal(effortFor('command-code', 'off'), 'off');
        assert.equal(effortFor('command-code', 'high'), 'high');
        assert.equal(effortFor('codex', 'medium'), 'medium');
        assert.equal(effortFor('codex', 'ultra'), 'ultra');
        assert.equal(effortFor('claude-code', 'medium'), 'medium');
        assert.equal(effortFor('opencode', 'medium'), 'medium', 'OpenCode takes no effort setting');
        assert.equal(effortFor('codex', null), null);
        // And the adapter's own argv carries the fitted level.
        assert.ok(dry(commandCode, { effort: 'medium' }).argv.includes('high'));
    });

    await check('each feed reads its harness into the one transcript shape', () => {
        // Codex
        const cx = [];
        const f1 = codex.feed({ model: 'gpt', onEvent: (e) => cx.push(e) });
        f1.line(JSON.stringify({ type: 'thread.started', thread_id: 'th-1' }));
        f1.line(JSON.stringify({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls' } }));
        f1.line(JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls', aggregated_output: 'a.js', exit_code: 0, status: 'completed' } }));
        f1.line(JSON.stringify({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'done' } }));
        f1.end({ code: 0 });
        const st1 = transcript.parseText(cx.map((e) => JSON.stringify(e)).join('\n'));
        assert.equal(st1.session, 'th-1');
        assert.ok(st1.events.some((e) => e.t === 'tool' && e.name === 'Bash'), 'the tool call is there');
        assert.ok(st1.events.some((e) => e.t === 'final'), 'the attempt ended');
        assert.ok(st1.events.some((e) => e.text === 'done'), 'the answer is there');

        // Command Code
        const cc = [];
        const f2 = commandCode.feed({ model: 'cm', onEvent: (e) => cc.push(e) });
        f2.line(JSON.stringify({ type: 'event', event: { type: 'run_start', sessionId: 'cc-9' } }));
        f2.line(JSON.stringify({ type: 'event', event: { type: 'message_end', content: [{ type: 'tool_use', id: 'u1', name: 'edit_file', input: { path: 'a.js' } }] } }));
        f2.line(JSON.stringify({ type: 'event', event: { type: 'tool_completed', toolCallId: 'u1', result: [{ text: 'edited' }] } }));
        f2.line(JSON.stringify({ type: 'result', subtype: 'success', finalText: 'all good', sessionId: 'cc-9' }));
        f2.end({ code: 0 });
        const st2 = transcript.parseText(cc.map((e) => JSON.stringify(e)).join('\n'));
        assert.equal(st2.session, 'cc-9');
        assert.ok(st2.events.some((e) => e.t === 'tool' && e.name === 'Edit'), 'Command Code\'s tools get Claude Code\'s names');

        // OpenCode
        const oc = [];
        const f3 = opencode.feed({ model: 'oc-model', onEvent: (e) => oc.push(e) });
        f3.line(JSON.stringify({ type: 'tool_use', sessionID: 'oc-1', part: { id: 'p1', tool: 'read', state: { status: 'completed', input: { path: 'a.js' }, output: 'const a = 1;' } } }));
        f3.line(JSON.stringify({ type: 'text', sessionID: 'oc-1', part: { messageID: 'm1', text: 'opencode did it' } }));
        f3.line(JSON.stringify({ type: 'step_finish', sessionID: 'oc-1', part: { tokens: { input: 20, output: 3 } } }));
        f3.end({ code: 0 });
        const st3 = transcript.parseText(oc.map((e) => JSON.stringify(e)).join('\n'));
        assert.equal(st3.session, 'oc-1');
        assert.ok(st3.events.some((e) => e.t === 'tool' && e.name === 'Read'));
        assert.ok(st3.events.some((e) => e.t === 'final'), 'the attempt ended');
        assert.ok(st3.events.some((e) => e.text === 'opencode did it'), 'the answer is there');

        // MiniMax Code
        const mm = [];
        const f4 = minimaxCode.feed({ model: 'mm', onEvent: (e) => mm.push(e) });
        f4.line(JSON.stringify({ schemaVersion: 1, type: 'item.completed', sessionId: 'mm-1', item: { type: 'agent_message', content: 'mini did it' } }));
        f4.end({ code: 0 });
        const st4 = transcript.parseText(mm.map((e) => JSON.stringify(e)).join('\n'));
        assert.ok(st4.events.some((e) => e.t === 'text' && e.text.includes('mini did it')));
    });

    await check('a secret an agent prints never reaches the stream', () => {
        for (const [name, adapter, line] of [
            ['claude-code', claudeCode, JSON.stringify({ type: 'assistant', message: { model: 'm', content: [{ type: 'text', text: `the key is ${fake.providerKey()}` }] } })],
            ['codex', codex, JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: fake.githubToken() } })],
            ['command-code', commandCode, JSON.stringify({ type: 'event', event: { type: 'message_end', content: [{ type: 'text', text: fake.apiKey() }] } })],
            ['opencode', opencode, JSON.stringify({ type: 'text', sessionID: 's', part: { messageID: 'm', text: fake.password() } })],
            ['minimax-code', minimaxCode, JSON.stringify({ schemaVersion: 1, type: 'item.completed', item: { type: 'agent_message', content: fake.providerKey() } })],
        ]) {
            const out = [];
            const feed = adapter.feed({ model: 'm', onEvent: (e) => out.push(e) });
            feed.line(line);
            feed.end({ code: 0 });
            const text = JSON.stringify(out);
            assert.ok(!text.includes(fake.providerKey()), `${name}: the provider key survived`);
            assert.ok(!text.includes(fake.githubToken()), `${name}: the GitHub token survived`);
            assert.ok(!text.includes(fake.apiKeyValue()), `${name}: the api key survived`);
            assert.ok(!text.includes(fake.passwordValue()), `${name}: the password survived`);
        }
    });

    await check('the prompt is the rules, the house rules, the lessons, the digest and the brief', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-prompt-'));
        // A job that works in one repository gets that repository's digest; a folder that holds many gets none.
        require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: dir });
        fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\n\nA demo repository.\n');
        // On a Node the lessons come from the Know store's module (know/lessons.js), its path from the config.
        const knowFile = path.join(dir, 'know.js');
        fs.writeFileSync(knowFile, "module.exports = { recall: () => '## What earlier jobs learned here (dated)\\n- 2026-10-30 · demo — the tests need the database' };\n");
        const built = assemble({ brief: 'fix the test', dir, env: { CODES_KNOW_LESSONS: knowFile } });
        const names = built.parts.map((p) => p.name);
        assert.deepStrictEqual(names, ['git-rule', 'house-rules', 'lessons', 'repo-digest', 'brief']);
        assert.ok(built.text.indexOf('Git rules') < built.text.indexOf('House rules'));
        assert.ok(built.text.indexOf('House rules') < built.text.indexOf('learned'));
        assert.ok(built.text.indexOf('learned') < built.text.indexOf('demo repository'));
        assert.ok(built.text.trimEnd().endsWith('fix the test'), 'the brief is last');
        // The Node's config path wins over the environment, and a store that cannot be read is skipped, not an error.
        const fromConfig = assemble({ brief: 'x', dir, know: knowFile, env: { CODES_KNOW_LESSONS: path.join(dir, 'nope.js') } });
        assert.ok(fromConfig.parts.some((p) => p.name === 'lessons'), 'the config path is read');
        const none = assemble({ brief: 'x', dir, env: { CODES_KNOW_LESSONS: path.join(dir, 'nope.js') } });
        assert.ok(!none.parts.some((p) => p.name === 'lessons'));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await check('an attempt runs a stand-in harness, writes job lines and keeps its session', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-attempt-'));
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(bin);
        // A stand-in for Command Code: it prints what the real CLI prints.
        fs.writeFileSync(path.join(bin, 'cmd'), `#!/usr/bin/env node
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'event', event: { type: 'run_start', sessionId: 'sess-1' } });
out({ type: 'event', event: { type: 'message_end', content: [{ type: 'tool_use', id: 'u1', name: 'read_file', input: { path: 'a.js' } }] } });
out({ type: 'event', event: { type: 'tool_completed', toolCallId: 'u1', result: [{ text: 'ok' }] } });
out({ type: 'result', subtype: 'success', finalText: 'the work is done', sessionId: 'sess-1' });
`);
        fs.chmodSync(path.join(bin, 'cmd'), 0o755);
        const lines = [];
        const res = await runAttempt({
            agent: 'command-code',
            prompt: 'do the thing',
            cwd: dir,
            log: path.join(dir, 'feed.jsonl'),
            env: { PATH: `${bin}:${process.env.PATH}` },
            onLine: (l) => lines.push(l),
        });
        assert.equal(res.agent, 'command-code');
        assert.equal(res.sessionId, 'sess-1');
        assert.equal(res.summary, 'the work is done');
        assert.ok(res.ok);
        assert.ok(lines.some((l) => l.t === 'agent'), 'the run started');
        assert.ok(lines.some((l) => l.t === 'tool' && l.name === 'Read'), 'the tool call is a line');
        assert.ok(lines.some((l) => l.t === 'done' && l.ok), 'the attempt ended');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await check('a budget stop buys one wrap-up turn, on the same session', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-wrap-'));
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(bin);
        const log = path.join(dir, 'cmd.log');
        fs.writeFileSync(path.join(bin, 'cmd'), `#!/usr/bin/env node
const fs = require('fs');
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'event', event: { type: 'run_start', sessionId: 'sess-w' } });
out({ type: 'event', event: { type: 'message_end', content: [{ type: 'tool_use', id: 'u1', name: 'read_file', input: { path: 'a.js' } }] } });
fs.appendFileSync(process.env.WRAP_LOG, 'turn' + String.fromCharCode(10));
out({ type: 'result', subtype: 'success', finalText: 'landed', sessionId: 'sess-w' });
`);
        fs.chmodSync(path.join(bin, 'cmd'), 0o755);
        const lines = [];
        const res = await runAttempt({
            agent: 'command-code',
            prompt: 'do the thing',
            cwd: dir,
            log: path.join(dir, 'feed.jsonl'),
            budget: { steps: 1 },
            env: { PATH: `${bin}:${process.env.PATH}`, WRAP_LOG: log },
            onLine: (l) => lines.push(l),
        });
        assert.equal(res.budgetHit, 'steps', JSON.stringify(res));
        assert.ok(res.wrapUp && /last turn/i.test(res.wrapUp), 'the wrap-up turn was asked for');
        const turns = fs.readFileSync(log, 'utf8').trim().split('\n').length;
        assert.equal(turns, 2, 'the wrap-up turn ran');
        assert.ok(res.wrapUpResult && res.wrapUpResult.sessionId === 'sess-w', 'the wrap-up kept the session');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await check('a resume continues the same session', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-resume-'));
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(bin);
        const seen = path.join(dir, 'argv.log');
        fs.writeFileSync(path.join(bin, 'cmd'), `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(process.env.ARGV_LOG, process.argv.slice(2).join(' '));
console.log(JSON.stringify({ type: 'event', event: { type: 'run_start', sessionId: 'sess-r' } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', finalText: 'again', sessionId: 'sess-r' }));
`);
        fs.chmodSync(path.join(bin, 'cmd'), 0o755);
        const res = await runAttempt({
            agent: 'command-code',
            prompt: 'more',
            cwd: dir,
            resume: 'sess-old',
            log: path.join(dir, 'feed.jsonl'),
            env: { PATH: `${bin}:${process.env.PATH}`, ARGV_LOG: seen },
        });
        const argv = fs.readFileSync(seen, 'utf8');
        assert.ok(argv.includes('--resume sess-old'), `the resume flag is missing: ${argv}`);
        assert.equal(res.sessionId, 'sess-r');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
