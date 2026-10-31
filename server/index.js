'use strict';

/**
 * OpenVibe.Codes — process entry. `node server/index.js`
 * Listens on PORT (4900) behind nginx (deploy/).
 */
const { createApp } = require('./app');
const { gracefulStop, telemetry } = require('openvibe-sdk/service');
const { createPgTelemetrySink, startTelemetryRetention } = require('openvibe-sdk/telemetry');
const { startSubscriptions } = require('./events-consumer');

/**
 * The process stop (openvibe-sdk/service, docs/service.md's 5 s family): the HTTP drain runs
 * (defaults 4000/5000), then the background loops, the JWKS refresher and the store close; past the deadline the
 * process exits 0, as the hand-rolled 5 s timer did. Exported so a test can inject `exit` and `signals: false`.
 */
function createLifecycle({ server, ctx, exit, signals }) {
    return gracefulStop({
        name: 'Codes', server, deadlineExitCode: 0, exit, signals,
        close: [
            () => { if (ctx.subscriptions) ctx.subscriptions.stop(); },
            () => { if (ctx.publisher) return ctx.publisher.stop(); return undefined; },
            () => { if (ctx.sessionRetention) ctx.sessionRetention.stop(); },
            () => ctx.keys.client.stop(),
            async () => { if (ctx.telemetryRetention) await ctx.telemetryRetention.stop(); await telemetry.stop(); },
            () => ctx.store.close(),
        ],
    });
}

async function start() {
    const { app, ctx } = await createApp();
    const { config } = ctx;

    // Socket activation (2026-10-31): systemd's .socket unit holds the listener across restarts, so a deploy
    // queues requests in the kernel instead of answering 502. Without the socket unit, the usual listen.
    const socketActivated = process.env.LISTEN_FDS === '1' && Number(process.env.LISTEN_PID) === process.pid;
    const server = app.listen(...(socketActivated ? [{ fd: 3 }] : [config.port, config.host]), () => {
        console.log(`[Codes] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${ctx.store.db.store})`);
        console.log(`[Codes] ${ctx.harnesses.list().length} harnesses in the catalog; the developer console's addresses redirect to openvibe.services`);
    });
    server.keepAliveTimeout = 65_000;
    // Request telemetry (openvibe-sdk/service, plan T1): one aggregated sample per route template, method and status
    // class each minute, stored in this service's telemetry_samples table; rows older than 14 days go daily.
    telemetry.init({ service: 'codes', sink: createPgTelemetrySink({ db: ctx.store.db, log: console }), skipPrefixes: ['/shared'], intervalMs: 60_000 });
    ctx.telemetryRetention = startTelemetryRetention({ db: ctx.store.db, log: console, olderThanDays: 14 });
    // Keep the JWKS cache fresh in the background (openvibe-sdk/auth): one client per URL, the last
    // good keys through outages, exponential backoff, unknown-kid floods throttled, an unref'd timer.
    ctx.keys.client.start();
    // The run.job.* and account subscriptions at OpenVibe.Events, created when missing; off without EVENTS_URL,
    // CODES_EVENTS_SECRET or the client secret (and under CODES_DRILL).
    ctx.subscriptions = startSubscriptions({
        config, port: config.port, secret: config.events.secrets[0] || '',
    });
    // codes.task.* events: the outbox relay and the session-retention loop (both off under CODES_DRILL).
    ctx.publisher.start();
    ctx.sessionRetention.start();

    createLifecycle({ server, ctx });
    return { server, ctx };
}

if (require.main === module) {
    start().catch((err) => { console.error('[Codes] failed to start:', err); process.exit(1); });
}

module.exports = { start, createLifecycle };
