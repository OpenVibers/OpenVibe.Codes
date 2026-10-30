'use strict';
/**
 * The two harnesses the router can select and the local adapters did not know: MiniMax Code (mcode) and Claude Code on
 * another provider (claude-other).
 *
 * What each is given to run with: the argv (the portal's own, from mm-run.sh and cm-run.sh), the environment (the
 * person's own key and endpoint, and never a key in argv), what it says when the binary is not installed, and how a
 * run's output becomes one result.
 *
 * The stand-in CLIs are written here, at run time, and the key-shaped values are built at run time too (a test that
 * spells out a key is a file with a key in it).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, done } = require('./helpers/boot');
const cli = require('../harness/adapters/cli');
const { availability, createHarness } = require('../harness');
const fake = require('./helpers/fakesecrets');

/** What the stand-in CLIs record: the argv, the stdin and the few environment names that matter here. */
const RECORD_ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
    'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_EFFORT_LEVEL', 'MINIMAX_API_KEY'];

const FAKE_MCODE = `
const fs = require('fs');
if (process.argv.includes('--version')) { console.log('mcode 9.9.9'); process.exit(0); }
const stdin = fs.readFileSync(0, 'utf8');
const rec = { argv: process.argv.slice(2), stdin, env: {} };
for (const k of ${JSON.stringify(RECORD_ENV)}) rec.env[k] = process.env[k] == null ? null : process.env[k];
fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify(rec));
const out = (o) => console.log(JSON.stringify(o));
out({ schemaVersion: 1, type: 'item.started', sessionId: 'mm-1', item: { type: 'agent_message' } });
if (process.env.FAKE_MMODE === 'fail') {
    out({ schemaVersion: 1, type: 'turn.failed', sessionId: 'mm-1', error: { message: 'the plan ran out' } });
    process.exit(1);
}
out({ schemaVersion: 1, type: 'item.completed', sessionId: 'mm-1', item: { type: 'agent_message', content: 'minimax did it' } });
out({ schemaVersion: 1, type: 'exec.completed', sessionId: 'mm-1', result: { status: 'succeeded', answer: 'minimax did it' } });
`;

const FAKE_CLAUDE = `
const fs = require('fs');
if (process.argv.includes('--version')) { console.log('2.1.314 (Claude Code)'); process.exit(0); }
const stdin = fs.readFileSync(0, 'utf8');
const rec = { argv: process.argv.slice(2), stdin, env: {} };
for (const k of ${JSON.stringify(RECORD_ENV)}) rec.env[k] = process.env[k] == null ? null : process.env[k];
fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify(rec));
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'system', subtype: 'init', session_id: 'cl-9', model: 'other-model' });
out({ type: 'assistant', message: { model: 'other-model', content: [{ type: 'text', text: 'claude did it' }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'claude did it', session_id: 'cl-9', duration_ms: 5, num_turns: 1, total_cost_usd: 0.01 });
`;

