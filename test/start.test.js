'use strict';
/**
 * What a new conversation starts from (server/http/start.js): any Git address read as the https URL a task clones,
 * the hand-over of "Something new" to openvibe.space, OpenVibe's own projects as a list, and the ideas rail.
 */
const assert = require('assert');
const { check, done } = require('./helpers/boot');
const start = require('../server/http/start');

(async () => {
    await check('any Git address becomes the https URL a task clones, and nothing with a password does', async () => {
        const cases = [
            ['https://github.com/OpenVibers/OpenVibe.Live', 'https://github.com/OpenVibers/OpenVibe.Live'],
            ['https://github.com/OpenVibers/OpenVibe.Live/', 'https://github.com/OpenVibers/OpenVibe.Live'],
            ['OpenVibers/OpenVibe.Chat', 'https://github.com/OpenVibers/OpenVibe.Chat'],
            ['git@github.com:someone/thing.git', 'https://github.com/someone/thing.git'],
            ['git@gitlab.com:group/sub/project.git', 'https://gitlab.com/group/sub/project.git'],
            ['ssh://git@codeberg.org/someone/thing', 'https://codeberg.org/someone/thing'],
            ['ssh://git@git.example.com:2222/team/app.git', 'https://git.example.com/team/app.git'],
            ['git.openvibe.codes/OpenVibers/OpenVibe.Codes', 'https://git.openvibe.codes/OpenVibers/OpenVibe.Codes'],
            ['https://git.openvibe.codes/OpenVibers/OpenVibe.Codes.git#readme', 'https://git.openvibe.codes/OpenVibers/OpenVibe.Codes.git'],
        ];
        cases.forEach(([raw, want]) => assert.strictEqual(start.normalizeRepo(raw), want, raw));
        ['', '   ', 'http://github.com/a/b', 'ftp://example.com/a/b', 'https://user:pass@example.com/a/b', 'https://token@github.com/a/b',
            'file:///etc/passwd', 'https://github.com', 'not a url', 'javascript:alert(1)', `https://x.com/${'a'.repeat(600)}`]
            .forEach((raw) => assert.strictEqual(start.normalizeRepo(raw), '', `refused: ${raw.slice(0, 40)}`));
    });

    await check('something new is handed to openvibe.space through sign-in, led by what it is, and always fits', async () => {
        const read = (href) => {
            const u = new URL(href);
            assert.strictEqual(u.origin, 'https://openvibe.space');
            assert.strictEqual(u.pathname, '/auth/login');
            const next = new URL(u.searchParams.get('next'), 'https://openvibe.space');
            assert.strictEqual(next.pathname, '/spaces/new');
            assert.strictEqual(next.searchParams.get('from'), 'codes');
            return next.searchParams.get('prompt');
        };
        assert.strictEqual(read(start.spaceHref({ kind: 'game', text: 'Snake with a leaderboard' })), 'A browser game: Snake with a leaderboard');
        assert.strictEqual(read(start.spaceHref({ kind: 'game', text: 'A puzzle about trains' })), 'A puzzle about trains', 'words that say it already are not led');
        assert.strictEqual(read(start.spaceHref({ kind: 'website', text: 'Hours and a menu for my bakery' })), 'A website: Hours and a menu for my bakery');
        assert.strictEqual(read(start.spaceHref({ kind: 'app', text: 'A habit tracker' })), 'A habit tracker');
        assert.strictEqual(read(start.spaceHref({ kind: 'nope', text: 'Hours for my shop' })), 'A website: Hours for my shop', 'an unknown kind is a website');
        const long = start.spaceHref({ kind: 'app', text: 'ほ'.repeat(4000) });
        assert.ok(long.length <= 6000, `the address fits (${long.length})`);
        assert.ok(read(long).length > 100, 'and still carries the start of the words');
    });

    await check('OpenVibe projects are the live sites and the shared libraries, each cloned from GitHub', async () => {
        assert.ok(start.PROJECTS.length >= 20, `a real list (${start.PROJECTS.length})`);
        const live = start.project('OpenVibers/OpenVibe.Live');
        assert.ok(live && live.name === 'Live' && live.domain === 'openvibe.live' && live.url === 'https://github.com/OpenVibers/OpenVibe.Live');
        assert.ok(start.project('OpenVibers/OpenVibe.Shared'), 'the shared libraries are there too');
        assert.strictEqual(start.project('someone/else'), null);
        assert.strictEqual(new Set(start.PROJECTS.map((p) => p.repository)).size, start.PROJECTS.length, 'no project twice');
        start.PROJECTS.forEach((p) => assert.match(p.url, /^https:\/\/github\.com\/OpenVibers\/[A-Za-z0-9._-]+$/, p.repository));
    });

    await check('the projects a request is about come from its own words (owner, 11-01)', async () => {
        const names = (t) => start.matchProjects(t).map((p) => p.name);
        assert.deepStrictEqual(names('Make the navbar smaller on phones'), ['Shared'], 'a topic only one project owns');
        assert.deepStrictEqual(names('Fix the sign in page'), ['Network']);
        assert.deepStrictEqual(names('Add a leaderboard to Games and show it on Live'), ['Games', 'Live'], 'two sites named: both');
        assert.ok(names('Add a dark mode to openvibe.live')[0] === 'Live', 'the domain leads');
        assert.ok(names('Let me drive the robot from Live').includes('Bot') && names('Let me drive the robot from Live').includes('Live'));
        assert.deepStrictEqual(names('make the home page load faster'), [], 'no site named, none guessed');
        assert.deepStrictEqual(names('I want a better world'), [], 'a plain word is not a project');
        assert.ok(start.matchProjects('Live Chat Games Tips Food News Wiki and Rent').length <= 3, 'three at most');
        assert.deepStrictEqual(names(''), []);
    });

    await check('the ideas rail: something new mixes the three kinds, every way has its own ideas', async () => {
        const fresh = start.ideasFor('new');
        assert.deepStrictEqual(fresh.slice(0, 3).map((i) => i.kind), ['website', 'game', 'app']);
        assert.ok(fresh.every((i) => i.mode === 'new' && i.text));
        start.MODES.forEach((m) => assert.ok(start.ideasFor(m).length >= 6, m));
        assert.ok(start.ideasFor('code').every((i) => i.kind === null));
    });
    done();
})().catch((e) => { console.error(e); process.exit(1); });
