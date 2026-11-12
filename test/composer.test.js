'use strict';
// The conductor's message box on the shared composer (openvibe-shared 4.215.0, OpenVibeComposer.mount, preset
// agent): the session form keeps its action, uploader and status line; the model is the mode chip; the box sends.
// Real Chrome at 390 px; skipped without Chrome.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const h = require('openvibe-shared/browser-harness');
if (process.env.OV_SKIP_BROWSER === '1' || !h.findChrome()) { console.log('composer: skipped (no Chrome; set CHROME_BIN)'); process.exit(0); }
const SHARED = process.env.OV_SHARED_DIR || path.join(__dirname, '..', 'node_modules', 'openvibe-shared');
const SITE = path.join(__dirname, '..');
const form = `<section class="c4-card c4-conductor-composer"><form method="post" action="/tasks/t1/messages" enctype="multipart/form-data" data-c4-conductor-form data-ovc-compose data-ovc-preset="agent" data-c4-model-options='[["claude-code|opus","Opus 5.5"],["claude-code|sonnet","Sonnet 5.5"]]' data-c4-model-value="claude-code|opus"><label for="c4-message">What next?</label><textarea id="c4-message" name="text" rows="3" maxlength="16000" placeholder="Tell your conductor what to do next"></textarea><div class="c4-conductor-actions"><div data-c4-upload></div><button class="c4-button" type="submit">Send</button></div><p class="c4-hint" data-c4-message-status role="status"></p></form></section>`;
let posted = '';
const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => { posted = body; res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><p id="posted">posted</p>'); });
        return;
    }
    if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conductor</title><link rel="icon" href="data:,"></head><body style="margin:0;padding:12px;background:#0b1220;color:#e6edf7;font-family:sans-serif">${form}<script src="/ov-composer.js"></script><script src="/composer.js"></script></body></html>`);
    }
    if (req.url === '/ov-composer.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(fs.readFileSync(path.join(SHARED, 'ov-composer.js'))); }
    if (req.url === '/composer.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(fs.readFileSync(path.join(SITE, 'public/js/composer.js'))); }
    res.writeHead(404); res.end();
});
(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-composer-'));
    const browser = await h.launch({ tmpDir });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const page = await h.openPage(browser, await browser.newContext(), { width: 390, height: 900 });
    try {
        await page.goto(base + '/', { maxMs: 6000 });
        for (let i = 0; i < 100 && !(await page.evaluate(`!!document.querySelector('form.ovc-v2')`)); i++) await wait(40);
        const shape = await page.evaluate(`(() => { const f = document.querySelector('form[data-c4-conductor-form]'); return { preset: f.dataset.preset, action: f.getAttribute('action'), text: f.querySelector('#c4-message[data-ovt-text]') ? f.querySelector('#c4-message').value : null, chip: f.querySelector('.ovc-chip-v') ? f.querySelector('.ovc-chip-v').textContent : null, who: f.querySelector('select[name=who]').value, upload: !!f.querySelector('[data-c4-upload]'), status: !!f.querySelector('[data-c4-message-status]'), old: !!f.querySelector('.c4-conductor-actions button[type=submit]') }; })()`);
        assert.deepEqual(shape, { preset: 'agent', action: '/tasks/t1/messages', text: '', chip: 'Opus 5.5', who: 'claude-code|opus', upload: true, status: true, old: false });
        assert.equal(await page.evaluate(`document.documentElement.scrollWidth`), 390, 'nothing is wider than a phone');
        await page.evaluate(`(() => { const f = document.querySelector('form.ovc-v2'); const t = f.querySelector('textarea'); t.value = 'Carry on'; t.dispatchEvent(new Event('input', { bubbles: true })); f.querySelector('select[name=who]').value = 'claude-code|sonnet'; f.querySelector('[data-ovt-send]').click(); })()`);
        for (let i = 0; i < 100 && !posted; i++) await wait(40);
        assert.match(posted, /Carry on/);
        assert.match(posted, /claude-code\|sonnet/);
        console.log('composer: the conductor is the shared agent composer, its model is the chip, sends, 390 px');
    } finally {
        await page.close().catch(() => {});
        await browser.close();
        server.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
