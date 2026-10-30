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
            'server/domain/forgejo.js': 'OpenVibe Git API (CODES_GIT_INTERNAL_URL, configured loopback Forgejo) with a service token; paths built from validated owner/name',
            'server/domain/run-client.js': 'OpenVibe.Run (CODES_RUN_URL, configured) and the Network token endpoint; job ids only, never a URL from a person',
            'server/domain/bench-publisher.js': 'OpenVibe.Bench (CODES_BENCH_URL, configured) run publishing and the Network token endpoint; artifact URLs use the configured render origin',
            'server/http/run.js': 'Network projects API (configured) with the viewer\'s token, and the Run job stream URL run-client.js builds on its own base',
            'server/http/home.js': 'OpenVibe Git\'s public repository search (CODES_GIT_INTERNAL_URL, configured loopback Forgejo) for the home page; no token',
            'server/http/me-api.js': 'Network projects API (configured) with the viewer\'s token, for the user task API; no URL from a person',
            'server/http/tasks-api.js': 'OpenVibe.Bench (CODES_BENCH_URL, configured), Network projects API (configured) with the verified user token; benchmark ids and task ids are URL-encoded, no URL from a person',
            'server/http/pages.js': 'Network projects API (configured) for Improve OpenVibe project creation; Forgejo repo read (CODES_GIT_INTERNAL_URL) for repo details; no URL from a person',
            'server/domain/connections.js': 'OpenVibe.AI (CODES_AI_URL, configured) for a person\'s own keys: the credential routes and the two model endpoints, with the provider and the subject as path segments; no URL from a person',
            'server/domain/run-tokens.js': 'OpenVibe.Network\'s token endpoint (OV_NETWORK_INTERNAL_URL, configured) for a run token; no URL from a person',
            'server/domain/machines.js': 'OpenVibe.Network (OV_NETWORK_INTERNAL_URL, configured) /api/v1/me/nodes with the person\'s own session token: their machines and a revoke; the path id is checked against a nod_ shape, never a URL from a person',
            'server/domain/conductor.js': 'OpenVibe.Network\'s projects API (OV_NETWORK_INTERNAL_URL, configured) with the person\'s own token, for the project a conductor runs in; and the Run job stream URL run-client.js builds on its own base. No URL from a person',
            'server/domain/github.js': 'api.github.com only, at fixed paths: the public repository search and a pull request\'s state. The owner/name/number come from a Codes-stored task result and are checked against GitHub\'s id shapes before they are put in a path',
            'server/domain/fleet.js': 'OpenVibe.Bot (CODES_BOT_INTERNAL_URL, configured) /api/v1/machines with the person\'s own session token: their machines and the fleet their Nodes reported; the path is fixed, never a URL from a person',
            'server/domain/ship.js': 'the service\'s own GET <publicOrigin>/release.json and api.github.com\'s compare, both at fixed paths: the origin is the contracts\' service manifest, never a URL from a person; the shas are checked hex',
            'server/events-consumer.js': 'OpenVibe.Events subscriptions (EVENTS_URL, configured) at boot; no URL from a person',
            'server/events/outbox.js': 'OpenVibe.Events publish (EVENTS_URL, configured) of fixed codes.task.* payloads; no URL from a person',
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
