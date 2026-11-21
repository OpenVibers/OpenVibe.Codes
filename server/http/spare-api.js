'use strict';
/**
 * Spare usage over the API (plan §AD.37): the same list and settings /settings/spare shows, for any OpenVibe site (the
 * person's own session here, or their Network token as a Bearer from another site: openvibe.my, the SDK), and for a
 * first-party service acting for a person (OpenVibe.Actor's spare_usage tool): its service token with codes.task.read
 * (reads) or codes.task.start (changes: what the list holds starts tasks), the person named in X-OV-Subject.
 *
 *   GET    /me/usage              → { agents: [{ agent, name, state, windows: [{ name, used_pct, resets_at }], take, why }] }
 *                                   what each of the person's coding agents has left, and whether the list would use it now
 *   GET    /me/spare              → { settings, tasks, agents }
 *   PUT    /me/spare              { enabled, reset_within_hours, min_left_pct, keep_pct, max_running, agents } → { settings }
 *   POST   /me/spare/tasks        { title?, prompt, repo, agent?, priority?, repeat? } → { task } (201); repo: owner/name or https
 *                                  or { loop, repo, site? }: a loop (domain/loops.js: accessibility, security, latency, tests,
 *                                  docs, dependencies), a repeating task with its own brief, ending in a pull request
 *   GET    /me/spare/loops        → { loops: [{ id, name, what }] }
 *   PATCH  /me/spare/tasks/:id    any of those, or state queued|paused → { task }
 *   DELETE /me/spare/tasks/:id    → 204
 */
const express = require('express');
const { http, serviceAuth, capabilities } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { corsOpenVibe } = require('./openvibe-origins');

const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const SPT = /^spt_[0-9A-HJKMNP-TV-Z]{26}$/;

