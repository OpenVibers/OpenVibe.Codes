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
 *   GET  /me/repos?q=&limit=    → { sections: [{ id, label, items }], create }: the repository dropdown (ask 348)
 *   POST /repos { name, private } → { url, label }: a repository made on OpenVibe Git in the person's name
 *   GET  /me/settings           → { settings }: the person's choices, including who leads their tasks
 *   PUT  /me/settings           → { settings }: save any of them (a field left out keeps what it had)
 */
const express = require('express');
const { http, validate } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { parseArgs } = require('../../harness/job');
const { createRunTasks, TERMINAL } = require('../domain/run-tasks');

const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const TASK = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const DELEGABLE = new Set(['owner', 'admin']);

function createMeApi({ config, store, sso, run, harnesses, userSettings = null, actorLimits, tasks = null, github = null, repoPicker = null, forge = null, log = console }) {
    const r = asyncRouter();
    const db = store.db;
    const taskStore = tasks || createRunTasks({ store, run, config, log });
    const problem = (req, res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const json = express.json({ limit: '32kb' });

    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
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

    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

    r.get('/me/tasks', actorLimits.reads('codes.read'), async (req, res) => {
        if (!signedIn(req)) return problem(req, res, 401, 'auth.required', 'sign in to see your tasks');
        const rows = await db.many('SELECT * FROM run_tasks WHERE subject = $1 ORDER BY updated_at DESC LIMIT 50', [req.viewer.subject]);
        return res.json({ tasks: rows.map((row) => taskStore.present(row)) });
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
    // The repository field's dropdown (ask 348): the owner's sources, merged in their order. A source that fails or
    // takes too long is simply not there: the person sees the repositories Codes could reach, never an error.
    r.get('/me/repos', actorLimits.budget('codes.repo.search'), async (req, res) => {
        if (!signedIn(req)) return problem(req, res, 401, 'auth.required', 'sign in to search your repositories');
        const q = String(req.query.q || '').trim().slice(0, 100);
        const limit = Math.min(20, Math.max(1, Number.parseInt(req.query.limit, 10) || 8));
        const sections = repoPicker ? await repoPicker.sections({ viewer: req.viewer, q, limit }) : [];
        const create = repoPicker ? repoPicker.create(req.viewer) : { allowed: false, host: 'git.openvibe.codes', owner: req.viewer.username || null };
        return res.json({ q, sections, create });
    });

    // A new repository on OpenVibe Git, under the person signed in (their Network username is the Git namespace):
    // ask 348's "Create …" row. The name is validated, the call is same-origin, and it counts as one of their writes.
    r.post('/repos', actorLimits.budget('codes.repo.create'), json, async (req, res) => {
        if (!signedIn(req)) return problem(req, res, 401, 'auth.required', 'sign in to make a repository');
        if (!sameOrigin(req)) return problem(req, res, 403, 'cross_site', 'cross-site posts are refused');
        if (!forge || !forge.enabled) return problem(req, res, 503, 'repo.git_off', 'OpenVibe Git is not open from Codes right now. Try again in a minute.');
        const body = req.body || {};
        const name = String(body.name || '').trim().toLowerCase();
        try {
            const made = await forge.createRepo(
                { subject: req.viewer.subject, username: req.viewer.username || '' },
                { name, isPrivate: body.private === true },
            );
            return res.status(201).json({ url: made.clone_url, label: made.full_name });
        } catch (e) {
            const status = Number(e && e.status) || 502;
            if (status === 422) return problem(req, res, 422, 'repo.name_invalid', String(e.message || 'that repository name cannot be used'));
            if (status === 409 && e.code === 'git.unlinked') return problem(req, res, 409, 'repo.no_username', 'Your OpenVibe account has no username yet, so a repository has no address. Choose one on your account page, then try again.');
            if (status === 409) return problem(req, res, 409, 'repo.name_taken', String(e.message || 'you already have a repository with that name'));
            if (status === 503) return problem(req, res, 503, 'repo.git_off', 'OpenVibe Git did not answer. Try again in a minute.');
            log.warn(`[Codes] repository create refused: ${String((e && e.message) || e).slice(0, 160)}`);
            return problem(req, res, 502, 'repo.create_failed', 'OpenVibe Git did not make the repository. Try again in a minute.');
        }
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
