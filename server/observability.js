'use strict';
/**
 * Truthful readiness for GET /api/ready (openvibe-shared/ready, Track O).
 *
 *   db              required  a real round trip to Codes' PostgreSQL store (it holds no table of its own since the
 *                             console moved to OpenVibe.Services; the harness's runs will)
 *   catalog         required  the harness catalog loaded and validated at boot
 *   jwks            optional  openvibe-sdk/auth's JWKS cache has the Network signing key; without it nobody can sign
 *                             in (every public page and the router still serve). The SDK keeps one client per URL and
 *                             reports readiness, staleness, failures and the next try for us.
 *   oauth_client    optional  OV_OAUTH_CLIENT_SECRET is set (sign-in needs it)
 *   valkey          optional  shared per-actor limit counters
 */
const { jwksStatus } = require('openvibe-sdk/auth');
const { createReadiness } = require('openvibe-shared/ready');

function createCodesReadiness({ store, harnesses, config, valkey = null, release = null }) {
    const { db } = store;
    return createReadiness({
        service: 'codes',
        release,
        checks: [
            {
                name: 'db', required: true,
                // A real round trip that names the store (postgresql / pglite).
                check: async () => {
                    const r = await db.ready();
                    return r.ok ? { ok: true, detail: r.detail } : r.error;
                },
            },
            {
                name: 'catalog', required: true,
                check: () => (harnesses && harnesses.list().length ? { ok: true, detail: { harnesses: harnesses.list().length } } : 'the harness catalog is empty'),
            },
            { name: 'valkey', required: false, check: async () => (valkey ? valkey.ready() : { skipped: 'VALKEY_URL not set: per-actor limits count in this process only' }) },
            {
                name: 'network_jwks', required: false,
                // Public: counts and times only. Never the internal JWKS URL and never the SDK's
                // lastError (it names both) — the SDK logs the real error server-side.
                check: () => {
                    const statuses = jwksStatus();
                    if (!statuses.length) return 'no JWKS clients (misconfigured)';
                    const first = statuses[0];
                    if (!first.ready) return 'Network signing key not loaded yet: sign-in is unavailable';
                    return { ok: true, detail: { keys: first.keys, failures: first.failures, stale: first.stale, fetched_at: first.fetchedAt } };
                },
            },
            {
                name: 'oauth_client', required: false,
                check: () => (config.oauth.clientSecret ? true : 'OV_OAUTH_CLIENT_SECRET unset: sign-in cannot complete'),
            },
        ],
    });
}

module.exports = { createCodesReadiness };