/** A directory with the stand-in CLIs in it, and the record file they write. */
function fakes(names) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-mm-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const scripts = { mcode: FAKE_MCODE, claude: FAKE_CLAUDE };
    for (const n of names) fs.writeFileSync(path.join(bin, n), `#!${process.execPath}\n'use strict';\n${scripts[n]}\n`, { mode: 0o755 });
    const record = path.join(dir, 'record.json');
    return { dir, bin, record, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Every event one adapter's run produces. */
async function run(adapter, task, env) {
    const events = [];
    for await (const e of adapter.start(task, { env })) events.push(e);
    return events;
}

/** The value of an argument in an argv. */
const argOf = (argv, name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };

(async () => {
    const f = fakes(['mcode', 'claude']);

    await check('MiniMax Code: the argv the portal\'s mm-run.sh uses, and the brief on stdin', async () => {
        const events = await run(cli.minimaxCode, { prompt: 'rename the variable', cwd: f.dir, permission: 'edit' },
            { PATH: f.bin, FAKE_RECORD: f.record });
        const rec = JSON.parse(fs.readFileSync(f.record, 'utf8'));
        assert.ok(rec.argv.includes('exec'), rec.argv.join(' '));
        assert.strictEqual(argOf(rec.argv, '--input'), '-');
        assert.strictEqual(argOf(rec.argv, '--output-format'), 'stream-json');
        assert.strictEqual(argOf(rec.argv, '--prompt-mode'), 'coding');
        assert.strictEqual(argOf(rec.argv, '--permission'), 'smart');
        assert.strictEqual(argOf(rec.argv, '--cwd'), f.dir);
        assert.strictEqual(argOf(rec.argv, '--max-steps'), '150');
        assert.ok(rec.argv.includes('--ptc'), 'the portal batches its tool calls');
        assert.strictEqual(rec.stdin, 'rename the variable', 'the brief rides in on stdin');
        assert.ok(!rec.argv.join(' ').includes('rename the variable'), 'not in argv');
        assert.strictEqual(events.filter((e) => e.type === 'result').length, 1, 'one result');
    });

    await check('MiniMax Code: the permission level is one of mcode\'s own policies', async () => {
        for (const [level, policy] of [['read', 'off'], ['edit', 'smart'], ['full', 'full']]) {
            await run(cli.minimaxCode, { prompt: 'x', cwd: f.dir, permission: level }, { PATH: f.bin, FAKE_RECORD: f.record });
            const rec = JSON.parse(fs.readFileSync(f.record, 'utf8'));
            assert.strictEqual(argOf(rec.argv, '--permission'), policy, level);
        }
    });

    await check('MiniMax Code: a resume continues the session, and no key sits in argv', async () => {
        const key = fake.providerKey();
        await run(cli.minimaxCode, { prompt: 'x', cwd: f.dir, permission: 'edit', resume: 'mm-9', model: 'MiniMax-M2' },
            { PATH: f.bin, FAKE_RECORD: f.record, MINIMAX_API_KEY: key });
        const rec = JSON.parse(fs.readFileSync(f.record, 'utf8'));
        assert.strictEqual(argOf(rec.argv, '--session'), 'mm-9');
        assert.strictEqual(argOf(rec.argv, '--model'), 'MiniMax-M2');
        assert.ok(!rec.argv.join(' ').includes(key), 'the key is not in argv');
        assert.strictEqual(rec.env.MINIMAX_API_KEY, key, 'the key is in the environment');
    });

    await check('MiniMax Code: the run\'s answer is one result, and a failure says why', async () => {
        const ok = await run(cli.minimaxCode, { prompt: 'x', cwd: f.dir, permission: 'edit' }, { PATH: f.bin, FAKE_RECORD: f.record });
        const result = ok[ok.length - 1];
        assert.strictEqual(result.type, 'result');
        assert.strictEqual(result.is_error, false, result.result);
        assert.strictEqual(result.result, 'minimax did it');
        assert.strictEqual(result.session_id, 'mm-1');
        const bad = await run(cli.minimaxCode, { prompt: 'x', cwd: f.dir, permission: 'edit' }, { PATH: f.bin, FAKE_RECORD: f.record, FAKE_MMODE: 'fail' });
        const failed = bad[bad.length - 1];
        assert.strictEqual(failed.type, 'result');
        assert.strictEqual(failed.is_error, true);
        assert.match(failed.result, /the plan ran out/);
    });

    await check('Claude Code on another provider: the endpoint and the model come from the connection', async () => {
        const key = fake.providerKey();
        const endpoint = 'https://provider.example/anthropic';
        const events = await run(cli.claudeOther, { prompt: 'fix the test', cwd: f.dir, permission: 'edit' },
            { PATH: f.bin, FAKE_RECORD: f.record, ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: 'provider-model-x' });
        const rec = JSON.parse(fs.readFileSync(f.record, 'utf8'));
        assert.strictEqual(rec.env.ANTHROPIC_BASE_URL, endpoint, 'the endpoint of the connection');
        assert.strictEqual(rec.env.ANTHROPIC_AUTH_TOKEN, key, 'the key of the connection');
        assert.strictEqual(rec.env.ANTHROPIC_MODEL, 'provider-model-x', 'the model id of the connection');
        assert.ok(!rec.argv.join(' ').includes(key), 'the key is never in argv');
        assert.ok(!rec.argv.join(' ').toLowerCase().includes('minimax'), 'no provider is hard-coded');
        assert.strictEqual(argOf(rec.argv, '--output-format'), 'stream-json');
        assert.strictEqual(argOf(rec.argv, '--permission-mode'), 'acceptEdits');
        assert.strictEqual(rec.stdin, 'fix the test', 'the brief rides in on stdin');
        const result = events[events.length - 1];
        assert.strictEqual(result.type, 'result');
        assert.strictEqual(result.is_error, false, result.result);
        assert.strictEqual(result.result, 'claude did it');
    });

    await check('Claude Code on another provider: a resume continues the session', async () => {
        await run(cli.claudeOther, { prompt: 'x', cwd: f.dir, permission: 'edit', resume: 'cl-9' },
            { PATH: f.bin, FAKE_RECORD: f.record, ANTHROPIC_BASE_URL: 'https://provider.example/anthropic', ANTHROPIC_AUTH_TOKEN: fake.providerKey() });
        const rec = JSON.parse(fs.readFileSync(f.record, 'utf8'));
        assert.strictEqual(argOf(rec.argv, '--resume'), 'cl-9');
    });

    await check('detection: the binary that is not there, and the one that is', () => {
        const missing = availability(cli.minimaxCode, { PATH: '/nonexistent' });
        assert.strictEqual(missing.available, false);
        assert.match(missing.reason, /not on PATH/);
        const there = availability(cli.minimaxCode, { PATH: f.bin });
        assert.strictEqual(there.available, true, there.reason);
        assert.match(there.version, /mcode/, 'the version it reports about itself');
    });

    await check('detection: Claude Code on another provider needs its connection', () => {
        const bare = availability(cli.claudeOther, { PATH: f.bin });
        assert.strictEqual(bare.available, false);
        assert.match(bare.reason, /ANTHROPIC_BASE_URL/);
        const noToken = availability(cli.claudeOther, { PATH: f.bin, ANTHROPIC_BASE_URL: 'https://provider.example/anthropic' });
        assert.strictEqual(noToken.available, false);
        assert.match(noToken.reason, /ANTHROPIC_AUTH_TOKEN/);
        const ready = availability(cli.claudeOther, { PATH: f.bin, ANTHROPIC_BASE_URL: 'https://provider.example/anthropic', ANTHROPIC_AUTH_TOKEN: fake.providerKey() });
        assert.strictEqual(ready.available, true, ready.reason);
        assert.match(ready.version, /Claude Code/);
    });

    await check('the harness knows both harnesses, and says why they are down', () => {
        const harness = createHarness({ env: { PATH: f.bin } });
        const rows = harness.agents();
        const mm = rows.find((r) => r.id === 'minimax-code');
        const other = rows.find((r) => r.id === 'claude-other');
        assert.ok(mm && other, 'both are in the catalogue');
        assert.strictEqual(mm.adapter, 'cli');
        assert.strictEqual(mm.available, true, mm.reason);
        assert.strictEqual(other.available, false);
        assert.match(other.reason, /ANTHROPIC_BASE_URL/);
    });

    f.cleanup();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
