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
            assert.deepStrictEqual(top, ['Home', 'Tasks', 'Conductor', 'Agents', 'Machines', 'Memory', 'Usage', 'Settings'], 'the sections are the navbar');
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

        await check('the phone page reserves the Frame app bar&rsquo;s height, and has no bar of its own', async () => {
            const page = await t.get('/settings', { as: ada });
            assert.ok(page.text.includes('<body class="ov-workspace">'), 'the workspace page says it carries a tab bar');
            assert.ok(!page.text.includes('c4-mobile'), 'and it draws no second bar of its own');
            const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'c4.css'), 'utf8');
            assert.ok(/body\.ov-workspace\{[^}]*padding-bottom:var\(--ovnav-appbar-h,calc\(58px \+ env\(safe-area-inset-bottom,0px\)\)\)/.test(css),
                'the page reserves the Frame bar&rsquo;s height, its safe area included');
        });

        await check('the Frame&rsquo;s app bar is the workspace&rsquo;s sections for a signed-in person, and the product&rsquo;s for a visitor', async () => {
            const signedIn = await t.get('/tasks', { as: ada });
            assert.strictEqual(navbarOf(signedIn.text).appBar, true,
                'the bar takes the navbar&rsquo;s own sections: the first four and More (Shared appbar.js)');
            const visitor = await t.get('/tasks');
            const bar = navbarOf(visitor.text).appBar;
            assert.ok(Array.isArray(bar) && bar.length <= 5, 'a visitor&rsquo;s bar is at most five places');
            assert.deepStrictEqual(bar.map((l) => l.label), ['Home', 'Start', 'Run', 'Agents'], 'and they are the product&rsquo;s');
        });

        await check('a signed-in person&rsquo;s home is a new chat, not a page of cards (plan L31)', async () => {
            const page = await t.get('/', { as: ada });
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('What should we build') && page.text.includes('action="/chat"'), 'the greeting and the composer');
            assert.ok(!page.text.includes('class="c4-card'), 'no cards');
            assert.ok(page.text.includes('aria-label="Your conversations"'), 'the rail of conversations is the navigation');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
