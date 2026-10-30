'use strict';

/**
 * OpenVibe.Codes — the open coding-agent harness. Express app factory; server/index.js listens, tests build their own
 * instance with a temp database and mock neighbours.
 *
 *   /, /harnesses, /improve, /policy/*, /updates   the public pages (http/pages.js)
 *   /api/v1/harnesses, /api/v1/harnesses/route     the agent catalog and its router (http/api.js)
 *   /auth/*           Network SSO with PKCE (auth/sso.js)
 *   /api/health, /api/ready, /release.json, /metrics (loopback only)
 *
 * The developer console moved to OpenVibe.Services on 2026-10-08: http/moved.js answers its addresses (/projects,
 * /docs, /oauth, /tools, /manifests, /releases, /apps, /staff, the platform policy pages and the rest of /api/v1)
 * with permanent redirects there, before anything else runs.
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const cache = require('openvibe-shared/cache-policy');

const configLib = require('./config');
const { openStore } = require('./db');
const { createKeyStore } = require('./auth/keys');
const { createSso } = require('./auth/sso');
const { createHarnesses } = require('./domain/harnesses');
const { createPageRoutes } = require('./http/pages');
const { createRunRoutes } = require('./http/run');
const { createTasksApi } = require('./http/tasks-api');
const { createConnectionsApi } = require('./http/connections-api');
const { createActionsApi } = require('./http/actions-api');
const { createConductorApi } = require('./http/conductor-api');
const { createRunClient } = require('./domain/run-client');
const { createRunTasks } = require('./domain/run-tasks');
const { createConnections } = require('./domain/connections');
const { createRunTokens } = require('./domain/run-tokens');
const { createAttempts } = require('./domain/attempts');
const { createBenchPublisher } = require('./domain/bench-publisher');
const { createSessionLines } = require('./domain/session-lines');
const { createConductor } = require('./domain/conductor');
const { createApprovals } = require('./domain/approvals');
const { createNotify } = require('./domain/notify');
const { createOutbox, createPublisher } = require('./events/outbox');
const { createEventsConsumer } = require('./events-consumer');
const { createApi } = require('./http/api');
const { createMeApi } = require('./http/me-api');
const { createMovedRoutes } = require('./http/moved');
const { createCodesReadiness } = require('./observability');
const { createActorLimits } = require('./http/actor-limits');
const { createForgejoClient } = require('./domain/forgejo');
const { createMachines } = require('./domain/machines');
const { createUserSettings } = require('./domain/user-settings');
const { createGitHub } = require('./domain/github');
const { createUsage } = require('./domain/usage');
const { assetVersion, send } = require('./render/layout');
const { html } = require('./render/html');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;

/**
 * opts: config, store, now (clock), fetchImpl, log, limitsNow (the per-actor limiter's clock,
 * tests), actorLimits (false: count nobody, tests only), valkey
 */
