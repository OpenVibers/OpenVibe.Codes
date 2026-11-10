'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, done } = require('./helpers/boot');
const { runCheck } = require('../harness/goal-check');

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-check-'));
    try {
        await check('a command check runs in the workspace and its exit code is the machine\'s answer', async () => {
            fs.writeFileSync(path.join(dir, 'ok.js'), 'module.exports = 1;\n');
            const good = await runCheck({ kind: 'command', value: 'node --check ok.js' }, { cwd: dir });
            assert.equal(good.ok, true, good.output);
            assert.equal(good.exit_code, 0);
            const bad = await runCheck({ kind: 'command', value: 'node --check missing.js' }, { cwd: dir });
            assert.equal(bad.ok, false);
            assert.notEqual(bad.exit_code, 0);
            assert.match(bad.output, /missing\.js/);
        });

        await check('a URL check passes only on a 2xx', async () => {
            const pass = await runCheck({ kind: 'url', value: 'https://example.test/ok' }, {
                fetchImpl: async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '{}' }),
            });
            assert.equal(pass.ok, true);
            assert.equal(pass.status, 200);
            const fail = await runCheck({ kind: 'url', value: 'https://example.test/no' }, {
                fetchImpl: async () => ({ ok: false, status: 503, statusText: 'No', text: async () => 'down' }),
            });
            assert.equal(fail.ok, false);
            assert.equal(fail.status, 503);
        });

        await check('a rubric has no machine verdict and an unknown kind fails closed', async () => {
            const rubric = await runCheck({ kind: 'rubric', value: 'the copy is honest' }, { cwd: dir });
            assert.equal(rubric.ok, null);
            const unknown = await runCheck({ kind: 'vibes', value: 'x' }, { cwd: dir });
            assert.equal(unknown.ok, false);
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    done();
})();
