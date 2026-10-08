'use strict';
/**
 * The public crawl artifacts (plan T11), fetched from the booted app: /robots.txt, /sitemap.xml,
 * /llms.txt, /llms-full.txt and the home page's JSON-LD. Each is served with the right status and
 * content type, carries at least one real entry, lists public pages only, and takes lastmod from the
 * site's own data (STATUS.json) — never from the clock.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

const STATUS_UPDATED = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'STATUS.json'), 'utf8')).updated;
const PRIVATE = ['/projects', '/staff', '/auth/', '/oauth/test-callback'];

(async () => {
    const t = await boot();
    try {
        await check('robots.txt: 200 text/plain, sign-in and the API disallowed, the moved addresses crawlable (their 301s carry the ranking to openvibe.services), sitemap named', async () => {
            const r = await t.get('/robots.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^text\/plain/);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=\d+/);
            for (const d of ['/auth/', '/api/']) assert.ok(r.text.includes(`Disallow: ${d}`), `missing Disallow: ${d}`);
            for (const d of ['/projects', '/staff', '/docs']) assert.ok(!r.text.includes(`Disallow: ${d}`), `${d} must stay crawlable so engines follow its 301`);
            assert.ok(r.text.includes('Sitemap: https://openvibe.codes/sitemap.xml'), 'sitemap not named');
            assert.ok(/^User-agent: \*$/m.test(r.text), 'no User-agent: * group');
        });

        await check('sitemap.xml: 200 application/xml, real entries, lastmod from the data', async () => {
            const r = await t.get('/sitemap.xml');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^application\/xml/);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=\d+/);
            for (const p of ['/', '/harnesses', '/improve', '/policy']) assert.ok(r.text.includes(`<loc>https://openvibe.codes${p}</loc>`), `no ${p} entry`);
            for (const p of ['/docs', '/projects', '/oauth', '/tools/webhooks', '/policy/transparency']) assert.ok(!r.text.includes(`<loc>https://openvibe.codes${p}</loc>`), `${p} moved to openvibe.services`);
            const lastmods = [...r.text.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
            assert.ok(lastmods.length > 0, 'no lastmod anywhere');
            assert.ok(lastmods.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)), `bad lastmod: ${lastmods.slice(0, 3)}`);
            assert.ok(lastmods.every((d) => d === STATUS_UPDATED), `lastmod must come from STATUS.json (${STATUS_UPDATED}), got ${[...new Set(lastmods)].join(', ')}`);
            for (const p of PRIVATE) assert.ok(!r.text.includes(`https://openvibe.codes${p}`), `private path in sitemap: ${p}`);
        });

        await check('llms.txt: 200 text/plain, real links, nothing private', async () => {
            const r = await t.get('/llms.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^text\/plain/);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=\d+/);
            assert.ok(r.text.startsWith('# OpenVibe.Codes'), 'no title');
            assert.ok(r.text.includes('(https://openvibe.codes/harnesses)'), 'no agents link');
            assert.ok(r.text.includes('(https://openvibe.codes/improve)'), 'no Improve OpenVibe link');
            assert.ok(r.text.includes('(https://openvibe.services)'), 'no pointer to the developer platform');
            assert.ok(r.text.includes('https://openvibe.codes/sitemap.xml'), 'sitemap not listed');
            assert.ok(r.text.includes('(https://openvibe.codes/llms-full.txt)'), 'llms-full.txt not listed');
            for (const p of PRIVATE) assert.ok(!r.text.includes(`https://openvibe.codes${p}`), `private path in llms.txt: ${p}`);
        });

        await check('llms-full.txt: 200 text/plain, the site title, and every page the sitemap lists', async () => {
            const r = await t.get('/llms-full.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^text\/plain/);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=\d+/);
            assert.ok(r.text.startsWith('# OpenVibe.Codes'), 'no title');
            const sitemap = await t.get('/sitemap.xml');
            const locs = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
            assert.ok(locs.length >= 5, `sitemap too small: ${locs.length}`);
            for (const loc of locs) assert.ok(r.text.includes(loc), `llms-full.txt is missing ${loc}`);
            assert.ok(r.text.includes('URL: https://openvibe.codes/harnesses\n'), 'no /harnesses entry');
            for (const p of PRIVATE) assert.ok(!r.text.includes(`https://openvibe.codes${p}`), `private path in llms-full.txt: ${p}`);
            assert.ok(!r.text.includes('https://openvibe.codes/api/'), 'api path in llms-full.txt');
        });

        await check('home page: WebSite + the site\'s primary type, the same for every crawler', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200);
            const blocks = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
            const types = blocks.map((b) => b['@type']);
            assert.ok(types.includes('WebSite'), `no WebSite node: ${types}`);
            assert.ok(types.includes('WebApplication'), `no primary-type node: ${types}`);
            const site = blocks.find((b) => b['@type'] === 'WebSite');
            assert.strictEqual(site.url, 'https://openvibe.codes');
            assert.strictEqual(site.name, 'OpenVibe.Codes');
            const page = blocks.find((b) => b['@type'] === 'WebPage');
            assert.strictEqual(page.url, 'https://openvibe.codes/');
        });
    } finally { await t.close(); }
    done();
})();
