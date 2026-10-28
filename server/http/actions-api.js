'use strict';

/**
 * The Action Center read (plan 2026-10-28 §3.10): GET /api/v1/actions?subject=usr_…
 *
 * A Network service token for audience openvibe.codes holding codes.actions.read names one person and gets that
 * person's coding tasks as common.action-list-result@1: everything queued/placed/running, then done and failed tasks
 * from the last 30 days, newest updated_at first, at most 50. Never another person's tasks; a person's own token is
 * refused, as is a token without the capability or a subject that is not a usr_… id.
 */
const { serviceAuth, capabilities, http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { createRunTasks } = require('../domain/run-tasks');
const items = require('../actions/items');

const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const RUNNING = ['queued', 'placed', 'running'];

function createActionsApi({ config, store, keys, run, actorLimits, log = console }) {
    const r = asyncRouter();
    const tasks = createRunTasks({ store, run, config, log });
    const problem = (req, res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });

    const guard = async (req, res, next) => {
        const header = String(req.headers.authorization || '');
        if (!header.startsWith('Bearer ')) return problem(req, res, 401, 'token.required', `codes.actions.read needs a Network service token for ${config.serviceAudience}`);
        if (!keys.loaded()) await keys.ensure();
        const publicKey = keys.get();
        if (!publicKey) return problem(req, res, 503, 'identity.unavailable', 'the Network signing key is not loaded yet');
        const v = serviceAuth.verifyServiceToken(header.slice(7).trim(), { publicKey, issuer: config.networkIssuer, audience: config.serviceAudience });
        if (!v.ok) return problem(req, res, 401, v.code || 'token.invalid', v.reason || 'the service token is invalid');
        const sub = String(v.claims.sub || '');
        if (!sub.startsWith('svc:')) return problem(req, res, 403, 'capability.denied', 'codes.actions.read is for first-party services');
        const decision = capabilities.check(v.claims, 'codes.actions.read');
        if (!decision.allowed) return problem(req, res, 403, decision.code || 'capability.denied', decision.reason || 'codes.actions.read not granted');
        const subject = String(req.query.subject || '').trim();
        if (!USER.test(subject)) return problem(req, res, 400, 'subject.invalid', 'subject must be a usr_… subject id');
        req.principal = { sub: `user:${subject}`, subject, via: `service:${sub.slice(4)}` };
        return next();
    };

    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.get('/actions', guard, actorLimits.reads('codes.actions.read'), async (req, res) => {
        const cutoff = store.now() - 30 * 86_400_000;
        const rows = await store.db.many(`SELECT * FROM run_tasks
            WHERE subject = $1 AND (state = ANY($2) OR updated_at >= $3)
            ORDER BY updated_at DESC
            LIMIT 50`, [req.principal.subject, RUNNING, cutoff]);
        res.json({ items: rows.map((row) => items.toItem(row, tasks.present(row))) });
    });

    return r;
}

module.exports = { createActionsApi };
