'use strict';
// Codes' signed-in home on the one session surface (openvibe-shared 4.265.0 ov-session.js, plan §AD.8): messenger.js
// mounts OpenVibeSession over the server-rendered page with Codes as the agent, the person's recent repositories as
// "Works on", Codes' starters and ?prompt= in the box; the address follows the open session (?run=) and a new one (/).
// Where /shared/ov-session.js is not served yet, the harness (ov-harness.js) still takes over. Real Chrome at 390 px,
// with stand-ins for the shared files (what they are given is what this checks); skipped without Chrome.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const h = require('openvibe-shared/browser-harness');
if (process.env.OV_SKIP_BROWSER === '1' || !h.findChrome()) { console.log('home-session: skipped (no Chrome; set CHROME_BIN)'); process.exit(0); }
const SITE = path.join(__dirname, '..');

let serveSession = true;
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codes</title><link rel="icon" href="data:,"></head><body>
<main data-chat><button data-ch-saved-repo>ada/site</button><button data-ch-saved-repo>ada/band-page</button><p id="ssr">The server-rendered page</p></main>
<script>window.OpenVibeNavbar = { token: () => 'signed-in-test' };</script>
<script src="/js/messenger.js"></script></body></html>`;
// A stand-in OpenVibeSession: it keeps what it was given and plays the events a session sends.
const sessionStub = `window.OpenVibeSession = { mount(host, o) {
  window.__mounted = { agent: o.agent, base: o.base, works: o.works, starters: o.starters.length, open: o.open, sibling: o.sibling('ov-picker.js'), token: o.token(), title: o.title, hello: o.helloTitle };
  window.__onEvent = o.onEvent;
  host.innerHTML = '<div class="stub-session">session</div>';
  return { prefill(t) { window.__prefill = t; }, open(ref) { o.onEvent('session.opened', { ref }); }, blank() { o.onEvent('session.blank', {}); } };
} };`;
const harnessStub = `window.OpenVibeHarness = { page(host, o) { window.__harness = { repos: o.repos }; host.innerHTML = '<div class="stub-harness">harness</div>'; return { prefill() {} }; } };`;
const runStub = `window.OpenVibeRun = { page() { return {}; }, mount() { return {}; } };`;
const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page); }
    if (u.pathname === '/js/messenger.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(fs.readFileSync(path.join(SITE, 'public/js/messenger.js'))); }
    if (u.pathname === '/shared/ov-session.js' && serveSession) { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(sessionStub); }
    if (u.pathname === '/shared/ov-harness.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(harnessStub); }
    if (u.pathname === '/shared/ov-run.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(runStub); }
    if (u.pathname === '/api/v1/harnesses') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"harnesses":[]}'); }
    res.writeHead(404); res.end();
});
(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-home-session-'));
    const browser = await h.launch({ tmpDir });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (p, expr) => { for (let i = 0; i < 150; i++) { const v = await p.evaluate(expr); if (v) return v; await wait(40); } throw new Error(`Timed out: ${expr}`); };
    try {
        const p = await h.openPage(browser, await browser.newContext(), { width: 390, height: 844 });
        await p.goto(`${base}/?prompt=${encodeURIComponent('A page for my band')}`, { maxMs: 6000 });
        const got = await until(p, 'window.__mounted');
        assert.deepStrictEqual(got, {
            agent: 'codes', base: 'https://openvibe.network/api/frame', open: null, sibling: '/shared/ov-picker.js', token: 'signed-in-test', title: 'Codes', hello: 'What should we build?', starters: 4,
            works: [{ value: 'ada/site', name: 'ada/site', line: 'A repository you worked on here' }, { value: 'ada/band-page', name: 'ada/band-page', line: 'A repository you worked on here' }],
        }, 'the session, on Codes, with the person\'s repositories');
        assert.strictEqual(await p.evaluate('window.__prefill'), 'A page for my band', '?prompt= in the box');
        assert.deepStrictEqual(await p.evaluate("[!!document.querySelector('.co-messenger.co-session .stub-session'), !document.getElementById('ssr'), !window.__harness]"), [true, true, true], 'it takes over the page; no harness');
        // The address follows: an open session, then a new one.
        await p.evaluate("window.__onEvent('session.opened', { ref: 'codes:tsk_9' })");
        assert.strictEqual(await p.evaluate('location.pathname + location.search'), '/?run=codes%3Atsk_9');
        await p.evaluate("window.__onEvent('session.blank', {})");
        assert.strictEqual(await p.evaluate('location.pathname + location.search'), '/');
        assert.strictEqual(await p.evaluate('document.documentElement.scrollWidth'), 390);

        // ?run= opens that session; its events move the address.
        const q = await h.openPage(browser, await browser.newContext(), { width: 390, height: 844 });
        await q.goto(`${base}/?run=codes:tsk_7`, { maxMs: 6000 });
        assert.strictEqual((await until(q, 'window.__mounted')).open, 'codes:tsk_7', '?run= opens that session');

        // Not served yet: the harness still takes over.
        serveSession = false;
        const r = await h.openPage(browser, await browser.newContext(), { width: 390, height: 844 });
        await r.goto(`${base}/`, { maxMs: 6000 });
        assert.deepStrictEqual(await until(r, 'window.__harness'), { repos: ['ada/site', 'ada/band-page'] }, 'without ov-session.js, the harness');
        console.log('home-session: Codes\' home is the one session surface (Codes, your repositories, ?prompt=, ?run=); the harness until Shared serves it');
    } finally {
        await browser.close();
        server.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
