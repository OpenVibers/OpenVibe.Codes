'use strict';

/**
 * OpenVibe.Codes — process entry. `node server/index.js`
 * Listens on PORT (4900) behind nginx (deploy/).
 */
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');

/**
 * The process stop (openvibe-sdk/service, docs/service.md's 5 s family): the HTTP drain runs
 * (defaults 4000/5000), then the JWKS refresher stops and the store closes; past the deadline the process
 * exits 0, as the hand-rolled 5 s timer did. Exported so a test can inject `exit` and `signals: false`.
 */
function createLifecycle({ server, ctx, exit, signals }) {
    return gracefulStop({
        name: 'Codes', server, deadlineExitCode: 0, exit, signals,
        close: [() => ctx.keys.client.stop(), () => ctx.store.close()],
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
    // Keep the JWKS cache fresh in the background (openvibe-sdk/auth): one client per URL, the last
    // good keys through outages, exponential backoff, unknown-kid floods throttled, an unref'd timer.
    ctx.keys.client.start();

    createLifecycle({ server, ctx });
    return { server, ctx };
}

if (require.main === module) {
    start().catch((err) => { console.error('[Codes] failed to start:', err); process.exit(1); });
}

module.exports = { start, createLifecycle };
