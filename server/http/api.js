'use strict';

/**
 * JSON API (/api/v1): the coding-agent catalog and its router. Errors are RFC 9457 problems (openvibe-contracts
 * http.sendProblem). Both routes are public: the catalog is published data and routing runs no I/O.
 *
 *   GET  /harnesses          the harness catalog, each harness with its agents (platform.harness-offer@1 rows)
 *   POST /harnesses/route    { task, requirements? } → { selected, reasons, candidates } (openvibe-sdk/placement)
 *
 * The developer platform's API (releases, manifest validation, the docs' versions, the resource index) moved to
 * OpenVibe.Services on 2026-10-08; server/http/moved.js answers those paths with permanent redirects there.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const placement = require('../domain/harness-placement');

function createApi(ctx) {
    const { actorLimits, harnesses } = ctx;
    const r = asyncRouter();
    // Per-actor limits (http/actor-limits.js): reads take the defaults; the route names its budget before the body is read.
    const reads = actorLimits.reads('codes.read');
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    const json = express.json({ limit: '32kb' });
    const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
    const problem = (req, res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });

    r.get('/harnesses', reads, (req, res) => {
        res.json({ harnesses: harnesses.list().map((h) => ({ ...h, agents: harnesses.agents(h.id) })) });
    });

    // Every harness × agent offer with the defaults (health up, no latency); placement runs no I/O.
    r.post('/harnesses/route', limiter, actorLimits.budget('codes.harness.route'), json, (req, res) => {
        const b = req.body || {};
        const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
        if (typeof b.task !== 'string' || !b.task) return problem(req, res, 422, 'harness.invalid', 'task is a non-empty string');
        if (b.requirements !== undefined && !plain(b.requirements)) return problem(req, res, 422, 'harness.invalid', 'requirements is an object');
        const caps = b.requirements && b.requirements.capabilities;
        if (caps !== undefined && !(Array.isArray(caps) && caps.every((c) => typeof c === 'string'))) return problem(req, res, 422, 'harness.invalid', 'requirements.capabilities is an array of strings');
        try {
            res.json(placement.route({ task: b.task, extra: b.requirements || {}, harnesses }));
        } catch (err) {
            if (err && err.code === 'harness.task_unknown') return problem(req, res, 422, 'harness.task_unknown', `task is one of ${Object.keys(placement.TASKS).join(', ')}`);
            const code = err && err.code === 'harness.placement_invalid' ? 'harness.placement_invalid' : 'internal.error';
            ctx.log.error('[Codes] api error:', err && err.message ? err.message.slice(0, 200) : err);
            return problem(req, res, 500, code, 'Internal error');
        }
    });

    return r;
}

module.exports = { createApi };
