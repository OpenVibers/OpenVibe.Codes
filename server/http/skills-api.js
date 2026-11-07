'use strict';

/**
 * The skills hub's JSON API (the Compute plan §5, E6).
 *
 *   GET  /api/v1/skills                    the public gallery (no auth); ?kind, ?tool, ?q, ?limit
 *   GET  /api/v1/skills?mine=1             the signed-in person's own records, every audience
 *   GET  /api/v1/skills/:id                one record, if this viewer may read it
 *   GET  /api/v1/skills/:id/versions       the versions, newest first (no bodies)
 *   GET  /api/v1/skills/:id/versions/:n    one version, with its body
 *   POST /api/v1/skills                    create a record and version 1
 *   POST /api/v1/skills/:id/versions       save a new version
 *   POST /api/v1/skills/:id/rollback       copy an old version into a new one
 *   POST /api/v1/skills/:id/audience       one of public, link, people, private
 *   POST /api/v1/skills/:id/members        add a person to a people-shared record
 *   POST /api/v1/skills/:id/members/remove remove a person
 *   GET  /api/v1/me/skills                 the sync manifest: the person's picks + this project's, ?project=slug
 *   POST /api/v1/me/skills/:id             add a record to the sync
 *   POST /api/v1/me/skills/:id/remove      remove it
 *
 * The Node sync authenticates with the person's access token (Authorization: Bearer), which the same SSO middleware
 * verifies as a browser session. Only public records are in the gallery; the others answer 404 to everyone who is
 * not allowed to read them.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { SkillError } = require('../domain/skills');

const ID = /^skl_[0-9A-HJKMNP-TV-Z]{26}$/;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function createSkillsApi({ config, skills, actorLimits, log = console }) {
    const r = asyncRouter();
    const json = express.json({ limit: '160kb' });
    const problem = (req, res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const signed = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const viewer = (req) => (signed(req) ? { subject: req.viewer.subject, role: req.viewer.role } : null);
    const sameOrigin = (req) => {
        const origin = req.get('origin');
        if (!origin) return true;
        try { return new URL(origin).origin === new URL(config.baseUrl).origin; } catch { return false; }
    };
    const guard = (fn) => async (req, res) => {
        try { await fn(req, res); } catch (err) {
            if (err instanceof SkillError) return problem(req, res, err.status, err.code, err.message);
            log.error('[Codes] skills api error:', err && err.message ? err.message.slice(0, 200) : err);
            return problem(req, res, 500, 'internal.error', 'Internal error');
        }
    };
    const projectOf = (req) => {
        const p = req.query.project !== undefined ? String(req.query.project) : (req.body && req.body.project !== undefined ? String(req.body.project) : '');
        if (p && !PROJECT.test(p)) throw new SkillError(422, 'skill.invalid', 'project is a slug');
        return p;
    };
    const need = (req, res) => {
        if (!signed(req)) { problem(req, res, 401, 'auth.required', 'sign in to change your skills'); return false; }
        if (!sameOrigin(req)) { problem(req, res, 403, 'cross_site', 'cross-site JSON posts are refused'); return false; }
        return true;
    };

    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

    r.get('/skills', actorLimits.reads('codes.read'), guard(async (req, res) => {
        if (req.query.mine === '1') {
            if (!signed(req)) return problem(req, res, 401, 'auth.required', 'sign in to see your skills');
            return res.json({ skills: await skills.mine(req.viewer.subject) });
        }
        const skillsOut = await skills.gallery({ kind: req.query.kind, tool: req.query.tool, q: req.query.q, limit: req.query.limit });
        return res.json({ skills: skillsOut, total: skillsOut.length });
    }));

    r.get('/skills/:id', actorLimits.reads('codes.read'), guard(async (req, res) => {
        if (!ID.test(req.params.id)) return problem(req, res, 404, 'skill.not_found', 'no such skill');
        const skill = await skills.get(req.params.id, viewer(req));
        if (!skill) return problem(req, res, 404, 'skill.not_found', 'no such skill');
        const versions = await skills.listVersions(skill.id, viewer(req));
        return res.json({ skill, versions: (versions || []).map(({ body, ...rest }) => rest) });
    }));

    r.get('/skills/:id/versions', actorLimits.reads('codes.read'), guard(async (req, res) => {
        if (!ID.test(req.params.id)) return problem(req, res, 404, 'skill.not_found', 'no such skill');
        const versions = await skills.listVersions(req.params.id, viewer(req));
        if (!versions) return problem(req, res, 404, 'skill.not_found', 'no such skill');
        return res.json({ versions: versions.map(({ body, ...rest }) => rest) });
    }));

    r.get('/skills/:id/versions/:version', actorLimits.reads('codes.read'), guard(async (req, res) => {
        if (!ID.test(req.params.id)) return problem(req, res, 404, 'skill.not_found', 'no such skill');
        const versions = await skills.listVersions(req.params.id, viewer(req));
        if (!versions) return problem(req, res, 404, 'skill.not_found', 'no such skill');
        const version = versions.find((v) => v.version === Number(req.params.version));
        if (!version) return problem(req, res, 404, 'skill.version_not_found', 'no such version of this skill');
        return res.json({ version });
    }));

    r.post('/skills', actorLimits.budget('codes.skill.write'), json, guard(async (req, res) => {
        if (!need(req, res)) return undefined;
        const skill = await skills.create({ subject: req.viewer.subject, input: req.body || {} });
        return res.status(201).json({ skill });
    }));

    r.post('/skills/:id/versions', actorLimits.budget('codes.skill.write'), json, guard(async (req, res) => {
        if (!need(req, res)) return undefined;
        const skill = await skills.addVersion({ subject: req.viewer.subject, id: req.params.id, input: req.body || {}, note: (req.body && req.body.note) || 'edited' });
        return res.status(201).json({ skill });
    }));

    r.post('/skills/:id/rollback', actorLimits.budget('codes.skill.write'), json, guard(async (req, res) => {
        if (!need(req, res)) return undefined;
        const skill = await skills.rollback({ subject: req.viewer.subject, id: req.params.id, version: req.body && req.body.version });
        return res.status(201).json({ skill });
    }));

    r.post('/skills/:id/audience', actorLimits.budget('codes.skill.write'), json, guard(async (req, res) => {
        if (!need(req, res)) return undefined;
        const skill = await skills.setAudience({ subject: req.viewer.subject, id: req.params.id, audience: req.body && req.body.audience });
        return res.json({ skill });
    }));

    r.post('/skills/:id/members', actorLimits.budget('codes.skill.write'), json, guard(async (req, res) => {
        if (!need(req, res)) return undefined;
        const members = await skills.addMember({ subject: req.viewer.subject, id: req.params.id, memberSubject: req.body && req.body.subject });
        return res.status(201).json({ members });
    }));

    r.post('/skills/:id/members/remove', actorLimits.budget('codes.skill.write'), json, guard(async (req, res) => {
        if (!need(req, res)) return undefined;
        const members = await skills.removeMember({ subject: req.viewer.subject, id: req.params.id, memberSubject: req.body && req.body.subject });
        return res.json({ members });
    }));

    r.get('/me/skills', actorLimits.reads('codes.read'), guard(async (req, res) => {
        if (!signed(req)) return problem(req, res, 401, 'auth.required', 'sign in to sync your skills');
        return res.json(await skills.manifest({ subject: req.viewer.subject, project: projectOf(req) }));
    }));

    r.get('/me/skills/assignments', actorLimits.reads('codes.read'), guard(async (req, res) => {
        if (!signed(req)) return problem(req, res, 401, 'auth.required', 'sign in to see your sync');
        return res.json({ assignments: await skills.assignments(req.viewer.subject, projectOf(req)) });
    }));

    r.post('/me/skills/:id', actorLimits.budget('codes.skill.assign'), json, guard(async (req, res) => {
        if (!need(req, res)) return undefined;
        const skill = await skills.assign({ subject: req.viewer.subject, id: req.params.id, project: projectOf(req) });
        return res.status(201).json({ skill });
    }));

    r.post('/me/skills/:id/remove', actorLimits.budget('codes.skill.assign'), json, guard(async (req, res) => {
        if (!need(req, res)) return undefined;
        await skills.unassign({ subject: req.viewer.subject, id: req.params.id, project: projectOf(req) });
        return res.json({ removed: true });
    }));

    return r;
}

module.exports = { createSkillsApi };
