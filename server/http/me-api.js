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
 */
const express = require('express');
const { http, validate } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { parseArgs } = require('../../harness/job');
const { createRunTasks, TERMINAL } = require('../domain/run-tasks');

const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const TASK = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const DELEGABLE = new Set(['owner', 'admin']);

function createMeApi({ config, store, sso, run, harnesses, actorLimits, tasks = null, github = null, log = console }) {
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
        const check = validate('codes.task-start-request@1', b);
        if (!check.valid) return problem(req, res, 422, 'codes.task_invalid', check.errors.map((e) => `${e.instancePath || 'body'} ${e.message}`).join('; ').slice(0, 500));
        if (b.agent && !harnesses.list().some((a) => a.id === b.agent)) return problem(req, res, 422, 'codes.agent_unknown', 'agent is one of GET /api/v1/harnesses, or absent for the router to pick');
        let args;
        try {
            args = parseArgs(JSON.stringify({
                repo: b.repo, ref: b.ref || null, prompt: b.prompt, agent: b.agent || null, permission: b.permission || 'edit',
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
