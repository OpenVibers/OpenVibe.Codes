#!/usr/bin/env node
'use strict';
/**
 * The chat plays sandbox worker (sandbox/worker.js). Run by deploy/sandbox/openvibe-codes-sandbox.service as its own
 * unprivileged user; on a workstation: `node bin/openvibe-sandbox-worker.js` (a user systemd gives it its limits).
 *
 *   openvibe-sandbox-worker            run: self-test, the local API, the check-ins every 30 s
 *   openvibe-sandbox-worker --check    the self-test once, print the health and exit 0 (ready) or 1
 */
const { createWorker, loadConfig } = require('../sandbox/worker');

(async () => {
    const config = loadConfig(process.env);
    // The secrets are read; nothing the worker starts gets this environment, but drop them from it anyway.
    for (const k of ['CODES_SANDBOX_WORKER_SECRET', 'CODES_SANDBOX_CLIENT_SECRET']) delete process.env[k];
    const worker = createWorker({ config });
    if (process.argv.includes('--check')) {
        const { probeSupport } = require('../sandbox/session');
        const { detectLimits } = require('../sandbox/limits');
        const check = createWorker({ config, support: await probeSupport(), limiter: await detectLimits({ mode: config.limitsMode }) });
        require('fs').mkdirSync(config.runtimeDir, { recursive: true, mode: 0o750 });
        await check.selfTest();
        const h = check.health();
        process.stdout.write(`${JSON.stringify(h, null, 2)}\n`);
        process.exit(h.ready ? 0 : 1);
    }
    await worker.start();
    const stop = async (sig) => { console.log(`[sandbox] ${sig}: wiping every sandbox`); await worker.stop(); process.exit(0); };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));
})().catch((err) => { console.error('[sandbox] the worker failed:', err && err.message); process.exit(1); });