async function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl;
    // PostgreSQL (ADR-035): opened and migrated here unless the caller (a test, a script) hands in a store.
    const store = opts.store || await openStore(config, { now: opts.now, log });

    const keys = createKeyStore({ config, fetchImpl: fetchImpl || globalThis.fetch, log });
    const sso = createSso({ config, keys, fetchImpl: fetchImpl || globalThis.fetch, now: store.now, log });
    // The harness catalog (server/data/harness-offers.json), read once: a bad seed row fails boot.
    const harnesses = createHarnesses();
    // Sessions, the run.job.* consumer and the codes.task.* outbox share one store and one clock.
    const sessions = createSessionLines({ store, config, log });
    const outbox = createOutbox({ store, log });
    const run = opts.run || createRunClient({ config, fetchImpl: fetchImpl || globalThis.fetch });
    // A person's own connections (Codes C3): their provider keys live in OpenVibe.AI, and their harnesses run with a
    // short-lived run token that names them.
    const connections = createConnections({ config, fetchImpl: fetchImpl || globalThis.fetch, log });
    const runTokens = createRunTokens({ config, store, fetchImpl: fetchImpl || globalThis.fetch, log });
    // The task's attempts (stage C2): every Run job is one attempt, and the engine decides what happens next.
    const attempts = createAttempts({ store, config, log, harnesses });
    const benchPublisher = createBenchPublisher({ config, store, fetchImpl: fetchImpl || globalThis.fetch, log });
    const tasks = createRunTasks({ store, run, config, log, sessions, outbox, runTokens, connections, attempts, benchAttemptEnded: opts.benchAttemptEnded || benchPublisher.onTaskTerminal });
    const ctx = { config, store, keys, sso, harnesses, log, sessions, outbox, run, tasks, connections, runTokens, attempts, benchPublisher };
    ctx.forgejo = createForgejoClient({ config, log });
    // The C4b screens: the person's machines (from Network), their own choices, the GitHub reader and their usage.
    ctx.machines = createMachines({ config, fetchImpl: fetchImpl || globalThis.fetch, log });
    ctx.userSettings = createUserSettings({ store });
    ctx.github = createGitHub({ config, store, fetchImpl: fetchImpl || globalThis.fetch, log });
    ctx.usage = createUsage({ store });
    // The conductor (Codes C9b) and its approvals inbox. The conductor starts Run jobs and reads their events through
    // tasks, so the two are wired to each other here, not in a constructor (which would be a cycle).
    ctx.notify = opts.notify || createNotify({ config, fetchImpl: fetchImpl || globalThis.fetch, log });
    ctx.approvals = createApprovals({ store, config, log, notify: ctx.notify, userSettings: ctx.userSettings });
    ctx.conductor = createConductor({
        store, config, log, run, attempts, tasks, sessions, approvals: ctx.approvals, notify: ctx.notify,
        fetchImpl: fetchImpl || globalThis.fetch,
    });
    tasks.setConductor(ctx.conductor);

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'codes', root: path.join(__dirname, '..') });
    require('./render/layout').setRelease(release.release);
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'codes', release: release.release });
    app.use(require('openvibe-sdk/service').telemetryMiddleware);   // request telemetry: a no-op until server/index.js calls telemetry.init()
    app.locals.metrics = metrics.registry;
    app.locals.ctx = ctx;
    // Per-actor limits (http/actor-limits.js) at /api/v1, counted once the caller is known; the per-address
    // limits below stay.
    // Valkey (ADR-035): shared, never-authoritative state (per-actor limit counters). Optional.
    const valkey = opts.valkey !== undefined ? opts.valkey : (config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null);
    ctx.valkey = valkey;
    ctx.actorLimits = createActorLimits({ config, now: opts.limitsNow || (() => Date.now()), registry: metrics.registry, log, enabled: opts.actorLimits !== false, valkey });

    app.use(contracts.http.middleware());
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // The OpenVibe Frame (theme-loader, navbar, footer) comes from the Network; the inline init is ours.
                // Cloudflare Web Analytics: Cloudflare injects its beacon at the edge and the privacy text says it may
                // measure performance; script-src loads the beacon, connect-src is where it reports.
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://static.cloudflareinsights.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                imgSrc: ["'self'", 'data:', 'https://openvibe.network', 'https://openvibe.media'],
                // openvibe.events: release notifications (release-watch's EventSource, openvibe-shared 1.17).
                connectSrc: ["'self'", 'https://openvibe.network', 'https://cloudflareinsights.com', 'https://openvibe.events'],
                frameSrc: ["'self'", 'https://openvibe.network'],
                frameAncestors: ["'none'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'", 'https://openvibe.network'],
            },
        },
        frameguard: { action: 'deny' },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));
    app.use(cookieParser());

    // ── OpenVibe.Events → Codes (loopback only: nginx answers 404 for /internal/) ──
    // run.job.* finalizes the coding tasks people started here; network.account.export_requested and
    // network.account.deleted (ADR-033) go to openvibe-sdk/account-data. The consumer reads the raw body itself (the
    // v2 signature covers it) and refuses a request that came through a proxy.
    {
        const { createNetworkSender } = require('openvibe-sdk/account-data');
        const accountData = require('./account-data').create({ db: store.db, log });
        const accountSend = opts.accountSend || (config.oauth.clientSecret
            ? createNetworkSender({ networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl || globalThis.fetch })
            : null);
        const consumer = createEventsConsumer({ config, store, tasks, run, accountData, accountSend, log });
        ctx.accountData = accountData;
        ctx.eventsConsumer = consumer;
        ctx.publisher = createPublisher({ config, store, fetchImpl: fetchImpl || globalThis.fetch, log });
        ctx.sessionRetention = sessions.retention;
        app.use('/internal/events', consumer.router);
    }

    // ── Machine endpoints ───────────────────────────────────
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-codes', version: VERSION }));
    // GET /release.json (ADR-016) and POST /release-metrics: open tabs' update reports into /metrics.
    release.mount(app, { registry: metrics.registry });
    const readiness = createCodesReadiness({ store, harnesses, config, release: release.release, valkey: ctx.valkey, sso});
    app.get('/api/ready', readiness.handler);

    // ── The developer console's addresses: permanent redirects to OpenVibe.Services ──
    app.use(createMovedRoutes());

    // ── Who is asking (verified offline; refreshed when expired) ──
    app.use(sso.middleware());

    // ── Sign-in (OAuth2 + PKCE client of OpenVibe.Network) ──
    // The limit is on the sign-in routes only: the shared navbar asks /auth/me on every page view, so
    // counting it here would 429 (and render the visitor signed out) after 60 views in 15 minutes.
    app.use(['/auth/login', '/auth/callback', '/auth/logout'], rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', sso.routes());
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'codes', service: 'codes', host: 'openvibe.codes', name: 'OpenVibe.Codes', profile: 'ugc' })); }

    // ── Static assets (content-hashed ?v= → immutable) ──────
    // This site's own pinned copy of the OpenVibe Frame's browser files (openvibe-shared/serve).
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
        },
    }));

    // ── API ─────────────────────────────────────────────────
    // Run on your machine (plan T16): coding tasks on the person's own machine, through OpenVibe Run, from the /run
    // pages below or, for a first-party service acting for the person, from /api/v1/tasks (codes.task.*).
    app.use('/api/v1', createApi(ctx));
    app.use('/api/v1', createTasksApi({ config, store, keys, run, harnesses, tasks, actorLimits: ctx.actorLimits, log }));
    app.use('/api/v1', createMeApi({ config, store, sso, run, harnesses, tasks, github: ctx.github, actorLimits: ctx.actorLimits, log }));
    // A person's connections: their own provider keys (stored in OpenVibe.AI, never here) and their machines' plans.
    app.use('/api/v1', createConnectionsApi({ config, store, connections, actorLimits: ctx.actorLimits, log }));
    app.use('/api/v1', createActionsApi({ config, store, keys, run, tasks, actorLimits: ctx.actorLimits, log }));
    // The conductor's own routes (Codes C9b): its turns, sub-tasks, and the approvals inbox the MCP tools speak to.
    app.use('/api/v1', createConductorApi({
        config, store, keys, harnesses, tasks, conductor: ctx.conductor, approvals: ctx.approvals,
        machines: ctx.machines, actorLimits: ctx.actorLimits, log,
    }));
    app.use('/api', (req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));

    // ── Pages ───────────────────────────────────────────────
    app.use(rateLimit({ windowMs: 60_000, limit: Number(process.env.CODES_RATE_LIMIT_PER_MIN) || 300, standardHeaders: true, legacyHeaders: false }));   // per address; tests raise it
    const pageRoutes = createPageRoutes(ctx);
    // The agent layer (openvibe-shared/agent-layer): /.well-known/agent.json and the Markdown twins of the public
    // pages. The pages themselves keep their own routes — a signed-in visitor's account bar and forms are theirs
    // — so only the manifest and twin requests reach this mount; the pages advertise the twin themselves.
    const agentLayer = express();
    require('openvibe-shared/agent-layer').mount(agentLayer, {
        descriptor: require('./agent-descriptor'),
        render: require('./agent-pages').createAgentPages(ctx, pageRoutes.publicViews).renderPublicPage,
    });
    app.use((req, res, next) => {
        const twin = req.path.endsWith('.md') || req.query.format === 'markdown' || String(req.headers.accept || '').includes('text/markdown');
        if (req.path !== '/.well-known/agent.json' && !twin) return next();
        return agentLayer(req, res, next);
    });
    // C4 workspace pages sit before the legacy marketing pages and share the existing owner-scoped task store.
    app.use(require('./http/c4').createC4Routes(ctx));
    app.use(pageRoutes);
    app.use(createRunRoutes({ config, store, sso, harnesses, run, tasks, sessions, keys, fetchImpl: fetchImpl || globalThis.fetch, log }));
    app.use((req, res) => send(res, 404, { viewer: req.viewer, config, path: req.originalUrl, title: 'Not found', body: html`<h1>Not found</h1><p>No page here. Try <a href="/harnesses">the agents</a>, <a href="/improve">Improve OpenVibe</a>, or the developer platform at <a href="https://openvibe.services">openvibe.services</a>.</p>` }));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        // Never log request bodies: forms here carry secrets.
        log.error('[Codes]', err && err.message ? err.message.slice(0, 300) : err);
        if (res.headersSent) return;
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        if (err && err.type === 'entity.too.large') return res.status(413).type('text/plain').send('That form was too large.');
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp };
