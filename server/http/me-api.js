'use strict';

/**
 * User JSON API for coding tasks (plan 2026-10-28 §6, decision 8): a signed-in person can list, start, read and cancel
 * their own tasks without a service token. POST /api/v1/me/tasks creates a project first when the person has none they
 * may run jobs in, so a first task can be started from code. Calls count against the person's own per-actor budget.
 *
 *   GET  /me/tasks              → { tasks: [ codes.task@1, … ] }
 *   POST /me/tasks              → { task: codes.task@1 } (201)
 *   GET  /me/tasks/:id          → codes.task@1
 *   POST /me/tasks/:id/cancel   → codes.task@1
 *   GET  /me/repos?q=…          → { repos: [{ full_name, url, … }] }: the Home picker's search (Codes C4b)
 *   GET  /me/settings           → { settings }: the person's choices, including who leads their tasks
 *   PUT  /me/settings           → { settings }: save any of them (a field left out keeps what it had)
 */
const express = require('express');
const { http, validate } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { parseArgs } = require('../../harness/job');
const { createRunTasks, TERMINAL } = require('../domain/run-tasks');
const { summarize } = require('../domain/task-summary');
const { corsOpenVibe } = require('./openvibe-origins');
const start = require('./start');

// The person's latest, running first; the Dock asks with ?limit=8.
const LIST_LIMIT = 50;

const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const TASK = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const DELEGABLE = new Set(['owner', 'admin']);

