'use strict';
// Size budgets for openvibe.codes' home page (roadmap WS-T task 1, openvibe-shared/perf-budget): the
// server as it runs (a fresh database), measured without a browser. Budgets sit a little above the
// 2026-09-29 measurement; raising one is a decision to state in the commit.
//   node test/perf-budget.test.js
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { measure, check, format } = require('openvibe-shared/perf-budget');

// 2026-11-08: openvibe-shared v4.152.0; CI measured JS 373.8 KB raw / 89.4 KB brotli.
// 2026-11-08: openvibe-shared v4.150.0; CI measured JS 371.1 KB raw / 88.8 KB brotli.
// 2026-11-08: openvibe-shared v4.149.0; CI measured JS 370.2 KB raw / 88.6 KB brotli.
const BUDGETS = {
    htmlRawKB: 42,   // 40.4 with the ten harnesses the catalogue holds (2026-10-30: MiniMax Code and Claude Code on another provider joined it, and the home lists every one); 35.7 with the Part of OpenVibe section (Shared 4.13, 2026-10-26); 31.5 with the home's quick start, OpenVibe Git and six FAQs with their FAQPage JSON-LD (2026-10-22; in production the forge's eight repositories add about 2.5); measured 27.0 (fresh database; the showcase home, 2026-09-29: sections + six inline ring icons)
    htmlBrotliKB: 11,   // 9.2 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 7.7 with those sections (2026-10-22); 6.7
    jsFiles: 6,   // C4 adds the live task stream client to the shared theme, navbar, footer and boost scripts.
    jsRawKB: 392.3, // 392.3: measured 384.3 with openvibe-shared 4.161.0, plus room for 4.162.0–4.163.0, 2026-11-09
    jsBrotliKB: 94, // 94: measured 92 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssFiles: 3,   // C4 adds its responsive workspace stylesheet alongside codes.css and run.css.
    cssRawKB: 84.4, // 84.4: measured 79.4 with openvibe-shared 4.161.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssBrotliKB: 17.5, // 17.5: measured 16.3 with openvibe-shared 4.161.0, plus room for 4.162.0–4.163.0, 2026-11-09
    externalFiles: 2,   // 0
};

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

(async () => {
    // A database of its own (not the shared dev PGlite in data/pglite, and not whatever the caller's
    // DATABASE_URL names), so the measurement is the server on a fresh database and the run leaves nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-budget-'));
    const pgliteDir = path.join(dir, 'pglite');
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
            DATABASE_URL: '', DATABASE_DIRECT_URL: '', VALKEY_URL: '', CODES_PGLITE_DIR: pgliteDir,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const base = `http://127.0.0.1:${port}`;
    try {
        let up = false;
        for (let i = 0; i < 300 && !up; i++) {
            up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
            if (!up) await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(up, `the server did not start:\n${stderr}`);
        assert.ok(fs.existsSync(pgliteDir), 'the server did not use the isolated database (CODES_PGLITE_DIR)');
        const m = await measure({ base });
        const over = check(m, BUDGETS);
        assert.deepStrictEqual(over, [], format(m, over));
        console.log(format(m));
        console.log('perf budget: all checks passed');
    } finally {
        child.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
