'use strict';
/**
 * Owner inputs (the owner-setup design of 2026-11-07): Codes' sign-in apps, the GitHub reader token and the publishing
 * tokens, in `codes.accounts` and `codes.publishing`, listed by the admin panel's Setup tab.
 *
 * Proves: the fields carry x-owner-input, titles and 30+ character descriptions, and every field of every Codes
 * namespace does; the keys Codes reads (the OpenVibe Git app, the GitHub token) come from the panel's sealed value when
 * set and from the environment otherwise, at use time; the publishing tokens, which no job reads yet, are Optional
 * (no x-required-for) and say what they unlock; the test hook answers in one line and never carries the value, not
 * even when the provider echoes it; no log line carries a value.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/boot');
const { lintSchema } = require('./helpers/lint-schema');

const CAP = ['codes.config.manage'];
const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const KEK = crypto.randomBytes(32).toString('base64');
const ENV_GH = 'github_pat_madeUpENVtokenFROMSETTINGSFILE0001';
const PANEL_GH = 'github_pat_madeUpPANELtokenNEVERSHOWN000002';
const APP_SECRET = 'madeUpGitHubAppSecretNEVERSHOWN0000000003';
const BAD_NPM = 'npm_madeUpBadTokenTHATNPMECHOESBACK0000004';
const FORGE_SECRET = 'madeUpForgeSecretNEVERSHOWN00000000000005';
const SECRETS = [ENV_GH, PANEL_GH, APP_SECRET, BAD_NPM, FORGE_SECRET];

const calls = [];
async function fakeFetch(url, init = {}) {
    const u = String(url);
    const outside = /^https:\/\/(api\.github\.com|github\.com|registry\.npmjs\.org)\//.test(u) || /\/login\/oauth\/access_token$/.test(u);
    if (!outside) return globalThis.fetch(url, init);
    const auth = String((init.headers && (init.headers.Authorization || init.headers.authorization)) || '');
    calls.push({ url: u, auth, body: init.body ? String(init.body) : '' });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.endsWith('/rate_limit')) {
        if (auth === `Bearer ${ENV_GH}` || auth === `Bearer ${PANEL_GH}`) return json(200, { resources: { core: { limit: 5000, remaining: 4999 } } });
        return json(401, { message: 'Bad credentials' });
    }
    if (u.startsWith('https://api.github.com/search/repositories')) return json(200, { items: [] });
    if (u === 'https://github.com/login/oauth/access_token') {
        const form = new URLSearchParams(String(init.body || ''));
        return form.get('client_secret') === APP_SECRET && form.get('client_id') === 'Ov23liMadeUpClient'
            ? json(200, { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' })
            : json(200, { error: 'incorrect_client_credentials', error_description: 'The client_id and/or client_secret passed are incorrect.' });
    }
    if (u.endsWith('/login/oauth/access_token')) {
        const form = new URLSearchParams(String(init.body || ''));
        return form.get('client_secret') === FORGE_SECRET ? json(400, { error: 'invalid_grant', error_description: 'client is not authorized' }) : json(400, { error: 'unauthorized_client', error_description: 'invalid client secret' });
    }
    if (u === 'https://registry.npmjs.org/-/whoami') return json(401, { error: `token ${auth.replace(/^Bearer /, '')} is not valid` });
    return json(404, { message: 'not here' });
}

(async () => {
    const consoleLines = [];
    const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of Object.keys(original)) console[k] = (...a) => { consoleLines.push(a.join(' ')); original[k](...a); };
    const t = await boot({ env: { OV_CONFIG_KEKS: `k1:${KEK}`, OV_CONFIG_KEK_CURRENT: 'k1', CODES_GITHUB_TOKEN: ENV_GH, CODES_SEAL_KEY: crypto.randomBytes(32).toString('base64') }, fetchImpl: fakeFetch });
    const admin = () => t.network.mintService('svc:network', 'openvibe.codes', CAP);
    const cfg = (method, p, json) => t.get(p, { method, bearer: admin(), headers: { 'x-ov-subject': OWNER, 'x-ov-fresh': '1' }, ...(json ? { json } : {}) });
    const test = (ns, key) => cfg('POST', `/internal/config/${ns}/test/${key}`);
    try {
        await check('every field of every Codes namespace has a title, a 30+ character description and labelled options', async () => {
            const r = await cfg('GET', '/internal/config');
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.deepStrictEqual(r.json().namespaces.map((n) => n.namespace), ['codes.ai', 'codes.accounts', 'codes.publishing']);
            for (const ns of r.json().namespaces) assert.deepStrictEqual(lintSchema(ns.schema), [], `${ns.namespace}: ${lintSchema(ns.schema).join('; ')}`);
        });

        await check('the sign-in apps, the GitHub token and the publishing tokens are owner inputs in their groups', async () => {
            const a = (await cfg('GET', '/internal/config/codes.accounts')).json().schema.properties;
            assert.deepStrictEqual(['forge.client_id', 'forge.client_secret', 'github.client_id', 'github.client_secret'].map((k) => a[k]['x-owner-input'].group), ['sign-in-apps', 'sign-in-apps', 'sign-in-apps', 'sign-in-apps']);
            assert.strictEqual(a['forge.client_secret']['x-required-for'], 'Linking an OpenVibe Git account', 'Codes reads it: linking is off without it');
            assert.strictEqual(a['github.client_secret']['x-required-for'], undefined, 'nothing reads the GitHub app yet: Optional');
            assert.match(a['github.client_id']['x-owner-input'].unlocks, /Optional/);
            assert.deepStrictEqual([a['github.token']['x-owner-input'].group, a['github.token']['x-owner-input'].test], ['data-sources', true]);
            const p = (await cfg('GET', '/internal/config/codes.publishing')).json().schema.properties;
            assert.deepStrictEqual(Object.keys(p).sort(), ['chrome.client_id', 'chrome.client_secret', 'chrome.refresh_token', 'firefox.jwt_issuer', 'firefox.jwt_secret', 'npm.token', 'signing.apple_certificate', 'signing.apple_password', 'signing.windows_certificate', 'signing.windows_password']);
            for (const [k, f] of Object.entries(p)) {
                assert.strictEqual(f['x-owner-input'].group, 'design-publishing', k);
                assert.strictEqual(f['x-required-for'], undefined, `${k}: no release job reads it yet, so it is Optional`);
                assert.match(f['x-owner-input'].unlocks, /Optional/, k);
            }
        });

        await check('without a panel token GitHub is read with the settings file\'s; the test says so', async () => {
            assert.strictEqual(t.config.github.token, ENV_GH);
            const r = await test('codes.accounts', 'github.token');
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.deepStrictEqual([r.json().ok, r.json().state, r.json().source], [true, 'connected', 'env']);
            assert.strictEqual(r.json().message, "GitHub accepted the token: Codes may make 5,000 requests an hour. (the value from the server's settings file, CODES_GITHUB_TOKEN)");
        });

        await check('a panel token is sealed, write-only and wins at use time', async () => {
            const put = await cfg('PUT', '/internal/config/codes.accounts/secrets/github.token', { value: PANEL_GH, reason: 'setup' });
            assert.strictEqual(put.status, 200, put.text.slice(0, 300));
            assert.ok(!put.text.includes(PANEL_GH));
            assert.strictEqual(t.config.github.token, PANEL_GH);
            const before = calls.length;
            await t.ctx.github.search('usr_01JAB2C3D4E5F6G7H8J9K0MNPR', 'openvibe', { limit: 1 }).catch(() => null);
            const sent = calls.slice(before).filter((c) => c.url.startsWith('https://api.github.com/'));
            assert.ok(sent.length && sent.every((c) => c.auth === `Bearer ${PANEL_GH}`), 'the repository search used the panel token');
            const carried = await cfg('POST', '/internal/config/codes.accounts', { values: { 'github.token': PANEL_GH }, reason: 'not here' });
            assert.deepStrictEqual([carried.status, carried.json().code], [422, 'config.secret_write_only']);
            const row = await t.ctx.store.db.prepare("SELECT values_json FROM config_snapshots WHERE namespace = 'codes.accounts' AND state = 'active'").get();
            assert.ok(!row.values_json.includes(PANEL_GH), 'sealed at rest');
        });

        await check('the OpenVibe Git app from the panel opens linking at use time; its test checks the app with the forge', async () => {
            assert.strictEqual(t.ctx.forge.enabled, false, 'no app yet: linking is closed');
            const id = await cfg('POST', '/internal/config/codes.accounts', { values: { 'forge.client_id': 'forge-client-1234' }, merge: true, reason: 'setup' });
            assert.strictEqual(id.status, 200, id.text.slice(0, 300));
            const put = await cfg('PUT', '/internal/config/codes.accounts/secrets/forge.client_secret', { value: FORGE_SECRET, reason: 'setup' });
            assert.strictEqual(put.status, 200, put.text.slice(0, 300));
            assert.strictEqual(t.ctx.forge.enabled, true, 'the panel values opened linking without a restart');
            assert.strictEqual(t.config.git.clientId, 'forge-client-1234');
            const r = await test('codes.accounts', 'forge.client_secret');
            assert.deepStrictEqual([r.json().ok, r.json().source, r.json().message], [true, 'vault', 'OpenVibe Git accepted the app\'s client ID and secret.']);
        });

        await check('the GitHub app is tested without signing anyone in; a wrong secret is refused in one line', async () => {
            const none = await test('codes.accounts', 'github.client_secret');
            assert.deepStrictEqual([none.status, none.json().code], [409, 'config.not_set']);
            await cfg('POST', '/internal/config/codes.accounts', { values: { 'github.client_id': 'Ov23liMadeUpClient' }, merge: true, reason: 'setup' });
            await cfg('PUT', '/internal/config/codes.accounts/secrets/github.client_secret', { value: APP_SECRET, reason: 'setup' });
            const ok = await test('codes.accounts', 'github.client_secret');
            assert.deepStrictEqual([ok.json().ok, ok.json().message], [true, 'GitHub accepted the app\'s client ID and secret.']);
            await cfg('POST', '/internal/config/codes.accounts', { values: { 'github.client_id': 'Ov23liWrongClient' }, merge: true, reason: 'wrong id' });
            const bad = await test('codes.accounts', 'github.client_secret');
            assert.deepStrictEqual([bad.json().ok, bad.json().state], [false, 'not_working']);
            assert.match(bad.json().message, /^GitHub refused the app's client ID or secret: The client_id and\/or client_secret passed are incorrect\.$/);
            assert.ok(calls.filter((c) => c.url === 'https://github.com/login/oauth/access_token').every((c) => /code=openvibe-setup-check/.test(c.body)), 'a code that cannot exist: nobody is signed in');
        });

        await check('a refused npm token is Not working in one line, and the echoed token never comes back', async () => {
            await cfg('PUT', '/internal/config/codes.publishing/secrets/npm.token', { value: BAD_NPM, reason: 'setup' });
            const r = await test('codes.publishing', 'npm.token');
            assert.deepStrictEqual([r.status, r.json().ok, r.json().state], [200, false, 'not_working']);
            assert.match(r.json().message, /^npm refused the token \(401\): token \[hidden\] is not valid$/);
            assert.ok(!r.text.includes(BAD_NPM) && !r.text.includes(BAD_NPM.slice(0, 12)));
        });

        await check('removing the panel token falls back to the settings file', async () => {
            const del = await cfg('DELETE', '/internal/config/codes.accounts/secrets/github.token', { reason: 'back to env' });
            assert.strictEqual(del.status, 200, del.text.slice(0, 300));
            assert.strictEqual(t.config.github.token, ENV_GH);
        });

        await check('the test hook is guarded and answers only for keys with a test', async () => {
            const wrong = t.network.mintService('svc:reader', 'openvibe.codes', ['codes.task.read']);
            const denied = await t.get('/internal/config/codes.accounts/test/github.token', { method: 'POST', bearer: wrong });
            assert.strictEqual(denied.status, 403);
            const none = await test('codes.publishing', 'signing.windows_password');
            assert.deepStrictEqual([none.status, none.json().code], [404, 'config.test_not_found']);
        });

        await check('no log line or console line carries a value', async () => {
            for (const k of Object.keys(original)) console[k] = original[k];
            const logs = t.logs();
            for (const s of SECRETS) {
                assert.ok(!logs.includes(s), `a log line carries ${s.slice(0, 14)}…`);
                assert.ok(consoleLines.every((l) => !l.includes(s)), `a console line carries ${s.slice(0, 14)}…`);
            }
            assert.match(logs, /\[config\] test codes\.publishing npm\.token: not working/);
        });
    } finally { await t.close(); }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