function createSpareApi({ config, keys, spare, actorLimits, log = console }) {
    const r = asyncRouter();
    const json = express.json({ limit: '32kb' });
    const problem = (req, res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });
    r.use(corsOpenVibe({ methods: 'GET, PUT, POST, PATCH, DELETE, OPTIONS', paths: ['/me/spare', '/me/usage'] }));

    /**
     * The person: this site's session, their own Network token as a Bearer (another OpenVibe site, the SDK), or a
     * first-party service's token with `cap` acting for the person in X-OV-Subject. → { subject, service? } or null.
     */
    async function callerOf(req, cap) {
        if (req.viewer && req.viewer.kind === 'user' && req.viewer.subject) return { subject: req.viewer.subject };
        const header = String(req.headers.authorization || '');
        if (!header.startsWith('Bearer ') || !keys) return null;
        if (!keys.loaded()) await keys.ensure();
        const token = header.slice(7).trim();
        const v = await keys.verifyUser(token, { issuer: config.networkIssuer, audience: [config.oauth.sessionAudience, config.serviceAudience] });
        const subject = v.ok && typeof v.claims.subject_id === 'string' ? v.claims.subject_id : null;
        if (USER.test(subject || '')) return { subject };
        const publicKey = keys.get && keys.get();
        if (!publicKey) return null;
        const s = serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.networkIssuer, audience: config.serviceAudience });
        if (!s.ok || !String(s.claims.sub || '').startsWith('svc:')) return null;
        if (!capabilities.check(s.claims, cap).allowed) return { denied: cap };
        const named = String(req.get('X-OV-Subject') || '').trim();
        return USER.test(named) ? { subject: named, service: String(s.claims.sub).slice(4) } : { denied: 'X-OV-Subject' };
    }
    /** A cookie-session write must come from this site; a Bearer write is the token's own proof. */
    function crossSiteCookie(req) {
        if (String(req.headers.authorization || '').startsWith('Bearer ')) return false;
        const origin = req.get('origin');
        if (!origin) return false;
        try { return new URL(origin).origin !== new URL(config.baseUrl).origin; } catch { return true; }
    }
    const reads = actorLimits ? actorLimits.reads('codes.read') : (req, res, next) => next();
    const writes = actorLimits ? actorLimits.budget('codes.task.start') : (req, res, next) => next();
    const guard = async (req, res, write) => {
        const caller = await callerOf(req, write ? 'codes.task.start' : 'codes.task.read');
        if (caller && caller.denied) { problem(req, res, caller.denied === 'X-OV-Subject' ? 422 : 403, caller.denied === 'X-OV-Subject' ? 'subject.required' : 'capability.denied', caller.denied === 'X-OV-Subject' ? 'name the person in X-OV-Subject (usr_…)' : `${caller.denied} not granted`); return null; }
        if (!caller) { problem(req, res, 401, 'auth.required', 'sign in (or send your OpenVibe token) to use your spare usage'); return null; }
        if (write && crossSiteCookie(req)) { problem(req, res, 403, 'cross_site', 'cross-site cookie writes are refused: send your token as a Bearer'); return null; }
        if (caller.service && write) log.info && log.info(`[Codes] spare: ${caller.service} changed the list of ${caller.subject}`);
        return caller.subject;
    };
    const fail = (req, res, e) => problem(req, res, e.status || 500, e.code || 'spare.failed', String((e && e.message) || 'that did not work').slice(0, 300));

    r.get('/me/usage', reads, async (req, res) => {
        const subject = await guard(req, res, false); if (!subject) return;
        const v = await spare.view(subject);
        res.set('Cache-Control', 'private, no-store');
        return res.json({ agents: v.agents, spare: { enabled: v.settings.enabled, queued: v.tasks.filter((t) => t.state === 'queued').length } });
    });
    r.get('/me/spare', reads, async (req, res) => {
        const subject = await guard(req, res, false); if (!subject) return;
        res.set('Cache-Control', 'private, no-store');
        return res.json(await spare.view(subject));
    });
    r.put('/me/spare', writes, json, async (req, res) => {
        const subject = await guard(req, res, true); if (!subject) return;
        try { return res.json({ settings: await spare.saveSettings(subject, req.body || {}) }); } catch (e) { return fail(req, res, e); }
    });
    r.get('/me/spare/loops', (req, res) => {
        res.set('Cache-Control', 'public, max-age=300');
        return res.json({ loops: require('../domain/loops').LOOPS.map(({ id, name, what }) => ({ id, name, what })) });
    });
    r.post('/me/spare/tasks', writes, json, async (req, res) => {
        const subject = await guard(req, res, true); if (!subject) return;
        const b = req.body || {};
        let body = b;
        if (b.loop != null) {
            const made = require('../domain/loops').taskFor(String(b.loop), { repo: b.repo, site: b.site });
            if (made.error) return problem(req, res, 422, 'spare.invalid', made.error);
            body = { ...made.body, ...(b.agent ? { agent: b.agent } : {}), ...(b.priority ? { priority: b.priority } : {}) };
        }
        try { return res.status(201).json({ task: await spare.add(subject, body) }); } catch (e) { return fail(req, res, e); }
    });
    r.patch('/me/spare/tasks/:id', writes, json, async (req, res) => {
        const subject = await guard(req, res, true); if (!subject) return;
        if (!SPT.test(req.params.id)) return problem(req, res, 404, 'spare.not_found', 'no such task on your list');
        try {
            const task = await spare.update(subject, req.params.id, req.body || {});
            return task ? res.json({ task }) : problem(req, res, 404, 'spare.not_found', 'no such task on your list');
        } catch (e) { return fail(req, res, e); }
    });
    r.delete('/me/spare/tasks/:id', writes, async (req, res) => {
        const subject = await guard(req, res, true); if (!subject) return;
        if (!SPT.test(req.params.id) || !(await spare.remove(subject, req.params.id))) return problem(req, res, 404, 'spare.not_found', 'no such task on your list');
        log.info && log.info(`[Codes] spare: ${subject} removed ${req.params.id}`);
        return res.status(204).end();
    });
    return r;
}

module.exports = { createSpareApi };
