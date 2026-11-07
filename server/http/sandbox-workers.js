'use strict';
/**
 * The chat plays sandbox workers' internal routes (Agent Streams S6), under /internal/sandbox-workers. Loopback only:
 * nginx answers 404 for /internal/, and a request that came through a proxy is refused here too.
 *
 *   POST /heartbeat   a worker checks in (sandbox/worker.js, every 30 s). The body is signed with the worker secret
 *                     (CODES_SANDBOX_WORKER_SECRET; X-OV-Sandbox-Signature, sandbox/signature.js): unsigned, wrongly
 *                     signed, stale or replayed heartbeats are refused, and without a configured secret there is none.
 *   GET  /health      is there a healthy worker? { ready, workers: [{ id, healthy, failing, … }] } — no secret, path
 *                     or address in it. Live's chat plays gate and Codes' runner read it.
 */
const express = require('express');
const signature = require('../../sandbox/signature');
const { createSandboxWorkers } = require('../domain/sandbox-workers');

function createSandboxWorkerRoutes({ store, config, log = console }) {
    const workers = createSandboxWorkers({ store, config });
    const r = express.Router();
    const secrets = (config.sandbox && config.sandbox.workerSecrets) || [];
    const fail = (res, status, code, detail) => res.status(status).set('Cache-Control', 'no-store').json({ error: code, detail });

    r.use((req, res, next) => {
        if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']) return fail(res, 403, 'codes.internal_only', 'internal route');
        return next();
    });

    r.post('/heartbeat', express.raw({ type: () => true, limit: '64kb' }), async (req, res) => {
        if (!secrets.length) return fail(res, 503, 'sandbox.not_configured', 'no worker secret is configured (CODES_SANDBOX_WORKER_SECRET)');
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const v = signature.verify({ secrets, header: req.get(signature.HEADER), body, now: store.now() });
        if (!v.ok) return fail(res, 401, v.code, 'the heartbeat is not signed with the worker secret');
        let report;
        try { report = JSON.parse(body.toString('utf8')); } catch { return fail(res, 400, 'sandbox.bad_report', 'not JSON'); }
        try {
            const out = await workers.heartbeat(report, v.t);
            if (!out.ok) return fail(res, out.code === 'signature.replayed' ? 409 : 400, out.code, 'heartbeat refused');
            return res.set('Cache-Control', 'no-store').json({ ok: true, worker: out.worker });
        } catch (err) {
            log.error('[Codes] sandbox heartbeat:', err.message);
            return fail(res, 500, 'internal.error', 'the heartbeat was not stored');
        }
    });

    r.get('/health', async (_req, res) => {
        try {
            res.set('Cache-Control', 'no-store').json(await workers.health());
        } catch (err) {
            log.error('[Codes] sandbox health:', err.message);
            fail(res, 500, 'internal.error', 'health unavailable');
        }
    });

    return r;
}

module.exports = { createSandboxWorkerRoutes };