function createMeApi({ config, store, sso, keys, run, harnesses, userSettings = null, actorLimits, tasks = null, github = null, approvals = null, log = console }) {
    const r = asyncRouter();
    const db = store.db;
    const taskStore = tasks || createRunTasks({ store, run, config, log });
    const problem = (req, res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const json = express.json({ limit: '32kb' });

    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    /**
     * The person a Network access token belongs to, or null (the token openvibe.codes signs a person in with,
     * and the one `openvibe-codes task` reads from OPENVIBE_TOKEN). A person token carries no capability claim:
     * being that person is what authorizes their own tasks.
     */
    async function personOf(token) {
        if (!keys) return null;
        if (!keys.loaded()) await keys.ensure();
        const v = await keys.verifyUser(token, { issuer: config.networkIssuer, audience: [config.oauth.sessionAudience, config.serviceAudience] });
        if (!v.ok) return null;
        const subject = typeof v.claims.subject_id === 'string' ? v.claims.subject_id : null;
        return USER.test(subject || '') ? subject : null;
    }
    /** The signed-in person, or their own token as a Bearer (what the Dock on another OpenVibe site sends). */
    async function subjectOf(req) {
        if (signedIn(req)) return req.viewer.subject;
        const header = String(req.headers.authorization || '');
        if (header.startsWith('Bearer ')) return personOf(header.slice(7).trim());
        return null;
    }
    const sameOrigin = (req) => {
        const origin = req.get('origin');
        if (!origin) return true;
        try { return new URL(origin).origin === new URL(config.baseUrl).origin; } catch { return false; }
    };

    /** The person's projects they may run jobs in (owner or admin, not archived), from Network with their own token. */
    async function projectsOf(req, res) {
        const list = await sso.asViewer(req, res, async (token) => {
            const out = await fetch(`${config.networkInternalUrl}/api/v1/projects`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
            if (out.status === 401) { const e = new Error('expired'); e.status = 401; throw e; }
            if (!out.ok) throw new Error(`Network answered ${out.status} for the projects`);
            return (await out.json()).projects || [];
        });
        return list.filter((p) => DELEGABLE.has(p.role) && !p.archived_at).map((p) => ({ id: p.id, name: p.name }));
    }

    async function ensureProject(req, res) {
        const projects = await projectsOf(req, res);
        if (projects.length) return projects[0].id;
        const created = await sso.asViewer(req, res, async (token) => {
            const out = await fetch(`${config.networkInternalUrl}/api/v1/projects`, {
                method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ name: 'My code' }), signal: AbortSignal.timeout(8000),
            });
            if (out.status === 401) { const e = new Error('expired'); e.status = 401; throw e; }
            if (!out.ok) throw new Error(`Network answered ${out.status}`);
            return out.json();
        });
        return created.id;
    }

    const own = async (req, id) => {
        if (!TASK.test(String(id))) return null;
        const row = await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [id]);
        return row && row.subject === req.viewer.subject ? row : null;
    };

    // The Dock's Code tab reads this from another OpenVibe site with the person's bearer token: an allowed origin
    // is reflected so the page may read the answer (server/http/openvibe-origins.js). Writes below stay same-site.
    // Only this router's own routes: another router's preflight must fall through to its own answer.
    r.use(corsOpenVibe({ methods: 'GET, POST, OPTIONS', paths: ['/me/tasks'] }));
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

    /**
     * The person's latest tasks, running first → { tasks: [codes.task-summary@1] }. ?limit= caps the list
     * (the Dock asks with 8). A session cookie or the person's own Network bearer token; another person's tasks
     * are never in the answer.
     */
    r.get('/me/tasks', actorLimits.reads('codes.read'), async (req, res) => {
        const subject = await subjectOf(req);
        if (!subject) return problem(req, res, 401, 'auth.required', 'sign in to see your tasks');
        const limit = Math.min(Math.max(Number(req.query.limit) || LIST_LIMIT, 1), LIST_LIMIT);
        const rows = await db.many(
            `SELECT * FROM run_tasks WHERE subject = $1
             ORDER BY (state IN ('queued', 'placed', 'running')) DESC, updated_at DESC LIMIT $2`,
            [subject, limit],
        );
        const ids = rows.map((row) => row.id);
        const stepsByTask = {};
        if (ids.length) {
            const [attempts, messages] = await Promise.all([
                db.many('SELECT task_id, COUNT(*)::int AS n FROM codes_attempts WHERE task_id = ANY($1) GROUP BY task_id', [ids]),
                db.many('SELECT task_id, COUNT(*)::int AS n FROM codes_conductor_messages WHERE task_id = ANY($1) GROUP BY task_id', [ids]),
            ]);
            for (const a of attempts) stepsByTask[a.task_id] = a.n;
            for (const m of messages) stepsByTask[m.task_id] = Math.max(stepsByTask[m.task_id] || 0, m.n);
        }
        const waiting = new Set();
        if (approvals && ids.length) {
            try {
                for (const a of await approvals.inbox(subject)) if (ids.includes(a.task_id)) waiting.add(a.task_id);
            } catch { /* approvals down: no task reads as waiting for the person */ }
        }
        return res.json({
            tasks: summarize(rows, {
                stepsByTask, waitingIds: waiting,
                openvibeUrls: new Set(start.PROJECTS.map((p) => p.url)), baseUrl: config.baseUrl,
            }),
        });
    });

    r.post('/me/tasks', actorLimits.budget('codes.task.start'), json, async (req, res) => {
        if (!signedIn(req)) return problem(req, res, 401, 'auth.required', 'sign in to start a task');
        if (!sameOrigin(req)) return problem(req, res, 403, 'cross_site', 'cross-site JSON posts are refused');
        const b = req.body || {};
        // AL1: a goal and its typed check are optional. The goal is validated here (it is not part of the closed start
        // request while the switch is off) and travels to the harness, which runs the check in the task's workspace.
        let goal = null;
        if (b.goal != null) {
            if (!config.goals.enabled) return problem(req, res, 409, 'codes.goals_disabled', 'goal tasks are disabled');
            const g = b.goal, limits = g && typeof g === 'object' && !Array.isArray(g) ? (g.budget || {}) : {};
            if (!g || typeof g !== 'object' || Array.isArray(g) || typeof g.goal !== 'string' || !g.goal.trim() || g.goal.length > 4000 || !g.check || !['command', 'url', 'rubric'].includes(g.check.kind) || typeof g.check.value !== 'string' || !g.check.value.trim() || g.check.value.length > 4000) return problem(req, res, 422, 'codes.goal_invalid', 'goal requires a condition and a typed check');
            if (!limits || typeof limits !== 'object' || Array.isArray(limits) || Object.entries(limits).some(([k, v]) => !['tokens', 'turns', 'active_minutes'].includes(k) || !Number.isInteger(v) || v < 1) || (g.no_progress_limit != null && (!Number.isInteger(g.no_progress_limit) || g.no_progress_limit < 1 || g.no_progress_limit > 20))) return problem(req, res, 422, 'codes.goal_invalid', 'goal budgets and no-progress limit must be positive bounded integers');
            goal = { goal: g.goal.trim(), check: { kind: g.check.kind, value: g.check.value.trim() }, budget: limits, no_progress_limit: g.no_progress_limit || 3, proposal: null, evidence: null, verdict: null };
        }
        const bodyForValidate = { ...b };
        delete bodyForValidate.goal;
        const check = validate('codes.task-start-request@1', bodyForValidate);
        if (!check.valid) return problem(req, res, 422, 'codes.task_invalid', check.errors.map((e) => `${e.instancePath || 'body'} ${e.message}`).join('; ').slice(0, 500));
        if (b.agent && !harnesses.list().some((a) => a.id === b.agent)) return problem(req, res, 422, 'codes.agent_unknown', 'agent is one of GET /api/v1/harnesses, or absent for the router to pick');
        let args;
        try {
            args = parseArgs(JSON.stringify({
                repo: b.repo, ref: b.ref || null, prompt: b.prompt, agent: b.agent || null, permission: b.permission || 'edit', ...(goal ? { goal } : {}),
                ...(b.push ? { push: { pull_request: b.pull_request === true } } : {}),
            }));
        } catch (e) {
            return problem(req, res, 422, 'codes.task_invalid', e.message);
        }
        let project;
        try {
            project = await ensureProject(req, res);
        } catch (e) {
            return problem(req, res, e.status === 401 ? 401 : 502, 'project.unavailable', `Could not get or create a project (${e.message}).`);
        }
        const row = await taskStore.start({ subject: req.viewer.subject, project, args });
        log.info(`[Codes] user ${req.viewer.subject} started task ${row.id} through the user API`);
        return res.status(201).json({ task: taskStore.present(row), created: true });
    });

    /**
     * The person's choices over the API (owner 2026-11-07): the same row the Settings page reads, including the agent
     * and model that lead their tasks (`conductor_agent`, `conductor_model`; empty means Claude Code on Opus). A field
     * that is left out keeps what it had, as the page's form does.
     */
    r.get('/me/settings', actorLimits.reads('codes.read'), async (req, res) => {
        if (!signedIn(req)) return problem(req, res, 401, 'auth.required', 'sign in to read your settings');
        if (!userSettings) return problem(req, res, 503, 'settings.unavailable', 'settings are not available here');
        return res.json({ settings: await userSettings.get(req.viewer.subject) });
    });

    r.put('/me/settings', actorLimits.budget('codes.task.start'), json, async (req, res) => {
        if (!signedIn(req)) return problem(req, res, 401, 'auth.required', 'sign in to save your settings');
        if (!sameOrigin(req)) return problem(req, res, 403, 'cross_site', 'cross-site JSON posts are refused');
        if (!userSettings) return problem(req, res, 503, 'settings.unavailable', 'settings are not available here');
        const b = req.body;
        if (!b || typeof b !== 'object' || Array.isArray(b)) return problem(req, res, 422, 'settings.invalid', 'send an object of settings');
        if (b.conductor_agent !== undefined) {
            const v = b.conductor_agent == null ? null : String(b.conductor_agent);
            if (v !== null && !harnesses.list().some((a) => a.id === v)) return problem(req, res, 422, 'settings.conductor_agent_unknown', 'conductor_agent is one of GET /api/v1/harnesses, or empty for Claude Code');
        }
        try {
            return res.json({ settings: await userSettings.save(req.viewer.subject, b) });
        } catch (e) {
            return problem(req, res, e.status || 500, e.code || 'settings.failed', String((e && e.message) || 'the settings could not be saved'));
        }
    });

    /**
     * The Home composer's repository search (Codes C4b): the person's own repositories used here, first, then GitHub's
     * public answer. Codes holds no GitHub account of a person, so the public search is what it can read; a GitHub that
     * does not answer is a `problem` beside the repositories Codes already knows, never an empty list pretending so.
     */
    r.get('/me/repos', actorLimits.budget('codes.repo.search'), async (req, res) => {
        if (!signedIn(req)) return problem(req, res, 401, 'auth.required', 'sign in to search your repositories');
        if (!github) return res.json({ q: String(req.query.q || ''), repos: [], problem: { status: 503, detail: 'the repository search is not available here' } });
        const out = await github.search(req.viewer.subject, req.query.q, { limit: 8 });
        return res.json({ q: out.q, repos: out.found, problem: out.problem });
    });

    r.get('/me/tasks/:id', actorLimits.reads('codes.read'), async (req, res) => {
        if (!signedIn(req)) return problem(req, res, 401, 'auth.required', 'sign in to see your tasks');
        const row = await own(req, req.params.id);
        if (!row) return problem(req, res, 404, 'codes.task_not_found', 'no such task of yours');
        return res.json(taskStore.present(await taskStore.refresh(row)));
    });

    r.post('/me/tasks/:id/cancel', actorLimits.budget('codes.task.start'), async (req, res) => {
        if (!signedIn(req)) return problem(req, res, 401, 'auth.required', 'sign in to cancel your tasks');
        // As starting a task: a cross-site post from a signed-in browser cannot cancel one (REVIEW-0, 11-03).
        if (!sameOrigin(req)) return problem(req, res, 403, 'cross_site', 'cross-site posts are refused');
        let row = await own(req, req.params.id);
        if (!row) return problem(req, res, 404, 'codes.task_not_found', 'no such task of yours');
        if (row.job_id && !TERMINAL.has(row.state)) {
            try { await run.cancel(row.job_id, taskStore.who(row)); } catch (e) { log.warn(`[Codes] cancel ${row.id}: ${e.message}`); }
            row = await taskStore.refresh(row, { force: true });
        }
        return res.json(taskStore.present(row));
    });

    return r;
}

module.exports = { createMeApi };
