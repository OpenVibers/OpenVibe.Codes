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

const BUDGETS = {
    htmlRawKB: 42,   // 40.4 with the ten harnesses the catalogue holds (2026-10-30: MiniMax Code and Claude Code on another provider joined it, and the home lists every one); 35.7 with the Part of OpenVibe section (Shared 4.13, 2026-10-26); 31.5 with the home's quick start, OpenVibe Git and six FAQs with their FAQPage JSON-LD (2026-10-22; in production the forge's eight repositories add about 2.5); measured 27.0 (fresh database; the showcase home, 2026-09-29: sections + six inline ring icons)
    htmlBrotliKB: 11,   // 9.2 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 7.7 with those sections (2026-10-22); 6.7
    jsFiles: 6,   // C4 adds the live task stream client to the shared theme, navbar, footer and boost scripts.
    jsRawKB: 340,   // 330.9 after C9b: the conductor's message box with its images and its live turn (2.6 KB in js/c4.js); 326.2 after C4b: the home page loads the workspace script for its repository search (10.9 KB of its own); 315.6 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 307.8 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 300.5 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 293 openvibe-shared 4.22.0: the navbar's magnifier search button and More dropdown (search.js and loading.js load only when used); 287.2 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 273.2 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 263.4 with shared 4.11.0's seasonal navbar; 254.1 with openvibe-shared 4.9.0 (status text twins in every theme, 2026-10-23); 246.2 with openvibe-shared 4.2.x (Ask Actor in the navbar, 2026-10-15); 239.1 (212.2 before openvibe-shared/shell's web-runtime.js)
    jsBrotliKB: 84,   // 82.9 after C9b's conductor script; 80.6 after C4b's repository search on the home page; 77.6 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 76.1 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 74.2 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 70.5 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 67.9 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 65.3 Shared 4.12.0: the light/dark switch, the seasonal mark and the theme pairs; 61.7 with shared 4.11.0's seasonal navbar; 59.1 with openvibe-shared 4.4.0 (every site in the launcher, 2026-10-17); 56.3 (49.9 before web-runtime.js)
    cssFiles: 3,   // C4 adds its responsive workspace stylesheet alongside codes.css and run.css.
    cssRawKB: 65,   // 63.0 after C9c: the fleet's rows and its meters on the Agents page (public/css/c4.css, 1.2 KB); 62.4 after C9b: the conductor's turns, approvals inbox and composer (public/css/c4.css); 58.4 after C4b: the proof rows, the fold-out panels, the shots, the forms that remember choices and their light/dark styles; 46 KB after adding the C4 phone-first workspace, cards, task timeline and light/dark styles.
    cssBrotliKB: 14,   // 13.0 after C9b's conductor styles; 12.1 after C4b's rows, panels and forms; 9.9 KB after adding the C4 workspace styles.
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
