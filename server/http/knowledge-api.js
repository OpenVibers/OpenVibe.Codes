'use strict';

/**
 * The knowledge API for the person's own agents (Know K5): the `ov-know` MCP server reads and writes these rows with
 * the person's own Network token. A cookie session works too (the page uses its own routes, not these).
 *
 *   GET  /api/v1/knowledge?q=&repo=&kind=&pinned=&limit=   → { knowledge: […], count, teams_not_read? }
 *   POST /api/v1/knowledge   { text, kind?, repo?, paths?, pinned?, team_id? } → { knowledge, created } (201)
 *
 * Every read is the person's own rows plus the rows their teams shared; the team list comes from Network with the
 * caller's token, so no client can name a team it does not belong to. Every write is redacted before it is stored.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');

function createKnowledgeApi({ config, store, knowledge, actorLimits, log = console }) {
    const r = asyncRouter();
    const json = express.json({ limit: '32kb' });
    const problem = (req, res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const sameOrigin = (req) => {
        const origin = req.get('origin');
        if (!origin) return true;
        try { return new URL(origin).origin === new URL(config.baseUrl).origin; } catch { return false; }
    };

    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

    r.get('/knowledge', actorLimits.reads('codes.knowledge.read'), async (req, res) => {
        if (!signedIn(req)) return problem(req, res, 401, 'auth.required', 'sign in to read your knowledge');
        const token = req.token || (req.viewer && req.viewer.token) || null;
        let teams = [];
        let teamsNotRead = false;
        try {
            teams = await knowledge.teamIdsOf(token);
        } catch {
            teamsNotRead = true;
        }
        const kind = ['lesson', 'fact'].includes(String(req.query.kind || '')) ? String(req.query.kind) : null;
        const rows = await knowledge.list({
            subject: req.viewer.subject,
            teamIds: teams,
            q: req.query.q ? String(req.query.q).slice(0, 200) : null,
            repo: req.query.repo ? knowledge.repoOf(String(req.query.repo).slice(0, 300)) : null,
            kind,
            pinned: req.query.pinned === '1' || req.query.pinned === 'true',
            limit: Math.max(1, Math.min(100, Number(req.query.limit) || 50)),
        });
        return res.json({
            knowledge: rows.map((row) => knowledge.present(row, { subject: req.viewer.subject })),
            count: rows.length,
            ...(teamsNotRead ? { teams_not_read: true } : {}),
        });
    });

    r.post('/knowledge', actorLimits.budget('codes.knowledge.write'), json, async (req, res) => {
        if (!signedIn(req)) return problem(req, res, 401, 'auth.required', 'sign in to add knowledge');
        if (!sameOrigin(req)) return problem(req, res, 403, 'cross_site', 'cross-site posts are refused');
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const text = typeof b.text === 'string' ? b.text : '';
        if (!text.trim()) return problem(req, res, 422, 'knowledge.text_required', 'text is required');
        if (!knowledge.KINDS.includes(b.kind || 'lesson')) return problem(req, res, 422, 'knowledge.kind_invalid', `kind is one of ${knowledge.KINDS.join(', ')}`);
        if (b.repo != null && (typeof b.repo !== 'string' || b.repo.length > 300)) return problem(req, res, 422, 'knowledge.repo_invalid', 'repo must be a string of at most 300 characters');
        if (b.paths != null && (!Array.isArray(b.paths) || b.paths.length > 12 || b.paths.some((p) => typeof p !== 'string' || p.length > 300))) {
            return problem(req, res, 422, 'knowledge.paths_invalid', 'paths is at most 12 strings of 300 characters');
        }
        let teamId = null;
        if (b.team_id != null && b.team_id !== '') {
            const teams = await knowledge.projectsOf(req.token || (req.viewer && req.viewer.token) || null);
            if (!teams.some((t) => t.id === String(b.team_id))) return problem(req, res, 403, 'knowledge.team_forbidden', 'you are not a member of that team');
            teamId = String(b.team_id);
        }
        try {
            const out = await knowledge.remember({
                subject: req.viewer.subject,
                kind: b.kind || 'lesson',
                text,
                repo: b.repo || null,
                paths: b.paths || [],
                pinned: b.pinned === true,
                teamId,
                visibility: teamId ? 'team' : 'private',
                sourceAgent: 'agent',
            });
            log.info(`[Codes] knowledge: ${req.viewer.subject} ${out.created ? 'added' : 'repeated'} ${out.row.id}${teamId ? ' (shared)' : ''}`);
            return res.status(out.created ? 201 : 200).json({ knowledge: knowledge.present(out.row, { subject: req.viewer.subject }), created: out.created });
        } catch (e) {
            return problem(req, res, e.status || 422, e.code || 'knowledge.invalid', e.message);
        }
    });

    return r;
}

module.exports = { createKnowledgeApi };
