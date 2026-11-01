'use strict';
/**
 * "Edit" means edits on the person's own computer (the owner, 2026-11-01: "make sure our system for the agents is
 * sandboxed properly"). OpenCode's --auto and Command Code's --yolo approve every tool, the shell included: there is no
 * edits-only mode, so they run unattended only for "full", or for "edit" inside a sandbox (a job on the person's Node,
 * which sets OPENVIBE_JOB_ID). Outside one, an "edit" run never starts them: routing leaves them out with the reason, a
 * run that names one is refused in words, and Aider, which says yes to everything it asks, suggests no shell commands.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, done } = require('./helpers/boot');
const cli = require('../harness/adapters/cli');
const { createHarness } = require('../harness');
const { createStore } = require('../harness/sessions');
const { fakeAgents } = require('./helpers/fake-agents');

// One stand-in for every CLI: it records its argv and says nothing.
const FAKE = `
const fs = require('fs');
if (process.argv.includes('--version')) { console.log('9.9.9'); process.exit(0); }
fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2) }));
`;
const collect = async (run) => { const out = []; for await (const e of run) out.push(e); return out; };

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-sandbox-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    ['claude', 'codex', 'cmd', 'aider', 'opencode'].forEach((name) => fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n'use strict';\n${FAKE}\n`, { mode: 0o755 }));
    const record = path.join(dir, 'record.json');
    const argvOf = async (adapter, task) => {
        fs.rmSync(record, { force: true });
        for await (const e of adapter.start({ prompt: 'tidy the module', cwd: dir, ...task }, { env: { PATH: bin, FAKE_RECORD: record } })) void e;
        return JSON.parse(fs.readFileSync(record, 'utf8')).argv;
    };
    const f = fakeAgents({ claude: 'ok', codex: 'ok', opencode: 'ok', cmd: 'ok' });
    const harness = () => createHarness({ env: f.env, store: createStore({ env: f.env }) });
    try {
        await check('OpenCode and Command Code run unattended only for "full" or inside a sandbox', async () => {
            assert.strictEqual(cli.opencode.editsOnly, false);
            assert.strictEqual(cli.commandCode.editsOnly, false);
            assert.ok(!(await argvOf(cli.opencode, { permission: 'edit' })).includes('--auto'), 'edit on the person’s computer: no --auto');
            assert.ok((await argvOf(cli.opencode, { permission: 'edit', sandboxed: true })).includes('--auto'), 'edit in a Node sandbox: --auto');
            assert.ok((await argvOf(cli.opencode, { permission: 'full' })).includes('--auto'), 'full: --auto');
            assert.ok(!(await argvOf(cli.opencode, { permission: 'read', sandboxed: true })).includes('--auto'), 'read: never');
            assert.ok(!(await argvOf(cli.commandCode, { permission: 'edit' })).includes('--yolo'), 'Command Code: no --yolo for edit outside a sandbox');
            assert.ok((await argvOf(cli.commandCode, { permission: 'edit', sandboxed: true })).includes('--yolo'));
            assert.ok((await argvOf(cli.commandCode, { permission: 'full' })).includes('--yolo'));
            assert.ok(!(await argvOf(cli.commandCode, { permission: 'edit', sandboxed: 'yes' })).includes('--yolo'), 'only a real true counts');
        });

        await check('Aider suggests no shell commands for "edit" on the person’s computer', async () => {
            assert.ok((await argvOf(cli.aider, { permission: 'edit' })).includes('--no-suggest-shell-commands'));
            assert.ok(!(await argvOf(cli.aider, { permission: 'edit', sandboxed: true })).includes('--no-suggest-shell-commands'), 'in a sandbox it may run the tests it suggests');
            assert.ok(!(await argvOf(cli.aider, { permission: 'full' })).includes('--no-suggest-shell-commands'));
        });

        await check('routing an "edit" run outside a sandbox leaves them out, and says why', () => {
            const h = harness();
            const out = h.route({ task: 'edit', permission: 'edit', sandboxed: false });
            const left = (id) => out.candidates.filter((c) => c.id.startsWith(`${id}:`));
            ['opencode', 'command-code'].forEach((id) => left(id).forEach((c) => {
                assert.strictEqual(c.included, false, `${c.id} is left out`);
                assert.match(c.reason, /no edits-only mode/, c.reason);
            }));
            assert.ok(!/^(opencode|command-code):/.test(out.selected || ''), `selected ${out.selected}`);
            const inBox = h.route({ task: 'edit', permission: 'edit', sandboxed: true });
            assert.ok(inBox.candidates.filter((c) => /^(opencode|command-code):/.test(c.id)).some((c) => c.included !== false), 'inside a sandbox they may be picked');
        });

        await check('a run that names one for "edit" outside a sandbox is refused in words, and nothing starts', async () => {
            const events = await collect(harness().run({ prompt: 'tidy it', agent: 'opencode', permission: 'edit', cwd: dir, handoff: false }));
            const result = events.find((e) => e.type === 'result');
            assert.ok(result && result.is_error, 'refused');
            assert.match(result.result, /OpenCode has no edits-only mode/);
            assert.match(result.result, /--permission full|paired machine/);
            assert.ok(!events.some((e) => e.type === 'assistant'), 'the agent never ran');
            const ok = await collect(harness().run({ prompt: 'tidy it', agent: 'opencode', permission: 'edit', sandboxed: true, cwd: dir, handoff: false }));
            assert.ok(ok.some((e) => e.type === 'assistant'), 'inside a sandbox it runs');
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        f.cleanup();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
