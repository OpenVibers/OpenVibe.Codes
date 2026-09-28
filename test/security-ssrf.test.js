'use strict';
/**
 * Codes fetches no URL a developer typed (roadmap WS-R task 5, the SSRF class). The URLs developers
 * give Codes (manifest homepage/icon/webhook fields, OAuth redirect URIs, the webhook tester's
 * delivery target) are validated and stored, or used to build a sample, never requested: every
 * outbound request of the process is recorded while manifests and forms full of internal addresses
 * in every spelling go through validate, create and publish, the redirect form and the webhook
 * tools, and none may go to any of them. And a ratchet: every file in server/ that makes an
 * outbound request itself is on a reviewed list with where it goes.
 *
 *   node test/security-ssrf.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const outbound = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => { outbound.push(String((url && url.url) || url)); return realFetch(url, opts); };

const manifests = require('../server/domain/manifests');
const { boot, check, done } = require('./helpers/boot');

const PROBE = '/ssrf-probe-path';
const INTERNAL = [`http://127.0.0.1:3000${PROBE}`, `http://2130706433${PROBE}`, `http://0x7f000001${PROBE}`, `http://[::1]${PROBE}`, `http://[::ffff:127.0.0.1]${PROBE}`,
    `http://169.254.169.254/latest/meta-data${PROBE}`, `http://10.0.0.1${PROBE}`, `http://localhost:4001${PROBE}`, `file:///etc/passwd${PROBE}`, `gopher://127.0.0.1:6379/_x${PROBE}`];

(async () => {
    const t = await boot();
    const dev = t.network.addUser('dev');
    const project = await t.project(dev, 'Probe Project');
    const app = await t.app(dev, project, { name: 'Probe App' });
    const base = `/projects/${project}/apps/${app.id}`;

    await check('manifests, redirect URIs and the webhook tools full of internal URLs are never fetched', async () => {
        let v = 1;
        for (const u of INTERNAL) {
            const manifest = JSON.stringify({ ...manifests.template('app', { appId: app.id, projectId: project, environment: 'sandbox', name: 'Probe App' }), version: `1.0.${v++}`,
                homepage: u, icon: u, icon_url: u, webhook_url: u, webhooks: [{ url: u, events: ['x'] }], support_url: u, privacy_policy_url: u });
            await t.get(`${base}/releases`, { as: dev, form: { kind: 'app', manifest, intent: 'validate' } });
            const made = await t.get(`${base}/releases`, { as: dev, form: { kind: 'app', manifest, intent: 'create' } });
            if (made.status === 303) await t.get(`/releases/${made.headers.get('location').split('/').pop()}/publish`, { as: dev, form: {} });
            await t.get('/manifests/validate', { form: { kind: 'app', manifest } });
            await t.get(`${base}/redirects`, { as: dev, form: { redirect_uris: u } });
            await t.get('/tools/webhooks/sample', { form: { url: u, endpoint: u, secret: 'sample-not-a-secret', event_type: 'codes.app.published' } });
            await t.get('/tools/webhooks/verify', { form: { url: u, endpoint: u, secret: 'sample-not-a-secret', body: '{}', signature_v2: 't=1,v2=00' } });
            await t.get(`/tools/webhooks?url=${encodeURIComponent(u)}`);
        }
        const hit = outbound.filter((u) => u.includes(PROBE));
        assert.deepStrictEqual(hit, [], 'Codes fetched a URL a developer typed');
    });

    await check('ratchet: every file that makes an outbound request itself is reviewed', () => {
        const REVIEWED = {
            'server/auth/keys.js': 'Network JWKS (configured)',
            'server/auth/sso.js': 'Network OAuth token and revoke (configured)',
            'server/domain/limits.js': 'the services\' /limits.json (configured internal URLs)',
            'server/domain/project-archive.js': 'no request: a shell snippet in the archive\'s README text',
            'server/http/docs.js': 'Network changelog, Tools catalog and Billing policy (configured)',
        };
        const root = path.join(__dirname, '..');
        const found = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const f = path.join(dir, e.name);
                if (e.isDirectory()) walk(f);
                else if (e.name.endsWith('.js')) {
                    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
                    if (/(^|[^.\w])(fetch|fetchImpl)\(|\bhttps?\.(get|request)\(|new WebSocket\(|require\(['"](axios|got|node-fetch|undici)['"]\)/m.test(src)) found.push(path.relative(root, f));
                }
            }
        };
        walk(path.join(root, 'server'));
        assert.ok(found.length >= 4, `the scan finds the known sites (${found.join(', ')})`);
        assert.deepStrictEqual(found.filter((f) => !REVIEWED[f]).sort(), [], 'a new outbound request site: a developer-chosen URL goes through openvibe-shared/egress; then add the file here with where it goes');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
