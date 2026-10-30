'use strict';

/**
 * OpenVibe.Codes configuration. Every value comes from the environment (production:
 * /etc/openvibe/codes.env, see .env.example). Only environment variable NAMES appear in code and
 * docs; secrets are never logged.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */
require('dotenv').config();
const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);

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
        // Keep every background loop off in a drill (CODES_DRILL=1), the network's convention.
        drill: env.CODES_DRILL === '1' || env.CODES_DRILL === 'true',
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,
        // Per-actor limits (server/http/actor-limits.js, roadmap WS-R task 4): the reads one caller (an
        // app, a person, else an address) may make per minute and per hour. Writes set tighter numbers there.
        limits: {
            minute: Math.max(1, int(env.CODES_LIMITS_MINUTE, 120)),
            hour: Math.max(1, int(env.CODES_LIMITS_HOUR, 3000)),
        },

        // PostgreSQL (ADR-035): DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner role).
        // In development without DATABASE_URL an embedded PGlite database in data/pglite is used
        // (CODES_PGLITE_DIR overrides the directory — how a test gets an isolated database of its own).
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '', pgliteDir: env.CODES_PGLITE_DIR || '' },
        valkey: { url: env.VALKEY_URL || '', prefix: env.VALKEY_PREFIX || 'ov:codes:' },

        // OpenVibe.Network: SSO (OAuth2 authorization server with PKCE) and its JWKS.
        networkUrl,
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        networkIssuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
        // OpenVibe Git (Forgejo, deploy/forgejo): its loopback address for the home page's repository list (public
        // repositories only, no token), and the public address people use.
        git: {
            internalUrl: trim(env.CODES_GIT_INTERNAL_URL || 'http://127.0.0.1:5060'),
            publicUrl: trim(env.CODES_GIT_URL || 'https://git.openvibe.codes'),
        },
        // The audience of the Network service tokens a first-party service calls /api/v1/tasks with (codes.task.*).
        serviceAudience: env.CODES_AUDIENCE || 'openvibe.codes',
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'codes',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile',
            // Network session tokens (what /oauth/token hands Codes) carry this audience; FedCM
            // assertions, app and service tokens signed with the same key do not.
            sessionAudience: env.OV_SESSION_AUDIENCE || 'openvibe.network',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },
        // OpenVibe.AI (Codes C3): where a person's own provider key is sealed (it never leaves AI) and where the
        // harnesses run. Codes talks to it with its own Network token (audience openvibe.ai).
        ai: {
            // The public address: what a harness on the person's own machine is given.
            url: trim(env.CODES_AI_URL || 'https://ai.openvibe.services'),
            // Codes' own address for AI: the vault (a person's keys) is a host-local API, so Codes reaches it over
            // the loopback. The public address answers 403 there (nginx: /api/ is host-local only).
            internalUrl: trim(env.CODES_AI_INTERNAL_URL || 'http://127.0.0.1:4700'),
            audience: 'openvibe.ai',
            // The scopes Codes asks Network for: it stores a person's key with the first and runs a test request
            // (and the harnesses' requests) with the second.
            scope: 'ai.credential.manage ai.run.create',
        },
        // A run token (Codes C3): the short-lived Network token an attempt's harness carries, so that AI knows whose
        // key and whose budget the run is. Two hours is the longest a coding attempt may run.
        runTokens: {
            ttlSeconds: Math.min(7200, Math.max(60, int(env.CODES_RUN_TOKEN_TTL_S, 7200))),
            // The harness env variable names a job may set (harness/job.js): the model APIs' own names, nothing else.
            envNames: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'OPENAI_BASE_URL',
                'OPENAI_API_KEY', 'OPENAI_CUSTOM_HEADERS', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_API_KEY', 'OPENVIBE_AI_URL',
                'OPENVIBE_AI_TOKEN', 'OPENVIBE_CODES_BASE_URL', 'OPENVIBE_CODES_API_KEY', 'OPENVIBE_CODES_MODEL',
                'OPENVIBE_CODES_HEADERS'],
        },
        // OpenVibe.Events (ADR-033): account export and deletion arrive at POST /internal/events, signed with one of
        // these; run.job.* subscriptions are created at boot. The outbox relay publishes codes.task.* with the
        // service's events.event.publish token.
        events: {
            url: trim(env.CODES_EVENTS_URL || env.EVENTS_URL || ''),
            endpoint: env.CODES_EVENTS_ENDPOINT || '',
            secrets: String(env.CODES_EVENTS_SECRET || '').split(',').map((s) => s.trim()).filter(Boolean),
            intervalMs: Math.max(500, int(env.CODES_EVENTS_INTERVAL_MS, 5000)),
            scope: env.CODES_EVENTS_SCOPE || 'events.event.publish',
        },
        // Session lines in PostgreSQL: no total cap; finished tasks keep theirs for this many days (default 90).
        sessions: {
            retentionDays: Math.max(1, int(env.CODES_SESSION_RETENTION_DAYS, 90)),
            retentionIntervalMs: Math.max(60_000, int(env.CODES_SESSION_RETENTION_INTERVAL_MS, 86_400_000)),
        },
        // OpenVibe.Run (plan T16): a coding task on the person's own machine is a Run job Codes starts for them.
        run: { url: trim(env.CODES_RUN_URL || 'http://127.0.0.1:4920') },

    };
}

module.exports = { load };
