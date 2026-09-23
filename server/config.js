'use strict';

/**
 * OpenVibe.Codes configuration. Every value comes from the environment (production:
 * /etc/openvibe/codes.env, see .env.example). Only environment variable NAMES appear in code and
 * docs; secrets are never logged.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */
require('dotenv').config();
const contracts = require('openvibe-contracts');

const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const originOf = (id, fallback) => {
    const m = contracts.services.get(id);
    return (m && m.publicOrigin) || fallback;
};

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4900);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.codes' : `http://localhost:${port}`));
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');

    return {
        service: 'codes',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,

        dbPath: env.CODES_DB_PATH || './data/codes.db',

        // OpenVibe.Network: SSO (OAuth2 authorization server with PKCE), JWKS, the developer
        // projects API (/api/v1/projects, called server-side with the signed-in person's token),
        // the registry, and client-credentials tokens (Codes' own and, in playgrounds, the app's).
        networkUrl,
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        networkIssuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'codes',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },
        // Signs the per-person form token (CSRF). Unset: a random per-process key.
        formSecret: env.CODES_FORM_SECRET || '',

        // Staff (trust tiers): Network admins, plus these subjects (usr_…).
        staffSubjects: list(env.CODES_STAFF_SUBJECTS),

        // Where playgrounds call, with the APP's own token (never Codes' credentials). Defaults are
        // the public origins published in openvibe-contracts' service manifests.
        playground: {
            eventsUrl: trim(env.CODES_PLAYGROUND_EVENTS_URL || originOf('events', 'https://events.openvibe.network')),
            mediaUrl: trim(env.CODES_PLAYGROUND_MEDIA_URL || originOf('media', 'https://openvibe.media')),
            maxUploadBytes: int(env.CODES_PLAYGROUND_MAX_UPLOAD_BYTES, 1024 * 1024),
            runsPerHour: int(env.CODES_PLAYGROUND_RUNS_PER_HOUR, 60),
        },

        // Registry answers are cached this long (Network's own health poll runs every 60 s).
        registryTtlMs: int(env.CODES_REGISTRY_TTL_MS, 30 * 1000),

        // OpenVibe.Events: the outbox relay runs only when EVENTS_URL and the client secret are set.
        events: {
            url: trim(env.EVENTS_URL || ''),
            intervalMs: int(env.EVENTS_RELAY_INTERVAL_MS, 2000),
        },
    };
}

module.exports = { load };
