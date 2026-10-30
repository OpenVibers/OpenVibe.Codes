'use strict';
/**
 * Codes C4c: one navigation per page, and a phone page whose last line clears the tab bar.
 *
 *   - the shared Frame navbar carries the workspace's sections; the page has no sidebar of its own
 *     (openvibe.design/patterns/single-navbar)
 *   - a visitor who is not signed in keeps the product's links, and a signed-in person's navbar folds them into More
 *   - the workspace reserves the phone tab bar's height at the bottom of the page, so the last line and the footer
 *     clear it when the page is scrolled to the end (openvibe.design/patterns/bottom-tabs)
 *   - a card's muted note sits under its heading, not beside it, where it read as a second title
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

/** The navbar's own configuration, as the page hands it to the Frame. */
const navbarOf = (text) => {
    const m = text.match(/window\.__OV_PAGE = (\{.*\});/);
    assert.ok(m, 'the page carries the Frame configuration');
    return JSON.parse(m[1]).navbar;
};
/** The links the navbar shows at the top, and the ones it folds into More. */
const split = (links) => ({
    top: links.filter((l) => !l.more).map((l) => l.label),
    more: links.filter((l) => l.more).map((l) => l.label),
});

(async () => {
    const t = await boot();
    const ada = t.network.addUser('c4c-ada');
    try {
        await check('a signed-in person&rsquo;s workspace page has one navigation: the Frame navbar&rsquo;s sections', async () => {
            const page = await t.get('/tasks', { as: ada });
            assert.strictEqual(page.status, 200);
            const links = navbarOf(page.text).links;
            const { top, more } = split(links);
            assert.deepStrictEqual(top, ['Home', 'Tasks', 'Agents', 'Machines', 'Usage', 'Settings'], 'the sections are the navbar');
            assert.ok(more.includes('Get started') && more.includes('Run on your machine'), 'the product&rsquo;s places fold into More');
            assert.ok(!top.includes('Agents') || top.filter((l) => l === 'Agents').length === 1, 'Agents is in one place only');
            const tasks = links.find((l) => l.href === '/tasks');
            assert.ok(tasks && tasks.active, 'the section the person is in is active');
            assert.ok(!links.find((l) => l.href === '/agents').active, 'and no other one is');
            // The page carries no sidebar of its own: the Frame owns the navigation.
            assert.ok(!page.text.includes('c4-side'), 'no second navigation on the page');
            assert.ok(!page.text.includes('c4-layout'), 'and no sidebar column');
        });

        await check('the section that is not the person&rsquo;s own &mdash; the product&rsquo;s catalogue &mdash; is named for what it is', async () => {
            const page = await t.get('/tasks', { as: ada });
            const { more } = split(navbarOf(page.text).links);
            assert.ok(more.includes('Agent catalogue'), 'the catalogue is the catalogue, not a second Agents');
            assert.ok(!more.includes('Agents'), 'and there is no second Agents in More');
        });

        await check('a visitor who is not signed in keeps the product&rsquo;s links', async () => {
            const page = await t.get('/tasks');
            assert.strictEqual(page.status, 200);
            const { top, more } = split(navbarOf(page.text).links);
            assert.ok(top.includes('Get started') && top.includes('Run on your machine'), 'the product&rsquo;s places are at the top');
            assert.ok(!top.includes('Tasks'), 'and the workspace&rsquo;s sections are not');
            assert.ok(more.includes('Improve OpenVibe'), 'the rest folds into More');
        });

        await check('a page that is not a workspace page keeps the product&rsquo;s links for a signed-in person too', async () => {
            const page = await t.get('/harnesses', { as: ada });
            assert.strictEqual(page.status, 200);
            const { top } = split(navbarOf(page.text).links);
            assert.ok(top.includes('Get started') && top.includes('Run on your machine'), 'the product&rsquo;s places are at the top');
            assert.ok(!top.includes('Machines'), 'and the workspace&rsquo;s sections are not');
        });

        await check('the phone page reserves the tab bar&rsquo;s height, so nothing hides under it', async () => {
            const page = await t.get('/settings', { as: ada });
            assert.ok(page.text.includes('<body class="ov-workspace">'), 'the workspace page says it carries a tab bar');
            const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'c4.css'), 'utf8');
            assert.ok(/body\.ov-workspace\{[^}]*--c4-tabs-h:calc\(58px \+ env\(safe-area-inset-bottom,0px\)\)/.test(css),
                'the tab bar&rsquo;s height is its own height plus the safe area');
            assert.ok(/body\.ov-workspace\{[^}]*padding-bottom:var\(--c4-tabs-h\)/.test(css),
                'and the page reserves it at the bottom');
            assert.ok(/\.c4-mobile\{[^}]*height:var\(--c4-tabs-h\)/.test(css), 'the bar itself is that tall');
        });

        await check('a card&rsquo;s muted note sits under its heading, not beside it', async () => {
            const page = await t.get('/', { as: ada });
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('<h2>Needs you</h2></div><p class="c4-sub">Approvals and questions</p>'),
                'the note is the card&rsquo;s subtitle');
            assert.ok(!page.text.includes('<h2>Needs you</h2><span'), 'and not a second title beside the heading');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
