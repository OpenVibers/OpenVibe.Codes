'use strict';
/**
 * Getting started (/start) says how to install the harness from this release's tag and names every agent the harness
 * has an adapter for, with what it needs; the home page leads there and lists what works today; the command line
 * prints the same version and points back at the page.
 */
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { boot, check, done } = require('./helpers/boot');
const { adaptersFor } = require('../harness');
const { version } = require('../package.json');

(async () => {
    const t = await boot();

    await check('/start installs from this release\'s tag and names every agent with what it needs', async () => {
        const r = await t.get('/start');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes(`npm install -g https://codeload.github.com/OpenVibers/OpenVibe.Codes/tar.gz/refs/tags/v${version}`), 'no install line for this version');
        for (const id of Object.keys(adaptersFor({}))) assert.ok(r.text.includes(`href="/harnesses#${id}"`), `no row for ${id}`);
        for (const env of ['DEEPSEEK_API_KEY', 'OPENVIBE_CODES_BASE_URL', 'OPENVIBE_CODES_MODEL']) assert.ok(r.text.includes(env), env);
        for (const level of ['read', 'edit', 'full']) assert.ok(r.text.includes(`<code>${level}</code>`), level);
        assert.match(r.text, /<link rel="canonical" href="https:\/\/openvibe\.codes\/start">/);
    });

    await check('the home page leads to /start and says the harness is live', async () => {
        const r = await t.get('/');
        assert.ok(r.text.includes('href="/start"'));
        assert.ok(r.text.includes(`Live, ${version}`));
        assert.ok(!/Hand-offs between agents, resumable sessions<\/td><td>Next/.test(r.text), 'the old "next" row is gone');
    });

    await check('the command line prints this version and points at the guide', () => {
        const bin = path.join(__dirname, '..', 'bin', 'openvibe-codes.js');
        const v = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
        assert.strictEqual(v.stdout.trim(), version);
        const help = spawnSync(process.execPath, [bin, 'run', '--help'], { encoding: 'utf8' });
        assert.strictEqual(help.status, 0);
        assert.match(help.stdout, /https:\/\/openvibe\.codes\/start/);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
