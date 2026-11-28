'use strict';
/**
 * Loops (/loops; plan §AD.37, the owner 11-21: "a way better system … as a product offering"): openvibe.codes/loops was
 * a 404. Signed out it says what loops are (six tiles, how a loop runs), may be indexed and is in the sitemap and
 * llms.txt; signed in it lists the person's loops (and only theirs), starts one, turns spare usage on, and pauses,
 * queues and removes, each form returning to /loops through the spare list's own handlers.
 */
const assert = require('node:assert/strict');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot({});
    const ada = t.network.addUser('ada');
    const bo = t.network.addUser('bo');
    const mine = async (who) => (await t.get('/api/v1/me/spare', { as: who })).json();
    try {
        await check('signed out: the six loops and how a loop runs, indexable, with sign-in', async () => {
            const r = await t.get('/loops');
            assert.equal(r.status, 200, r.text.slice(0, 300));
            for (const name of ['Accessibility', 'Security', 'Speed', 'Tests', 'Docs', 'Dependencies']) assert.match(r.text, new RegExp(`class="lp-tname">${name}<`));
            assert.match(r.text, /How a loop runs/);
            assert.match(r.text, /<meta name="robots" content="index, follow"/);
            assert.match(r.text, /href="\/auth\/login\?next=%2Floops"/);
            assert.doesNotMatch(r.text, /name="loop"/, 'no start form for a visitor');
            assert.match((await t.get('/sitemap.xml')).text, /\/loops<\/loc>/);
            assert.match((await t.get('/llms.txt')).text, /\/loops\)/);
        });

        await check('signed in: spare usage off says so and turns on from here, back to /loops', async () => {
            const r = await t.get('/loops', { as: ada });
            assert.equal(r.status, 200);
            assert.match(r.text, /Spare usage is off/);
            assert.match(r.text, /None yet/);
            const on = await t.get('/settings/spare', { as: ada, method: 'POST', form: { back: '/loops', enabled: 'true', reset_within_hours: '12', min_left_pct: '15', keep_pct: '5', max_running: '1' }, redirect: 'manual' });
            assert.equal(on.status, 303);
            assert.match(on.headers.get('location'), /^\/loops\?ok=/);
            assert.equal((await mine(ada)).settings.enabled, true);
            assert.doesNotMatch((await t.get('/loops', { as: ada })).text, /Spare usage is off/);
        });

        await check('start a loop from the page: it lists with its repository, site and state; bo sees none of it', async () => {
            const add = await t.get('/settings/spare/loops', { as: ada, method: 'POST', form: { back: '/loops', loop: 'security', repo: 'OpenVibers/OpenVibe.Mail', site: 'https://openvibe.email' }, redirect: 'manual' });
            assert.equal(add.status, 303, add.text);
            assert.match(add.headers.get('location'), /^\/loops\?ok=/);
            const bad = await t.get('/settings/spare/loops', { as: ada, method: 'POST', form: { back: '/loops', loop: 'vibes', repo: 'a/b' }, redirect: 'manual' });
            assert.match(bad.headers.get('location'), /^\/loops\?error=/);
            // A plain task on the list is not a loop and is not listed here.
            await t.get('/settings/spare/tasks', { as: ada, method: 'POST', form: { prompt: 'Refactor fleet.js', repo: 'a/b', agent: 'any', priority: '3' }, redirect: 'manual' });
            const r = await t.get('/loops', { as: ada });
            assert.match(r.text, /<strong>Security<\/strong>/);
            assert.match(r.text, /c4-hint">OpenVibers\/OpenVibe\.Mail · openvibe\.email</);
            assert.match(r.text, /Waits for spare time/);
            assert.doesNotMatch(r.text, /Refactor fleet\.js/);
            assert.match((await t.get('/loops', { as: bo })).text, /None yet/);
        });

        await check('pause, queue and remove return to /loops', async () => {
            const loop = (await mine(ada)).tasks.find((x) => x.title === 'Security loop');
            const pause = await t.get(`/settings/spare/tasks/${loop.id}`, { as: ada, method: 'POST', form: { back: '/loops', do: 'pause' }, redirect: 'manual' });
            assert.equal(pause.headers.get('location'), '/loops');
            assert.match((await t.get('/loops', { as: ada })).text, /class="lp-row is-paused"[\s\S]*Queue it/);
            await t.get(`/settings/spare/tasks/${loop.id}`, { as: ada, method: 'POST', form: { back: '/loops', do: 'queue' }, redirect: 'manual' });
            assert.equal((await mine(ada)).tasks.find((x) => x.id === loop.id).state, 'queued');
            const rm = await t.get(`/settings/spare/tasks/${loop.id}`, { as: ada, method: 'POST', form: { back: '/loops', do: 'remove' }, redirect: 'manual' });
            assert.equal(rm.headers.get('location'), '/loops');
            assert.match((await t.get('/loops', { as: ada })).text, /None yet/);
            const other = await t.get(`/settings/spare/tasks/${loop.id}`, { as: ada, method: 'POST', form: { back: 'https://evil.example/', do: 'pause' }, redirect: 'manual' });
            assert.match(other.headers.get('location'), /^\/settings\/spare/, 'back is only ever /loops');
        });
    } finally {
        await t.close();
    }
    done();
})();
