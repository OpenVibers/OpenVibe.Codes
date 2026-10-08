'use strict';
/**
 * Codes fetches no URL anyone typed (roadmap WS-R task 5, the SSRF class). The values a caller can hand Codes (a
 * routing request's requirements, sign-in's next=, the developer console's old addresses that now redirect) are read
 * or echoed into a redirect, never requested: every outbound request of the process is recorded while requests full
 * of internal addresses in every spelling go through them, and none may go to any of them. And a ratchet: every file
 * in server/ that makes an outbound request itself is on a reviewed list with where it goes.
 *
 *   node test/security-ssrf.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const outbound = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => { outbound.push(String((url && url.url) || url)); return realFetch(url, opts); };

const { boot, check, done } = require('./helpers/boot');

const PROBE = '/ssrf-probe-path';
const INTERNAL = [`http://127.0.0.1:3000${PROBE}`, `http://2130706433${PROBE}`, `http://0x7f000001${PROBE}`, `http://[::1]${PROBE}`, `http://[::ffff:127.0.0.1]${PROBE}`,
    `http://169.254.169.254/latest/meta-data${PROBE}`, `http://10.0.0.1${PROBE}`, `http://localhost:4001${PROBE}`, `file:///etc/passwd${PROBE}`, `gopher://127.0.0.1:6379/_x${PROBE}`];

(async () => {
    const t = await boot();
    const dev = t.network.addUser('dev');
    await check('routing requests, sign-in and the moved addresses full of internal URLs are never fetched', async () => {
        for (const u of INTERNAL) {
            await t.get('/api/v1/harnesses/route', { as: dev, json: { task: 'edit', requirements: { capabilities: [u], url: u, endpoint: u } } });
            await t.get(`/auth/login?next=${encodeURIComponent(u)}`);
            await t.get(`/projects?url=${encodeURIComponent(u)}`);
            await t.get(`/tools/webhooks?url=${encodeURIComponent(u)}`);
            await t.get('/api/v1/releases', { method: 'POST', json: { url: u } });
        }
        const hit = outbound.filter((u) => u.includes(PROBE));
        assert.deepStrictEqual(hit, [], 'Codes fetched a URL a caller typed');
    });

    await check('ratchet: every file that makes an outbound request itself is reviewed', () => {
        const REVIEWED = {
            'server/auth/keys.js': 'no request itself; openvibe-sdk/auth fetches the JWKS',
            'server/auth/sso.js': 'Network OAuth token and revoke (configured)',
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
        assert.ok(found.includes('server/auth/sso.js'), `the scan finds the known site (${found.join(', ')})`);
        assert.deepStrictEqual(found.filter((f) => !REVIEWED[f]).sort(), [], 'a new outbound request site: a developer-chosen URL goes through openvibe-shared/egress; then add the file here with where it goes');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
