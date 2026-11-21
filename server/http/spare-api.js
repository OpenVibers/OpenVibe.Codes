'use strict';
/**
 * Spare usage over the API (plan §AD.37): the same list and settings /settings/spare shows, for any OpenVibe site (the
 * person's own session here, or their Network token as a Bearer from another site: openvibe.my, Actor, Watch, the SDK).
 *
 *   GET    /me/usage              → { agents: [{ agent, name, state, windows: [{ name, used_pct, resets_at }], take, why }] }
 *                                   what each of the person's coding agents has left, and whether the list would use it now
 *   GET    /me/spare              → { settings, tasks, agents }
 *   PUT    /me/spare              { enabled, reset_within_hours, min_left_pct, keep_pct, max_running, agents } → { settings }
 *   POST   /me/spare/tasks        { title?, prompt, repo, agent?, priority?, repeat? } → { task } (201); repo: owner/name or https
 *   PATCH  /me/spare/tasks/:id    any of those, or state queued|paused → { task }
 *   DELETE /me/spare/tasks/:id    → 204
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { corsOpenVibe } = require('./openvibe-origins');

const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const SPT = /^spt_[0-9A-HJKMNP-TV-Z]{26}$/;

function createSpareApi({ config, keys, spare, actorLimits, log = console }) {
    const r = asyncRouter();
    const json = express.json({ limit: '32kb' });
    const problem = (req, res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });
    r.use(corsOpenVibe({ methods: 'GET, PUT, POST, PATCH, DELETE, OPTIONS', paths: ['/me/spare', '/me/usage'] }));

    /** The person: this site's session, or their own Network token as a Bearer (another OpenVibe site, the SDK). */
    async function subjectOf(req) {
        if (req.viewer && req.viewer.kind === 'user' && req.viewer.subject) return req.viewer.subject;
        const header = String(req.headers.authorization || '');
        if (!header.startsWith('Bearer ') || !keys) return null;
        if (!keys.loaded()) await keys.ensure();
        const v = await keys.verifyUser(header.slice(7).trim(), { issuer: config.networkIssuer, audience: [config.oauth.sessionAudience, config.serviceAudience] });
        const subject = v.ok && typeof v.claims.subject_id === 'string' ? v.claims.subject_id : null;
        return USER.test(subject || '') ? subject : null;
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
        const subject = await subjectOf(req);
        if (!subject) { problem(req, res, 401, 'auth.required', 'sign in (or send your OpenVibe token) to use your spare usage'); return null; }
        if (write && crossSiteCookie(req)) { problem(req, res, 403, 'cross_site', 'cross-site cookie writes are refused: send your token as a Bearer'); return null; }
        return subject;
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
    r.post('/me/spare/tasks', writes, json, async (req, res) => {
        const subject = await guard(req, res, true); if (!subject) return;
        try { return res.status(201).json({ task: await spare.add(subject, req.body || {}) }); } catch (e) { return fail(req, res, e); }
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
