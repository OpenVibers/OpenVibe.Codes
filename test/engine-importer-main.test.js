'use strict';

/**
 * engine/importer-main.js, the importer /import.cjs serves (plan §AD.24): it knows which harness it runs under, says
 * where to make a link when it has none, refuses what is not a link, and writes a session to a file without one.
 * The whole flow (finding sessions of three harnesses, the upload, the served file) is test/session-transfer.test.js.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const portable = require('../engine/portable');
const { main, runningUnder, HELP } = require('../engine/importer-main');
const { check, done } = require('./helpers/boot');

(async () => {
    await check('it knows the harness from the agent\'s shell', () => {
        assert.strictEqual(runningUnder({ CLAUDECODE: '1' }), 'claude-code');
        assert.strictEqual(runningUnder({ GEMINI_CLI: '1' }), 'gemini');
        assert.strictEqual(runningUnder({ CODEX_SANDBOX: 'seatbelt' }), 'codex');
        assert.strictEqual(runningUnder({}), null);
    });

    await check('no link says where to make one; a wrong one is refused; --out needs none', async () => {
        const lines = [];
        const out = (l) => lines.push(l);
        const fetchImpl = async () => { throw new Error('nothing is sent'); };
        assert.strictEqual(await main(['--help'], { portable, base: 'https://codes.test', env: {}, fetchImpl, out }), 0);
        assert.strictEqual(lines[0], HELP);
        assert.strictEqual(await main([], { portable, base: 'https://codes.test', env: {}, fetchImpl, out }), 2);
        assert.ok(lines.some((l) => l.includes('https://codes.test/import')));
        assert.strictEqual(await main(['--link', 'cdi_nope'], { portable, base: 'https://codes.test', env: {}, fetchImpl, out }), 2);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-importer-'));
        try {
            const md = path.join(dir, 'handover.md');
            fs.writeFileSync(md, '## User\nKeep going with the release\n\n## Assistant\nThe release is tagged.\n');
            const file = path.join(dir, 'out.json.gz');
            assert.strictEqual(await main(['--file', md, '--out', file], { portable, base: 'https://codes.test', env: {}, fetchImpl, out, home: dir, cwd: dir }), 0);
            const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
            assert.deepStrictEqual([doc.harness, doc.title, doc.counts.messages], ['handover', 'Keep going with the release', 2]);
            assert.strictEqual(await main(['--out', file], { portable, base: 'https://codes.test', env: {}, fetchImpl, out, home: dir, cwd: dir }), 2, 'no session anywhere: it says how to write one');
            assert.ok(lines.some((l) => /pass --file/.test(l)));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
    done();
})();
