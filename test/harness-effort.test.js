'use strict';
/**
 * The reasoning effort a person picks for a turn (plan L31 CH2) reaches each CLI in its own words: Claude Code and
 * Command Code take --effort, Codex its model_reasoning_effort setting, Aider --reasoning-effort, and OpenCode has no
 * such flag. The level is fitted to what each one accepts (engine/adapters/base.js effortFor: Command Code has no
 * "medium", Aider no "max"), and a turn without an effort passes none. The job input keeps only a level on the ladder.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, done } = require('./helpers/boot');
const cli = require('../harness/adapters/cli');
const { parseArgs } = require('../harness/job');

// One stand-in for every CLI: it records its argv and says nothing (the adapter then reports a failed run).
const FAKE = `
const fs = require('fs');
if (process.argv.includes('--version')) { console.log('9.9.9'); process.exit(0); }
fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2) }));
`;

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-effort-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    for (const name of ['claude', 'codex', 'cmd', 'aider', 'opencode']) fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n'use strict';\n${FAKE}\n`, { mode: 0o755 });
    const record = path.join(dir, 'record.json');
    const argvOf = async (adapter, effort) => {
        fs.rmSync(record, { force: true });
        for await (const e of adapter.start({ prompt: 'tidy the module', cwd: dir, permission: 'edit', ...(effort ? { effort } : {}) }, { env: { PATH: bin, FAKE_RECORD: record } })) void e;
        return JSON.parse(fs.readFileSync(record, 'utf8')).argv;
    };
    const after = (argv, flag) => { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1]; };
    try {
        await check('each CLI gets the effort in its own words', async () => {
            assert.strictEqual(after(await argvOf(cli.claudeCode, 'high'), '--effort'), 'high', 'Claude Code');
            const codex = await argvOf(cli.codex, 'high');
            assert.ok(codex.includes('model_reasoning_effort="high"') && after(codex, '-c') === 'model_reasoning_effort="high"', `Codex: ${codex.join(' ')}`);
            assert.strictEqual(after(await argvOf(cli.commandCode, 'high'), '--effort'), 'high', 'Command Code');
            assert.strictEqual(after(await argvOf(cli.aider, 'high'), '--reasoning-effort'), 'high', 'Aider');
        });

        await check('a level a CLI does not have becomes the nearest one it does', async () => {
            assert.strictEqual(after(await argvOf(cli.commandCode, 'medium'), '--effort'), 'high', 'Command Code has no medium: a tie goes up');
            assert.strictEqual(after(await argvOf(cli.aider, 'max'), '--reasoning-effort'), 'high', 'Aider tops out at high');
        });

        await check('no effort, no flag; and OpenCode, which has none, is never given one', async () => {
            const plain = await argvOf(cli.claudeCode, null);
            assert.ok(!plain.includes('--effort'), 'Claude Code at its default');
            assert.ok(!(await argvOf(cli.codex, null)).some((a) => /reasoning_effort/.test(a)), 'Codex at its default');
            assert.ok(!(await argvOf(cli.opencode, 'max')).some((a) => /effort/.test(a)), 'OpenCode');
        });

        await check('the job input keeps an effort on the ladder and drops anything else', () => {
            assert.strictEqual(parseArgs(JSON.stringify({ repo: 'https://github.com/a/b', prompt: 'x', effort: 'max' })).effort, 'max');
            assert.strictEqual(parseArgs(JSON.stringify({ repo: 'https://github.com/a/b', prompt: 'x', effort: 'ludicrous' })).effort, undefined);
            assert.strictEqual(parseArgs(JSON.stringify({ kind: 'conductor', folder: '/home/x', prompt: 'x', effort: 'low' })).effort, 'low');
        });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
