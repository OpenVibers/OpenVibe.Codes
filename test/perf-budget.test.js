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
    jsBrotliKB: 91.7, // 91.7: measured 377.4 KB raw / 90.2 KB brotli with openvibe-shared 4.159.0, plus room for 4.160.0–4.161.0 (the navbar's slots loader, the keyboard watcher, the pop motion), 2026-11-09; 89.6 with openvibe-shared 4.153.0 (2026-11-08: signed in to the network, signed in here, on phones too; a page can turn away a carried card); 89.4 with openvibe-shared 4.152.0 (2026-11-08: the menu marks the page you are on and opens without the keyboard on a phone, floating cards follow you across OpenVibe sites (overlay.js), and the navbar preconnects to the next OpenVibe site on intent); 88.8 with openvibe-shared 4.150.0 (2026-11-08: the bell opens the Dock on Activity, the Dock's phone header is in two rows, and the menu's orb is the close button with an open/close animation); 88.6 with openvibe-shared 4.149.0 (2026-11-08: the menu has tabs at the top; the phone's menu button is the orb of 4.148.0); 88.1 with openvibe-shared 4.142.0 (2026-11-07: the menu has a close button on a phone);  87.9 with openvibe-shared 4.139.0 (2026-11-07: the menu's feed rows lead with their picture, the footer and glyphs defer 38 KB); 87.5 with openvibe-shared 4.137.0 (2026-11-07: every script by its content hash, one menu button on a phone, the menu warms at idle); 87 with openvibe-shared 4.135.0 (2026-11-07: Ask your agent from any page (kit.askAgent), the Dock's Agent panel reads the timeline again, and the menu's feeds follow you); 86.9 with openvibe-shared 4.133.0 (2026-11-07: your feeds in the menu, the navbar keeps the Frame cards again, Messages and the balances on every signed-in site, and your online status); 86.9 with openvibe-shared 4.133.0 (2026-11-07: your feeds in the menu, the navbar keeps the Frame cards again, Messages and the balances on every signed-in site, and your online status); 86.3 with openvibe-shared 4.129.0 (2026-11-07: the one menu (the burger opens the OpenVibe menu)); 86.1 with openvibe-shared 4.122.0 (2026-11-06: the featured link's phone button (4.119.0), the Dock's agent view (4.120.0), the agent view in the Dock's pop-out (4.121.0) and the thread start page's head (4.122.0)); 85.9 with openvibe-shared 4.118.0 (2026-11-06: the Locker re-auth link, the 44 px footer and TLD targets); 85.6 with openvibe-shared 4.114.0 (2026-11-06: the one Share sheet in the navbar (ov-share.js and ov-qr.js load on the first press); navbar.js gains its click handler); 85.3 with openvibe-shared 4.112.1 (2026-11-06: theme-loader.js (4.111.1) and the footer/appbar phone CSS (4.112.1)); 84.6 openvibe-shared 4.70.0 (2026-11-01: the app bar, busy(), skeletons, view transitions); 82.9 after C9b's conductor script; 80.6 after C4b's repository search on the home page; 77.6 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 76.1 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 74.2 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 70.5 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 67.9 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 65.3 Shared 4.12.0: the light/dark switch, the seasonal mark and the theme pairs; 61.7 with shared 4.11.0's seasonal navbar; 59.1 with openvibe-shared 4.4.0 (every site in the launcher, 2026-10-17); 56.3 (49.9 before web-runtime.js)
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
