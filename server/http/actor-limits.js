'use strict';

/**
 * Per-actor rate limits at Codes' capability boundaries (roadmap WS-R task 4; openvibe-sdk/limits):
 * /api/v1, the signed-in portal (/projects), release actions, the developer tools' forms and the
 * staff trust form.
 *
 * The per-address limits in app.js and the routers (pages 300 a minute, portal writes 60, the tools and
 * API writes 30 and 60, sign-in) and the playground's runs an hour per person stay. These count
 * requests by who makes them:
 *
 *   an app                 its principal, app:app_… (the token requireCapability verified on /api/v1)
 *   a person               user:usr_… (the signed-in session sso.middleware verified)
 *   anyone else            ip:<address>
 *
 * Codes hosts no git remotes: there are no clone or push routes to leave out. Past a limit the route
 * answers 429 problem+json `rate_limited` with Retry-After before it does any work (before the form or
 * upload is read, before Network is asked); the refusal is logged once and counted in
 * codes_rate_limited_total{limit,window}. Reads take CODES_LIMITS_MINUTE / CODES_LIMITS_HOUR (120 and
 * 3000); every write has its own number below. Counters live in this process: a restart forgets them.
 *
 * Never limited: /api/health, /api/ready, /release.json, /metrics, sign-in, and the public pages and
 * docs (the per-address limit bounds them).
 */
const { createActorLimiter, createValkeyLimitStore } = require('openvibe-sdk/limits');

function actor(req) {
    const p = req.principal;
    if (p && !p.legacy && typeof p.sub === 'string' && p.sub) return p.sub;
    const v = req.viewer;
    if (v && v.kind === 'user' && v.subject) return `user:${v.subject}`;
    return `ip:${req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'}`;
}

/** The writes and the expensive reads, each with its numbers per caller (a minute, an hour). */
const BUDGETS = {
    // A project is a Network record with its own members and environments: people start a few.
    'codes.project.create': { minute: 5, hour: 30 },
    // Members, roles, archive and delete: an owner changes a few at a time.
    'codes.project.manage': { minute: 20, hour: 200 },
    // The full archive reads every object and event a project holds (one at a time per project).
    'codes.project.export': { minute: 3, hour: 20 },
    // An app is a Network client with credentials: a developer registers a few.
    'codes.app.create': { minute: 10, hour: 60 },
    // Redirect URIs, grants and revoking an app: a developer saves a form now and then.
    'codes.app.manage': { minute: 30, hour: 300 },
    // Rotating or revoking a credential mints or kills a secret: a few at a time.
    'codes.app.credential': { minute: 10, hour: 60 },
    // A playground run calls Events or Media with the app's own credential: above the runs an hour
    // per person (CODES_PLAYGROUND_RUNS_PER_HOUR, 60), which keeps deciding; refusals count.
    'codes.playground.run': { minute: 10, hour: 120 },
    // A release draft (a validated manifest; the editor's "validate only" counts too, so a developer
    // fixing a manifest has room): 20 a minute, 200 an hour.
    'codes.release.create': { minute: 20, hour: 200 },
    // Publishing, deprecating and revoking a release announce it to the network.
    'codes.release.manage': { minute: 20, hour: 200 },
    // Validating a manifest or checking a webhook signature: a developer's pace, not a crawler's.
    'codes.manifest.validate': { minute: 30, hour: 600 },
    'codes.webhook.tool': { minute: 30, hour: 600 },
    // Routing a coding task over the harness catalog (no I/O, but a POST: the reads' defaults skip it).
    'codes.harness.route': { minute: 30, hour: 600 },
    // Staff setting an app's trust tier.
    'codes.trust.set': { minute: 30, hour: 300 },
};

/**
 * limits(name, own) middleware for one app, plus limits.reads(name) (the defaults on GET/HEAD) and
 * limits.budget(name) (one of BUDGETS). enabled=false (tests only, as they raise the per-address
 * limit) counts nobody.
 */
function createActorLimits({ config, now = () => Date.now(), registry = null, log = console, enabled = true, valkey = null }) {
    const refused = registry
        ? registry.counter({ name: 'codes_rate_limited_total', help: 'Requests refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;
    const limiter = createActorLimiter({
        limits: { minute: config.limits.minute, hour: config.limits.hour },
        actor: enabled ? actor : () => null,
        now,
        // Shared across processes on Valkey (ADR-035) when VALKEY_URL is set; in-process otherwise.
        ...(valkey ? { store: createValkeyLimitStore(valkey) } : {}),
        onLimited(e) {
            // The actor is an app principal, a subject id or an address, never a token.
            log.warn(`[Limits] ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
    limiter.reads = (name) => {
        const limit = limiter(name);
        return (req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? limit(req, res, next) : next());
    };
    const budgets = new Map(Object.entries(BUDGETS).map(([name, own]) => [name, limiter(name, own)]));
    limiter.budget = (name) => {
        const m = budgets.get(name);
        if (!m) throw new Error(`limits: no budget named ${name}`);
        return m;
    };
    return limiter;
}

module.exports = { createActorLimits, actor, BUDGETS };
