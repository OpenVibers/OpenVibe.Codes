'use strict';
/**
 * Truthful readiness for GET /api/ready (openvibe-shared/ready, Track O).
 *
 *   db              required  a real query on Codes' SQLite: every Codes table answers
 *   docs            required  the reference was generated at boot from the pinned packages
 *   network_jwks    optional  the Network signing key is loaded; without it nobody can sign in and
 *                             app tokens cannot be verified (docs and tools still serve)
 *   network         optional  the Network answers (its /.well-known/openvibe descriptor); without
 *                             it the portal shows Network's failure on every project page
 *   oauth_client    optional  OV_OAUTH_CLIENT_SECRET is set (sign-in and the events relay need it)
 *   events_relay    optional  the outbox relay is configured and has no rejected rows
 */
const { createReadiness } = require('openvibe-shared/ready');
const { TABLES } = require('./db');

function createCodesReadiness({ store, keys, network, outbox, docs, config, release = null }) {
    const { db } = store;
    return createReadiness({
        service: 'codes',
        release,
        checks: [
            {
                name: 'db', required: true,
                check: () => {
                    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
                    const missing = TABLES.filter((t) => !names.has(t));
                    return missing.length ? `missing ${missing.join(', ')}` : true;
                },
            },
            {
                name: 'docs', required: true,
                check: () => (docs && docs.contracts.length && docs.capabilities.length
                    ? { ok: true, detail: { contracts: docs.contractsVersion, sdk: docs.sdkVersion } }
                    : 'reference docs were not generated'),
            },
            {
                name: 'network_jwks', required: false,
                check: () => {
                    if (keys.loaded()) return true;
                    keys.ensure().catch(() => {});
                    return 'Network signing key not loaded yet: sign-in and token checks are unavailable';
                },
            },
            {
                name: 'network', required: false, cacheMs: 30_000,
                check: async () => {
                    try { await network.registry.descriptor(); return true; } catch (err) { return `OpenVibe.Network did not answer: ${network.problemOf(err).code}`; }
                },
            },
            {
                name: 'oauth_client', required: false,
                check: () => (config.oauth.clientSecret ? true : 'OV_OAUTH_CLIENT_SECRET unset: sign-in cannot complete'),
            },
            {
                name: 'events_relay', required: false,
                check: () => {
                    const s = outbox.status();
                    if (!s.enabled) return `relay off (EVENTS_URL or OV_OAUTH_CLIENT_SECRET unset); ${s.pending} events waiting`;
                    if (s.rejected) return `${s.rejected} events rejected by OpenVibe.Events`;
                    return { ok: true, detail: { pending: s.pending } };
                },
            },
        ],
    });
}

module.exports = { createCodesReadiness };
