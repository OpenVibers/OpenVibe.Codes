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
const { createSharing } = require('./sharing');
const { createSkills } = require('./domain/skills');
const { createSkillsApi } = require('./http/skills-api');
const { createSkillPageRoutes } = require('./http/skills-pages');
const { createRunRoutes } = require('./http/run');
const { createTasksApi } = require('./http/tasks-api');
const { createConnectionsApi } = require('./http/connections-api');
const { createActionsApi } = require('./http/actions-api');
const { createConductorApi } = require('./http/conductor-api');
const { createRunClient } = require('./domain/run-client');
const { createRunTasks } = require('./domain/run-tasks');
const { createConnections } = require('./domain/connections');
const { createAiCatalog } = require('./domain/ai-catalog');
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
const { createAgentView } = require('./http/agent-view');
const { createKnowledgeApi } = require('./http/knowledge-api');
const { createMovedRoutes } = require('./http/moved');
const { createCodesReadiness } = require('./observability');
const { createActorLimits } = require('./http/actor-limits');
const { createForgejoClient } = require('./domain/forgejo');
const createAiCatalogConfig = require('./ai-catalog-config').create;
const createOwnerInputs = require('./owner-inputs-config').create;
const { createOwnerInputTests } = require('./owner-inputs-tests');
const { createMachines } = require('./domain/machines');
const { createMemory } = require('./domain/memory');
const { createKnowledge } = require('./domain/knowledge');
const { createFleet } = require('./domain/fleet');
const { createNotices } = require('./domain/notices');
const { createUserSettings } = require('./domain/user-settings');
const { createPlacementOutcomes } = require('./domain/placement-outcomes');
const { createBenchPriors } = require('./domain/bench-priors');
const { createPlacementContext } = require('./domain/placement-context');
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
    // D11 owner settings (codes.ai): the catalog switch reads through the store, env pins winning.
    // The owner's outside accounts (codes.accounts, codes.publishing; the owner-setup design): sealed in Codes' store,
    // read at use time with the environment as the fallback. config.git's app and config.github's token become getters,
    // so a value entered in the admin panel takes effect without a restart.
    const ownerInputs = await createOwnerInputs({ db: store.db, env: opts.env || process.env, log });
    const envGit = { clientId: config.git.clientId, clientSecret: config.git.clientSecret };
    const envGithubToken = config.github ? config.github.token : '';
    const fromPanel = (key, fallback) => { const v = ownerInputs.accounts.get(key); return typeof v === 'string' && v ? v : (fallback || ''); };
    Object.defineProperty(config.git, 'clientId', { enumerable: true, configurable: true, get: () => fromPanel('forge.client_id', envGit.clientId) });
    Object.defineProperty(config.git, 'clientSecret', { enumerable: true, configurable: true, get: () => fromPanel('forge.client_secret', envGit.clientSecret) });
    config.github = config.github || {};
    Object.defineProperty(config.github, 'token', { enumerable: true, configurable: true, get: () => fromPanel('github.token', envGithubToken) });
    const findTest = createOwnerInputTests({ config, ownerInputs, fetchImpl: opts.fetchImpl || globalThis.fetch });
    const aiCatalogConfig = await createAiCatalogConfig({ db: store.db, keys, config, env: opts.env || process.env, log, also: ownerInputs.stores, test: findTest });
    Object.defineProperty(config.aiCatalog, 'enabled', { enumerable: true, configurable: true, get: () => aiCatalogConfig.get('catalog') });
    const sso = createSso({ config, keys, fetchImpl: fetchImpl || globalThis.fetch, now: store.now, log });
    // The harness catalog (server/data/harness-offers.json), read once: a bad seed row fails boot.
    const harnesses = createHarnesses();
    // Sessions, the run.job.* consumer and the codes.task.* outbox share one store and one clock.
    const sessions = createSessionLines({ store, config, log, media: require('./media').createMedia({ config, log }) });
    const outbox = createOutbox({ store, log });
    const run = opts.run || createRunClient({ config, fetchImpl: fetchImpl || globalThis.fetch });
    // A person's own connections (Codes C3): their provider keys live in OpenVibe.AI, and their harnesses run with a
    // short-lived run token that names them.
    const connections = opts.connections || createConnections({ config, fetchImpl: fetchImpl || globalThis.fetch, log });
    // OpenVibe.AI's real model catalog (AI Exchange P9), when CODES_AI_CATALOG is on: the pickers read it, and
    // nothing else depends on it.
    const aiCatalog = createAiCatalog({ config, fetchImpl: fetchImpl || globalThis.fetch, now: store.now });
    const runTokens = createRunTokens({ config, store, fetchImpl: fetchImpl || globalThis.fetch, log });
    // The task's attempts (stage C2): every Run job is one attempt, and the engine decides what happens next.
    const attempts = createAttempts({ store, config, log, harnesses });
    // The fleet (C9c): each machine's agents and limit windows, reported with its heartbeat and read from Bot.
    const fleet = createFleet({ config, store, fetchImpl: fetchImpl || globalThis.fetch, log, now: store.now, balance: opts.balance || null });
    // A person's choices (their notification switches) and the notices a task sends once (C9c).
    const userSettings = createUserSettings({ store });
    const notify = opts.notify || createNotify({ config, fetchImpl: fetchImpl || globalThis.fetch, log });
    const notices = createNotices({ store, config, notify, userSettings, log });
    const benchPublisher = createBenchPublisher({ config, store, fetchImpl: fetchImpl || globalThis.fetch, log });
    // Placement A1: the learned counts, Bench's priors (an hour), and the context place() gets for a task.
    const placementOutcomes = opts.placementOutcomes || createPlacementOutcomes({ store, now: store.now, log });
    const benchPriors = opts.benchPriors || createBenchPriors({ config, fetchImpl: fetchImpl || globalThis.fetch, now: store.now, log, ttlMs: config.bench.priorsTtlMs });
    const placementContext = createPlacementContext({ store, config, userSettings, outcomes: placementOutcomes, priors: benchPriors, harnesses, now: store.now });
    // Know K5: the lessons and facts a person's runs teach, private by default and shareable with a team.
    const knowledge = createKnowledge({ store, config, fetchImpl: fetchImpl || globalThis.fetch, log });
    // The one sharing system (design 2026-11-06): a run task is its owner's until the Share sheet says otherwise.
    const sharing = opts.sharing || createSharing({ db: store.db, config, fetchImpl: fetchImpl || globalThis.fetch, log });
    // The skills hub (Compute plan §5, E6): versioned skills, rules and MCP servers, shared through the same SDK.
    const skills = opts.skills || createSkills({ store, sharing, log });
    const tasks = createRunTasks({ store, run, config, log, sessions, outbox, runTokens, connections, attempts, fleet, notices, placementContext, harnesses, knowledge, sharing, benchAttemptEnded: opts.benchAttemptEnded || benchPublisher.onTaskTerminal });
    const ctx = { config, store, keys, aiCatalogConfig, sso, harnesses, log, sessions, outbox, run, tasks, connections, aiCatalog, runTokens, attempts, fleet, notices, notify, userSettings, benchPublisher, placementOutcomes, benchPriors, placementContext, knowledge, sharing, skills };
    ctx.forgejo = createForgejoClient({ config, log });
    // The C4b screens: the person's machines (from Network), their own choices, the GitHub reader and their usage.
    ctx.machines = createMachines({ config, fetchImpl: fetchImpl || globalThis.fetch, log });
    // The person's own memory store (OpenVibe Memory M2b): the notes live in OpenVibe.AI, sealed there, and only the
    // person's own token opens them. Codes forwards the token and renders the answer; it never holds a note.
    ctx.memory = createMemory({ config, fetchImpl: fetchImpl || globalThis.fetch, log });
    ctx.github = createGitHub({ config, store, fetchImpl: fetchImpl || globalThis.fetch, log });
    // OpenVibe Git through the person's own account (server/domain/forge.js): off until the forge trusts Codes as an app.
    ctx.forge = opts.forge || require('./domain/forge').createForge({ config, store, log });
    tasks.setForge?.(ctx.forge);
    ctx.usage = createUsage({ store });
    // The conductor (Codes C9b) and its approvals inbox. The conductor starts Run jobs and reads their events through
    // tasks, so the two are wired to each other here, not in a constructor (which would be a cycle).
    ctx.approvals = createApprovals({ store, config, log, notify: ctx.notify, userSettings: ctx.userSettings });
    ctx.conductor = createConductor({
        store, config, log, run, attempts, tasks, sessions, approvals: ctx.approvals, notify: ctx.notify,
        fetchImpl: fetchImpl || globalThis.fetch, fleet, userSettings,
    });
    tasks.setConductor(ctx.conductor);

    const app = express();
    aiCatalogConfig.mount(app);
    // GET /openapi.json (SEO-3): this service's public API as OpenAPI 3.1, generated from the contracts
    // (openvibe-contracts); the operations they mark internal-only are left out.
    app.get('/openapi.json', (_req, res) => {
        const doc = require('openvibe-contracts').openapi.document('codes');
        if (!doc) return res.status(404).type('text/plain').send('No API document.');
        const METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);
        const paths = {};
        for (const [p, item] of Object.entries(doc.paths || {})) {
            const kept = {};
            for (const [k, op] of Object.entries(item || {})) {
                if (!METHODS.has(k)) { kept[k] = op; continue; }
                const vis = [].concat((op && op['x-openvibe-visibility']) || []);
                if (vis.length && vis.every((v) => v === 'internal')) continue;
                kept[k] = op;
            }
            if (Object.keys(kept).some((k) => METHODS.has(k))) paths[p] = kept;
        }
        res.set('Cache-Control', 'public, max-age=3600').set('Access-Control-Allow-Origin', '*').json({ ...doc, paths });
    });
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
    // ── Chat plays sandbox workers → Codes (Agent Streams S6; loopback only, signed heartbeats) ──
    app.use('/internal/sandbox-workers', require('./http/sandbox-workers').createSandboxWorkerRoutes({ store, config, log }));

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
    // ── /api/v1/task/:id/share — the one Share sheet's API (openvibe-sdk/share) ──
    // GET/PUT .../share, .../share/requests, .../share/transfer[/accept|decline|cancel], GET /api/v1/share/people
    // and /api/v1/shared-with-me. Access is still decided by canView on every read path; the router answers only
    // its own paths.
    // Memory M5: a memory store's share row lives in OpenVibe.AI, so its sheet is proxied there before the local
    // share router sees the path. AI authenticates the same person token and decides; Codes only forwards.
    app.use(require('./http/memory-share').createMemoryShareProxy({ config, sso: ctx.sso, fetchImpl: fetchImpl || globalThis.fetch, log }));
    {
        const shareApi = express.Router();
        shareApi.use(sharing.shares.router({
            service: 'codes',
            authenticate: (req) => sharing.shareViewer(req.viewer),
            describe: sharing.describe,
        }));
        const SHARE_PATH = /^\/api\/v1\/(?:shared-with-me$|share\/people$|[^/]+\/[^/]+\/share(?:\/|$))/;
        app.use((req, res, next) => (SHARE_PATH.test(req.path) ? shareApi(req, res, next) : next()));
    }
    // Expire members and transfers and send queued share events/notifications. Unref'd: it never holds a test open.
    if (opts.startSharingWorker !== false) {
        const timer = setInterval(() => { sharing.work().catch(() => { /* logged inside */ }); }, 15_000);
        if (timer.unref) timer.unref();
        app.locals.sharingTimer = timer;
    }
    app.use('/api/v1', createApi(ctx));
    app.use('/api/v1', createSkillsApi({ config, skills: ctx.skills, actorLimits: ctx.actorLimits, log }));
    app.use('/api/v1', createTasksApi({ config, store, keys, run, harnesses, tasks, fleet: ctx.fleet, actorLimits: ctx.actorLimits, sharing, log }));
    app.use('/api/v1', createMeApi({ config, store, sso, run, harnesses, tasks, github: ctx.github, actorLimits: ctx.actorLimits, log }));
    // The Dock's agent view (Dock K-D3, Agent Streams S1): the person's own desk stream with a view ticket minted here.
    app.use('/api/v1', createAgentView({ config, sso, actorLimits: ctx.actorLimits, log }));
    // Know K5: the person's own agents read and add workspace knowledge with their token (the ov-know MCP server).
    app.use('/api/v1', createKnowledgeApi({ config, store, knowledge: ctx.knowledge, actorLimits: ctx.actorLimits, log }));
    // A person's connections: their own provider keys (stored in OpenVibe.AI, never here) and their machines' plans.
    app.use('/api/v1', createConnectionsApi({ config, store, connections, actorLimits: ctx.actorLimits, log }));
    app.use('/api/v1', createActionsApi({ config, store, keys, run, tasks, actorLimits: ctx.actorLimits, log }));
    // The conductor's own routes (Codes C9b): its turns, sub-tasks, and the approvals inbox the MCP tools speak to.
    app.use('/api/v1', createConductorApi({
        config, store, keys, harnesses, tasks, conductor: ctx.conductor, approvals: ctx.approvals,
        machines: ctx.machines, fleet: ctx.fleet, actorLimits: ctx.actorLimits, log,
    }));
    app.use('/api', (req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));

    // ── Pages ───────────────────────────────────────────────
    app.use(rateLimit({ windowMs: 60_000, limit: Number(process.env.CODES_RATE_LIMIT_PER_MIN) || 300, standardHeaders: true, legacyHeaders: false }));   // per address; tests raise it
    app.use(createSkillPageRoutes({ config, skills: ctx.skills }));
    const pageRoutes = createPageRoutes(ctx);
    // The agent layer (openvibe-shared/agent-layer): /.well-known/agent.json and the Markdown twins of the public
    // pages. The pages themselves keep their own routes — a signed-in visitor's account bar and forms are theirs
    // — so only the manifest and twin requests reach this mount; the pages advertise the twin themselves.
    let c4Routes = null;   // created below, after the chat app's routes (the twin of / reads its front door)
    const agentLayer = express();
    require('openvibe-shared/agent-layer').mount(agentLayer, {
        descriptor: require('./agent-descriptor'),
        render: require('./agent-pages').createAgentPages(ctx, pageRoutes.publicViews, { home: () => c4Routes && c4Routes.visitorHome() }).renderPublicPage,
    });
    app.use((req, res, next) => {
        const twin = req.path.endsWith('.md') || req.query.format === 'markdown' || String(req.headers.accept || '').includes('text/markdown');
        if (req.path !== '/.well-known/agent.json' && !twin) return next();
        return agentLayer(req, res, next);
    });
    // The chat app (L31 CH1) answers a signed-in person's / and /tasks/:id; everyone else falls through to C4.
    app.use(require('./http/chat').createChatRoutes(ctx));
    app.use(require('./http/git').createGitRoutes(ctx));   // after the chat app: it renders in ctx.chatShell
    // C4 workspace pages sit before the legacy marketing pages and share the existing owner-scoped task store.
    c4Routes = require('./http/c4').createC4Routes(ctx);
    app.use(c4Routes);
    app.use(pageRoutes);
    app.use(createRunRoutes({ config, store, sso, harnesses, run, tasks, sessions, keys, sharing, fetchImpl: fetchImpl || globalThis.fetch, log }));
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
