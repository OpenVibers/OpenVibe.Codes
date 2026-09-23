'use strict';

/**
 * OpenVibe.Codes — process entry. `node server/index.js`
 * Listens on PORT (4900) behind nginx (deploy/). Starts the outbox relay when EVENTS_URL and the
 * client secret are set.
 */
const { createApp } = require('./app');

const { app, ctx } = createApp();
const { config } = ctx;

const server = app.listen(config.port, config.host, () => {
    console.log(`[Codes] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${config.dbPath})`);
    console.log(`[Codes] docs from openvibe-contracts v${ctx.docs.contractsVersion} and openvibe-sdk v${ctx.docs.sdkVersion}; events relay ${ctx.outbox.enabled ? `on → ${config.events.url}` : 'off (events wait in event_outbox)'}`);
});
server.keepAliveTimeout = 65_000;
ctx.outbox.start();
ctx.keys.ensure().catch(() => {});

function shutdown(signal) {
    console.log(`[Codes] ${signal}: closing`);
    server.close(async () => {
        try { await ctx.outbox.stop(); } catch { /* best effort */ }
        try { ctx.store.close(); } catch { /* already closed */ }
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
