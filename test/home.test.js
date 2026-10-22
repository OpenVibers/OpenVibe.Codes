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
        await check('the home: quick start, OpenVibe Git, a FAQ and its JSON-LD', async () => {
            let r = await t.get('/');
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /id="quick-start"/);
            assert.match(r.text, /npm install -g https:\/\/codeload\.github\.com\/OpenVibers\/OpenVibe\.Codes\/tar\.gz\/refs\/tags\/v\d+\.\d+\.\d+/);
            assert.match(r.text, /https:\/\/openvibe\.codes\/api\/v1\/harnesses\/route/);
            assert.match(r.text, /id="git"/, 'OpenVibe Git is on the home');
            assert.ok(!/class="codes-repos"/.test(r.text), 'no repository list while the forge has not answered');
            assert.ok(r.text.includes('git clone https://git.openvibe.codes/OpenVibers/OpenVibe.Codes.git'));
            assert.ok(r.text.includes('# an example run'), 'the hero transcript says it is an example');
            const blocks = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
            const faq = blocks.find((b) => b['@type'] === 'FAQPage');
            assert.ok(faq && faq.mainEntity.length === home.faqPairs().length && faq.mainEntity.length >= 5, 'a FAQPage node with every question');
            faq.mainEntity.forEach((q) => assert.ok(r.text.includes(`<h3>${q.name.replace(/'/g, '&#39;')}</h3>`), `the page shows "${q.name}"`));
            assert.strictEqual((r.text.match(/<h1[\s>]/g) || []).length, 1, 'one h1');

            t.ctx.git = { peek: () => ({ total: 52, publicUrl: 'https://git.openvibe.codes', repos: [{ name: 'OpenVibers/OpenVibe.Codes', url: 'https://git.openvibe.codes/OpenVibers/OpenVibe.Codes', updated: new Date().toISOString(), language: 'JavaScript' }] }) };
            r = await t.get('/');
            assert.match(r.text, /52 repositories on OpenVibe&#39;s own code forge|52 repositories on OpenVibe's own code forge/);
            assert.ok(r.text.includes('href="https://git.openvibe.codes/OpenVibers/OpenVibe.Codes"') && r.text.includes('<small>Code with any agent</small>'), 'a repository with its service tagline');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
