'use strict';

/**
 * A person's connections (Codes C3, spec codes-c3-connections.md): the API keys they keep for their own providers
 * and the plans on their own machines.
 *
 *   GET    /api/v1/connections              the keys (provider, hint, today's spend, budget, last used) and the plans
 *   PUT    /api/v1/connections/:provider    { key, base_url?, budget_usd_per_day? } → the connection (the hint only)
 *   DELETE /api/v1/connections/:provider    forget the key
 *   POST   /api/v1/connections/:provider/test   one tiny request through AI: OK, or why not
 *
 * The owner of a key is the signed-in person: only they may read, change or test their own connections, and a
 * request that names another person is refused. The key itself is forwarded to OpenVibe.AI and never kept here: it
 * is not in Codes' database, not in its logs, not in its answers. The plans are the CLI logins on the person's own
 * machines, reported by their Node through OpenVibe.Bot; there are none yet, so the list is empty until a machine
 * reports one (stage C5).
 */

const express = require('express');
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');

const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function createConnectionsApi({ config, store, connections, actorLimits, log = console } = {}) {
    const r = asyncRouter();
    const problem = (req, res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const json = express.json({ limit: '8kb' });

    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const sameOrigin = (req) => {
        const origin = req.get('origin');
        if (!origin) return true;
        try { return new URL(origin).origin === new URL(config.baseUrl).origin; } catch { return false; }
    };

    /**
     * The person whose connections this is: the signed-in one, and nobody else. A request that names another
     * subject (a header or a query) is refused rather than quietly answered with the caller's own.
     */
    const owner = (req, res) => {
        if (!signedIn(req)) { problem(req, res, 401, 'auth.required', 'sign in to see your connections'); return null; }
        const named = String(req.get('x-ov-subject') || req.query.subject || '').trim();
        if (named && named !== req.viewer.subject) {
            problem(req, res, 403, 'connections.forbidden', "these are your own connections; another person's are not yours to read");
            return null;
        }
        return req.viewer.subject;
    };

    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

    r.get('/connections', actorLimits.reads('codes.read'), async (req, res) => {
        const subject = owner(req, res);
        if (!subject) return undefined;
        try {
            return res.json(await connections.list(subject));
        } catch (e) {
            log.warn(`[Codes] the connections of ${subject} could not be read: ${String(e && e.message).slice(0, 200)}`);
            return problem(req, res, (e && e.status) || 503, (e && e.code) || 'connections.unavailable', (e && e.message) || 'the connections could not be read');
        }
    });

    r.put('/connections/:provider', actorLimits.budget('codes.task.start'), json, async (req, res) => {
        const subject = owner(req, res);
        if (!subject) return undefined;
        if (!sameOrigin(req)) return problem(req, res, 403, 'cross_site', 'cross-site JSON posts are refused');
        const body = req.body || {};
        try {
            // The key goes straight to OpenVibe.AI: it is never stored, never logged and never answered.
            const out = await connections.put(subject, req.params.provider, body);
            log.info(`[Codes] ${subject} stored a key for ${out.provider}`);
            return res.status(200).json({ connection: out });
        } catch (e) {
            log.warn(`[Codes] the key for ${req.params.provider} was refused: ${String(e && e.message).slice(0, 200)}`);
            return problem(req, res, (e && e.status) || 503, (e && e.code) || 'connections.refused', (e && e.message) || 'the key was refused');
        }
    });

    r.delete('/connections/:provider', actorLimits.budget('codes.task.start'), async (req, res) => {
        const subject = owner(req, res);
        if (!subject) return undefined;
        try {
            const gone = await connections.remove(subject, req.params.provider);
            if (!gone) return problem(req, res, 404, 'connections.not_found', 'there is no key for that provider');
            return res.status(204).end();
        } catch (e) {
            return problem(req, res, (e && e.status) || 503, (e && e.code) || 'connections.refused', (e && e.message) || 'the key could not be forgotten');
        }
    });

    r.post('/connections/:provider/test', actorLimits.budget('codes.task.start'), json, async (req, res) => {
        const subject = owner(req, res);
        if (!subject) return undefined;
        if (!sameOrigin(req)) return problem(req, res, 403, 'cross_site', 'cross-site JSON posts are refused');
        try {
            const out = await connections.test(subject, req.params.provider);
            return res.json(out);
        } catch (e) {
            return problem(req, res, (e && e.status) || 503, (e && e.code) || 'connections.refused', (e && e.message) || 'the key could not be tested');
        }
    });

    return r;
}

module.exports = { createConnectionsApi };
