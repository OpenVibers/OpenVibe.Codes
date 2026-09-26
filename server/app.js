'use strict';

/**
 * OpenVibe.Codes — Express app factory. server/index.js listens and starts the outbox relay; tests
 * build their own instance with a temp database, an injectable clock and mock neighbours.
 *
 *   /                 landing, policy, public release pages, staff trust (http/pages.js)
 *   /docs             generated reference (http/docs.js)
 *   /oauth, /tools/webhooks, /manifests/validate   developer tools (http/tools.js)
 *   /projects         the signed-in portal over Network's projects API (http/portal.js)
 *   /releases/:id/*   release actions (http/portal.js)
 *   /api/v1           JSON API (http/api.js)
 *   /auth/*           Network SSO with PKCE (auth/sso.js)
 *   /api/health, /api/ready, /release.json, /metrics (loopback only)
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');

const configLib = require('./config');
const { openStore } = require('./db');
const { createKeyStore } = require('./auth/keys');
const { createSso } = require('./auth/sso');
const { createNetworkClient } = require('./clients/network');
const { createCodesOutbox } = require('./events/outbox');
const { generate } = require('./docs/generate');
const { createTrust } = require('./domain/trust');
const { createReleases } = require('./domain/releases');
const { createPlayground } = require('./domain/playground');
const { createArchiver } = require('./domain/project-archive');
const { createDocsRoutes } = require('./http/docs');
const { createToolRoutes } = require('./http/tools');
const { createPageRoutes } = require('./http/pages');
const { createPortalRoutes, createReleaseActionRoutes } = require('./http/portal');
const { createApi } = require('./http/api');
const { createCodesReadiness } = require('./observability');
const { assetVersion, send } = require('./render/layout');
const { html } = require('./render/html');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;

/** opts: config, store | dbPath, now (clock), fetchImpl, log */
function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl;
    const store = opts.store || openStore(opts.dbPath || config.dbPath, { now: opts.now });

    const docs = generate({ now: store.now });
    const keys = createKeyStore({ config, fetchImpl: fetchImpl || globalThis.fetch, log });
    const sso = createSso({ config, keys, fetchImpl: fetchImpl || globalThis.fetch, now: store.now, log });
    const network = createNetworkClient({ config, fetchImpl, log });
    const outbox = createCodesOutbox({ db: store.db, config, fetchImpl, now: store.now, log });
    const trust = createTrust({ store, outbox });
    const releases = createReleases({ store, outbox, trust });
    const playground = createPlayground({ store, config, network, keys, fetchImpl, log });
    const archiver = createArchiver({ config, fetchImpl, log });

    const ctx = { config, store, docs, keys, sso, network, outbox, trust, releases, playground, archiver, log };

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'codes', root: path.join(__dirname, '..') });
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'codes', release: release.release });
    app.locals.metrics = metrics.registry;
    app.locals.ctx = ctx;

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
                // events.openvibe.network: release notifications (release-watch's EventSource, openvibe-shared 1.17).
                connectSrc: ["'self'", 'https://openvibe.network', 'https://cloudflareinsights.com', 'https://events.openvibe.network'],
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

    // ── Machine endpoints ───────────────────────────────────
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-codes', version: VERSION }));
    // GET /release.json (ADR-016) and POST /release-metrics: open tabs' update reports into /metrics.
    release.mount(app, { registry: metrics.registry });
    const readiness = createCodesReadiness({ store, keys, network, outbox, docs, config, release: release.release });
    app.get('/api/ready', readiness.handler);

    // ── Who is asking (verified offline; refreshed when expired) ──
    app.use(sso.middleware());

    // ── Sign-in (OAuth2 + PKCE client of OpenVibe.Network) ──
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));
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
            res.setHeader('Cache-Control', v && v === assetVersion(rel) ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
        },
    }));

    // ── API ─────────────────────────────────────────────────
    app.use('/api/v1', createApi(ctx));
    app.use('/api', (req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));

    // ── Pages ───────────────────────────────────────────────
    app.use(rateLimit({ windowMs: 60_000, limit: Number(process.env.CODES_RATE_LIMIT_PER_MIN) || 300, standardHeaders: true, legacyHeaders: false }));   // per address; tests raise it
    app.use('/docs', createDocsRoutes(ctx));
    app.use('/projects', rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, skip: (req) => req.method === 'GET' }), createPortalRoutes(ctx));
    app.use('/releases', createReleaseActionRoutes(ctx));
    app.use(createToolRoutes(ctx));
    app.use(createPageRoutes(ctx));
    app.use((req, res) => send(res, 404, { viewer: req.viewer, config, path: req.originalUrl, title: 'Not found', body: html`<h1>Not found</h1><p>No page here. Try the <a href="/docs">docs</a>.</p>` }));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        // Never log request bodies: forms here carry secrets.
        log.error('[Codes]', err && err.message ? err.message.slice(0, 300) : err);
        if (res.headersSent) return;
        res.set('Cache-Control', 'private, no-store');
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        if (err && err.type === 'entity.too.large') return res.status(413).type('text/plain').send('That form was too large.');
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp };
