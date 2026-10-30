'use strict';
/** What this machine has: each CLI, signed in or not, and its limit windows (engine/logins.js). */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, done } = require('./helpers/boot');
const { probe, probeOne, windowsOf, signedIn, onPath } = require('../engine/logins');

(async () => {
    await check('every CLI is reported: installed, signed in, and the windows it can read', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
        const rows = probe({ home, env: { PATH: '' } });
        assert.ok(rows.length >= 5, 'every CLI is there');
        for (const r of rows) {
            assert.equal(typeof r.installed, 'boolean');
            assert.equal(typeof r.signed_in, 'boolean');
            assert.ok(Array.isArray(r.windows));
        }
        assert.ok(rows.some((r) => r.id === 'codex'));
        assert.ok(rows.some((r) => r.id === 'claude-code'));
        fs.rmSync(home, { recursive: true, force: true });
    });

    await check('a CLI that is on the PATH is installed, one that is not is not', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home2-'));
        const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bin-'));
        fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n');
        fs.chmodSync(path.join(bin, 'codex'), 0o755);
        const row = probeOne('codex', { home, env: { PATH: bin } });
        assert.equal(row.installed, true);
        const other = probeOne('opencode', { home, env: { PATH: bin } });
        assert.equal(other.installed, false);
        assert.equal(onPath('codex', { PATH: bin }), path.join(bin, 'codex'));
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(bin, { recursive: true, force: true });
    });

    await check('a login file with a session means signed in', () => {
        assert.equal(signedIn({ access_token: 'x' }), true);
        assert.equal(signedIn({ tokens: { access_token: 'x' } }), true);
        assert.equal(signedIn({}), false);
        assert.equal(signedIn(null), false);
    });

    await check('the windows are numbers, labels and reset times, never a token', () => {
        const w = windowsOf({ access_token: 'secret', windows: [{ name: '5h', used: 3, limit: 5, resets_at: '2026-10-29T22:00:00Z' }] });
        assert.deepStrictEqual(w, [{ name: '5h', used: 3, limit: 5, resets_at: '2026-10-29T22:00:00Z' }]);
        assert.ok(!JSON.stringify(w).includes('secret'), 'the token is not in the report');
        assert.deepStrictEqual(windowsOf({ access_token: 'secret' }), []);
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
