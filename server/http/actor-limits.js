'use strict';

/**
 * Per-actor rate limits at Codes' boundaries (roadmap WS-R task 4; openvibe-sdk/limits): /api/v1 (the coding-agent
 * catalog and its router).
 *
 * The per-address limits in app.js and the routers (pages 300 a minute, the router 60, sign-in) stay. These count
 * requests by who makes them:
 *
 *   a person               user:usr_… (the signed-in session sso.middleware verified)
 *   anyone else            ip:<address>
 *
 * Codes hosts no git remotes: there are no clone or push routes to leave out. Past a limit the route answers 429
 * problem+json `rate_limited` with Retry-After before it does any work (before the body is read); the refusal is
 * logged once and counted in codes_rate_limited_total{limit,window}. Reads take CODES_LIMITS_MINUTE /
 * CODES_LIMITS_HOUR (120 and 3000); the router has its own number below. Counters live in this process unless
 * VALKEY_URL is set.
 *
 * Never limited: /api/health, /api/ready, /release.json, /metrics, sign-in, and the public pages (the per-address
 * limit bounds them).
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
    // Routing a coding task over the harness catalog (no I/O, but a POST: the reads' defaults skip it).
    'codes.harness.route': { minute: 30, hour: 600 },
    // A service starting (or cancelling) a coding task for a person counts against that person (tasks-api.js).
    'codes.task.start': { minute: 6, hour: 60 },
    // A file attached to a message (10 at most per message): a handful a minute, not a flood of 20 MB bodies.
    'codes.attachment.upload': { minute: 60, hour: 1000 },
    // The Home picker's repository search asks GitHub, which allows an address few searches a minute. The person's
    // own repositories come first and cost nothing; this bounds what they may spend on the rest.
    'codes.repo.search': { minute: 6, hour: 60 },
    // An agent adds what it learned through the ov-know MCP; a run may add a handful, not a flood.
    'codes.knowledge.write': { minute: 30, hour: 600 },
    // The Dock's agent view controls (K-D3): Curtain now and End. The owner presses them now and then, never in a burst.
    'codes.agent_view.control': { minute: 20, hour: 120 },
    // The skills hub (Compute plan §5): save a version or share a record now and then; a script editing a library
    // may do a few a minute, not a flood.
    'codes.skill.write': { minute: 20, hour: 300 },
    // Adding a skill to the sync is how the Link is set up; the first run adds several, then almost never.
    'codes.skill.assign': { minute: 30, hour: 600 },
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
