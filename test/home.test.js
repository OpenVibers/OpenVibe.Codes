'use strict';
/**
 * The home page's own sections (server/http/home.js): OpenVibe Git from the forge's public API (left out when it never
 * answered), the quick start with the release-tag install line and the public router, and a FAQ that its FAQPage JSON-LD
 * repeats word for word. The git reader keeps only public repositories with a plain owner/name.
 */
const assert = require('assert');
const http = require('http');
const home = require('../server/http/home');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    await check('the git reader: public repositories, newest first as the forge answers, with the total it reports', async () => {
        const srv = http.createServer((req, res) => {
            assert.match(req.url, /^\/api\/v1\/repos\/search\?limit=8&sort=updated&order=desc$/);
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('X-Total-Count', '52');
            res.end(JSON.stringify({ ok: true, data: [
                { full_name: 'OpenVibers/OpenVibe.Codes', private: false, updated_at: '2026-10-22T10:00:00Z', language: 'JavaScript' },
                { full_name: 'OpenVibers/secret', private: true },
                { full_name: 'bad name/<x>', private: false },
            ] }));
        });
        await new Promise((r) => srv.listen(0, '127.0.0.1', r));
        try {
            const reader = home.createGitReader({ internalUrl: `http://127.0.0.1:${srv.address().port}`, publicUrl: 'https://git.openvibe.codes' });
            const v = await reader.refresh();
            assert.strictEqual(v.total, 52);
            assert.deepStrictEqual(v.repos.map((r) => r.url), ['https://git.openvibe.codes/OpenVibers/OpenVibe.Codes']);
        } finally { srv.close(); }
        const down = home.createGitReader({ internalUrl: 'http://127.0.0.1:9', timeoutMs: 500 });
        assert.strictEqual(await down.refresh(), null, 'a forge that does not answer gives no list');
        assert.strictEqual(home.ago('2026-10-22T10:00:00Z', Date.parse('2026-10-22T12:00:00Z')), '2 h ago');
    });

    const t = await boot();
    try {
        await check('the home presents the Codes workspace and its composer', async () => {
            let r = await t.get('/');
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /Every coding agent\. One place\./);
            assert.match(r.text, /What should an agent do\?/);
            assert.match(r.text, /Needs you/);
            assert.match(r.text, /Recent tasks/);
            const blocks = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
            assert.ok(blocks.some((b) => b['@type'] === 'WebSite'), 'the home keeps its website metadata');
            assert.strictEqual((r.text.match(/<h1[\s>]/g) || []).length, 1, 'one h1');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
