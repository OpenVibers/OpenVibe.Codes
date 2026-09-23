'use strict';
/**
 * Governance pages (roadmap §15.5): code of conduct, contribution guide, contributor ladder and
 * moderation policy are this repository's Markdown files, served under /policy as they are. Each is
 * a draft pending the owner's review: marked at the top of the file and on the page, kept out of
 * search engines and the sitemap. Links between them resolve.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { GOVERNANCE } = require('../server/http/pages');
const { boot, check, done } = require('./helpers/boot');

const ROOT = path.join(__dirname, '..');

(async () => {
    const t = await boot();

    await check('the four documents exist and each starts with the draft line', async () => {
        assert.deepStrictEqual(GOVERNANCE.map((g) => g.slug), ['code-of-conduct', 'contributing', 'contributor-ladder', 'moderation']);
        for (const g of GOVERNANCE) {
            const lines = fs.readFileSync(path.join(ROOT, g.file), 'utf8').split('\n');
            assert.match(lines[0], /^# \S/, `${g.file} starts with its title`);
            assert.match(lines[2], /^\*\*Draft — pending owner review\.\*\*/, `${g.file} is marked as a draft at the top`);
        }
    });

    await check('each is served under /policy with the draft notice, rendered Markdown and its source', async () => {
        for (const g of GOVERNANCE) {
            const r = await t.get(`/policy/${g.slug}`);
            assert.strictEqual(r.status, 200, g.slug);
            assert.match(r.text, /<h1>[^<]+<\/h1>/);
            assert.match(r.text, /class="notice warn"[^>]*><strong>Draft — pending owner review\.<\/strong>/, `${g.slug} shows the draft notice`);
            assert.match(r.text, /<meta name="robots" content="noindex, nofollow">/, `${g.slug} is not indexed while a draft`);
            assert.match(r.text, /<h2>[^<]+<\/h2>/, `${g.slug} has its sections as h2`);
            assert.ok(r.text.includes(`https://github.com/OpenVibers/OpenVibe.Codes/blob/main/${g.file}`));
            assert.ok(!/<script(?![^>]*src=)/.test(r.text.split('<article class="prose">')[1].split('</article>')[0]), 'no inline script from Markdown');
        }
    });

    await check('the policy index lists them as drafts; the sitemap leaves drafts out', async () => {
        const idx = await t.get('/policy');
        for (const g of GOVERNANCE) assert.ok(idx.text.includes(`href="/policy/${g.slug}"`), g.slug);
        assert.match(idx.text, /\(draft, pending owner review\)/);
        const map = await t.get('/sitemap.xml');
        for (const g of GOVERNANCE) assert.ok(!map.text.includes(`/policy/${g.slug}<`), `${g.slug} not in the sitemap while a draft`);
        assert.ok(map.text.includes('/policy/compatibility<'));
    });

    await check('every openvibe.codes link in the documents resolves', async () => {
        const links = new Set();
        for (const g of GOVERNANCE) {
            const text = fs.readFileSync(path.join(ROOT, g.file), 'utf8');
            for (const m of text.matchAll(/\]\(https:\/\/openvibe\.codes(\/[^)\s#]*)\)/g)) links.add(m[1]);
        }
        assert.ok(links.size >= 5);
        for (const l of links) assert.strictEqual((await t.get(l)).status, 200, l);
    });

    await t.close();
    done();
})();
