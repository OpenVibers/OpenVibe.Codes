'use strict';
// The browser check (11-15): /start's HowTo JSON-LD is named after the page's title, "Get started with coding agents",
// and the page only said "Get started", so the structured data named something a reader never sees. The heading says
// the HowTo's name.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { META } = require('../server/public-seo');

(async () => {
    const t = await boot();
    try {
        await check('the start page shows the name its HowTo gives', async () => {
            const r = await t.get('/start');
            assert.strictEqual(r.status, 200);
            const ld = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])).flat();
            const howTo = ld.find((n) => n && n['@type'] === 'HowTo');
            assert.ok(howTo, 'a HowTo');
            assert.strictEqual(howTo.name, META['/start'][0]);
            const visible = r.text.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<title[\s\S]*?<\/title>/g, '').replace(/<[^>]+>/g, ' ');
            assert.ok(visible.includes(howTo.name), `"${howTo.name}" is on the page`);
        });
    } finally {
        await done(t);
    }
})();
