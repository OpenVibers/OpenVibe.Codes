'use strict';
/**
 * The public crawl artifacts (plan T11), fetched from the booted app: /robots.txt, /sitemap.xml,
 * /llms.txt and the home page's JSON-LD. Each is served with the right status and content type,
 * carries at least one real entry, lists public pages only, and takes lastmod from the site's own
 * data (STATUS.json) — never from the clock.
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
        await check('robots.txt: 200 text/plain, every previous Disallow kept, sitemap named', async () => {
            const r = await t.get('/robots.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^text\/plain/);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=\d+/);
            for (const d of [...PRIVATE, '/api/']) assert.ok(r.text.includes(`Disallow: ${d}`), `missing Disallow: ${d}`);
            assert.ok(r.text.includes('Sitemap: https://openvibe.codes/sitemap.xml'), 'sitemap not named');
            assert.ok(/^User-agent: \*$/m.test(r.text), 'no User-agent: * group');
        });

        await check('sitemap.xml: 200 application/xml, real entries, lastmod from the data', async () => {
            const r = await t.get('/sitemap.xml');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^application\/xml/);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=\d+/);
            assert.ok(r.text.includes('<loc>https://openvibe.codes/docs</loc>'), 'no /docs entry');
            assert.ok(r.text.includes('<loc>https://openvibe.codes/policy/transparency</loc>'), 'no policy entry');
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
            assert.ok(r.text.includes('(https://openvibe.codes/docs)'), 'no reference link');
            assert.ok(r.text.includes('https://openvibe.codes/sitemap.xml'), 'sitemap not listed');
            for (const p of PRIVATE) assert.ok(!r.text.includes(`https://openvibe.codes${p}`), `private path in llms.txt: ${p}`);
            assert.ok(!r.text.includes('https://openvibe.codes/api/'), 'api path in llms.txt');
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
