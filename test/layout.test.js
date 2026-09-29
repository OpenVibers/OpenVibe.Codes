'use strict';
/**
 * Every page carries the openvibe-shared boost marker and self-starting script (plan T11), so a
 * same-site click swaps <main> in place without a reload. The marker names the layout's release,
 * which the app sets from openvibe-shared/release (a swap only happens between pages of the same
 * release; across a deploy it is a normal load), the boost tag names #main in data-main, and the
 * shared navbar's sign-in follows the current page through the {path} template.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const MARKER = /<meta name="ov-boost" content="(codes@[0-9A-Za-z._+-]{1,64})">/;
const BOOST = /<script src="\/shared\/boost\.js\?v=[0-9a-f]{12}" data-main="#main" defer><\/script>/;

(async () => {
    const t = await boot();
    const user = t.network.addUser('kim');
    const release = (await t.get('/release.json')).json().release;

    await check('every rendered page carries the ov-boost marker (the app\'s release) and the data-main boost script', async () => {
        for (const p of ['/', '/docs', '/oauth', '/manifests/validate']) {
            const r = await t.get(p);
            assert.strictEqual(r.status, 200, p);
            const m = r.text.match(MARKER);
            assert.ok(m, `${p}: no ov-boost marker`);
            assert.strictEqual(m[1], `codes@${release}`, `${p}: the marker is not the app's release`);
            assert.match(r.text, BOOST, `${p}: no boost script with data-main`);
            assert.match(r.text, /<main id="main"/, `${p}: the page's main is not #main`);
        }
        const signedIn = await t.get('/projects', { as: user });
        assert.strictEqual(signedIn.status, 200);
        assert.match(signedIn.text, MARKER, '/projects: no ov-boost marker');
        assert.match(signedIn.text, BOOST, '/projects: no boost script');
    });

    await check('the navbar config uses the {path} login template, not the path baked in', async () => {
        const r = await t.get('/docs');
        assert.match(r.text, /"loginUrl":"\/auth\/login\?next=\{path\}"/);
        assert.ok(!/"loginUrl":"\/auth\/login\?next=%2F/.test(r.text), 'loginUrl still has the current path baked in');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
