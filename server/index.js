'use strict';

/**
 * OpenVibe.Codes — process entry. `node server/index.js`
 * Listens on PORT (4900) behind nginx (deploy/).
 */
const { createApp } = require('./app');
const { gracefulStop, telemetry } = require('openvibe-sdk/service');
const { createPgTelemetrySink, startTelemetryRetention } = require('openvibe-sdk/telemetry');
const { startSubscriptions } = require('openvibe-sdk/account-data');

/**
 * The process stop (openvibe-sdk/service, docs/service.md's 5 s family): the HTTP drain runs
 * (defaults 4000/5000), then the JWKS refresher stops and the store closes; past the deadline the process
 * exits 0, as the hand-rolled 5 s timer did. Exported so a test can inject `exit` and `signals: false`.
 */
function createLifecycle({ server, ctx, exit, signals }) {
    return gracefulStop({
        name: 'Codes', server, deadlineExitCode: 0, exit, signals,
        close: [() => ctx.keys.client.stop(), async () => { if (ctx.telemetryRetention) await ctx.telemetryRetention.stop(); await telemetry.stop(); }, () => ctx.store.close()],
    });
}

async function start() {
    const { app, ctx } = await createApp();
    const { config } = ctx;

    const server = app.listen(config.port, config.host, () => {
        console.log(`[Codes] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${ctx.store.db.store})`);
        console.log(`[Codes] ${ctx.harnesses.list().length} harnesses in the catalog; the developer console's addresses redirect to openvibe.services`);
    });
    server.keepAliveTimeout = 65_000;
    // Request telemetry (openvibe-sdk/service, plan T1): one aggregated sample per route template, method and status
    // class each 15 s, stored in this service's telemetry_samples table; rows older than 30 days go daily.
    telemetry.init({ service: 'codes', sink: createPgTelemetrySink({ db: ctx.store.db, log: console }), skipPrefixes: ['/shared'] });
    ctx.telemetryRetention = startTelemetryRetention({ db: ctx.store.db, log: console });
    // Keep the JWKS cache fresh in the background (openvibe-sdk/auth): one client per URL, the last
    // good keys through outages, exponential backoff, unknown-kid floods throttled, an unref'd timer.
    ctx.keys.client.start();
    // The two account subscriptions at OpenVibe.Events (ADR-033), created when missing; off without EVENTS_URL,
    // CODES_EVENTS_SECRET or the client secret.
    startSubscriptions({
        eventsUrl: config.events.url, endpoint: `http://127.0.0.1:${config.port}/internal/events`, secret: config.events.secrets[0],
        networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
    });

    createLifecycle({ server, ctx });
    return { server, ctx };
}

if (require.main === module) {
    start().catch((err) => { console.error('[Codes] failed to start:', err); process.exit(1); });
}

module.exports = { start, createLifecycle };
