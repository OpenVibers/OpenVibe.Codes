'use strict';

/**
 * The service API for coding tasks (Contracts 0.162 codes.task.*, plan T16/T17), under /api/v1: a first-party
 * service (OpenVibe.Actor) starts a coding task for a person, who is named in X-OV-Subject, reads it and cancels it.
 * The task is the same one openvibe.codes/run starts (domain/run-tasks): an OpenVibe.Run job on the person's own
 * machine, in the project of their latest /run task.
 *
 *   POST /tasks              codes.task.start    codes.task-start-request@1 → codes.task-start-result@1 (201, or 200 again)
 *   GET  /tasks/:id          codes.task.read     → codes.task@1
 *   POST /tasks/:id/cancel   codes.task.cancel   → codes.task@1
 *
 * A Network service token for audience openvibe.codes (CODES_AUDIENCE), from a svc: principal holding the route's
 * capability. A service sees only the tasks it started, for that person; anything else is 404. The person's task
 * page (the codes.task@1 url) shows every task they own, whoever started it. Calls count against the person's own
 * per-actor budget (actor-limits.js), not the service's.
 */
const express = require('express');
const { serviceAuth, capabilities, http, validate } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { parseArgs } = require('../../harness/job');
const { createRunTasks, TERMINAL } = require('../domain/run-tasks');

const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const TASK = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;

function createTasksApi({ config, store, keys, run, harnesses, actorLimits, tasks = null, log = console }) {
    const r = asyncRouter();
    const db = store.db;
    const taskStore = tasks || createRunTasks({ store, run, config, log });
    const problem = (req, res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const json = express.json({ limit: '32kb' });

    /** The route's guard: the service token, its capability and the person it acts for → req.principal. */
    const guard = (cap) => async (req, res, next) => {
        const header = String(req.headers.authorization || '');
        if (!header.startsWith('Bearer ')) return problem(req, res, 401, 'token.required', `${cap} needs a Network service token for ${config.serviceAudience}`);
        if (!keys.loaded()) await keys.ensure();
        const publicKey = keys.get();
        if (!publicKey) return problem(req, res, 503, 'identity.unavailable', 'the Network signing key is not loaded yet');
        const v = serviceAuth.verifyServiceToken(header.slice(7).trim(), { publicKey, issuer: config.networkIssuer, audience: config.serviceAudience });
        if (!v.ok) return problem(req, res, 401, v.code || 'token.invalid', v.reason || 'the service token is invalid');
        const sub = String(v.claims.sub || '');
        if (!sub.startsWith('svc:')) return problem(req, res, 403, 'capability.denied', `${cap} is for first-party services`);
        const decision = capabilities.check(v.claims, cap);
        if (!decision.allowed) return problem(req, res, 403, decision.code || 'capability.denied', decision.reason || `${cap} not granted`);
        const subject = String(req.get('X-OV-Subject') || '').trim();
        if (!USER.test(subject)) return problem(req, res, 422, 'subject.required', 'name the person the task is for in X-OV-Subject (usr_…)');
        req.principal = { sub: `user:${subject}`, subject, via: `service:${sub.slice(4)}` };
        return next();
    };

    /** The task this service started for this person, or null. */
    const mine = async (req) => {
        if (!TASK.test(String(req.params.id))) return null;
        return db.maybe('SELECT * FROM run_tasks WHERE id = $1 AND subject = $2 AND via = $3', [req.params.id, req.principal.subject, req.principal.via]);
    };
    const byKey = (p, key) => db.maybe('SELECT * FROM run_tasks WHERE subject = $1 AND via = $2 AND idempotency_key = $3', [p.subject, p.via, key]);

    r.post('/tasks', guard('codes.task.start'), actorLimits.budget('codes.task.start'), json, async (req, res) => {
        const b = req.body;
        const check = validate('codes.task-start-request@1', b);
        if (!check.valid) return problem(req, res, 422, 'codes.task_invalid', check.errors.map((e) => `${e.instancePath || 'body'} ${e.message}`).join('; ').slice(0, 500));
        if (b.agent && !harnesses.list().some((a) => a.id === b.agent)) return problem(req, res, 422, 'codes.agent_unknown', 'agent is one of GET /api/v1/harnesses, or absent for the router to pick');
        const p = req.principal;
        const key = b.idempotency_key || null;
        if (key) {
            const seen = await byKey(p, key);
            if (seen) return res.status(200).json({ task: taskStore.present(await taskStore.refresh(seen)), created: false });
        }
        let args;
        try {
            args = parseArgs(JSON.stringify({
                repo: b.repo, ref: b.ref || null, prompt: b.prompt, agent: b.agent || null, permission: b.permission || 'edit',
                ...(b.push ? { push: { pull_request: b.pull_request === true } } : {}),
            }));
        } catch (e) {
            return problem(req, res, 422, 'codes.task_invalid', e.message);
        }
        const project = await taskStore.latestProject(p.subject);
        if (!project) {
            return problem(req, res, 409, 'codes.no_project', `this person has not run a task on ${config.baseUrl}/run yet: a service's task runs in the project of their latest one there, on a machine of theirs (openvibe.bot/machines)`);
        }
        let row;
        try {
            row = await taskStore.start({ subject: p.subject, project, args, via: p.via, key });
        } catch (e) {
            // Two requests with one key at once: the unique index lets one in; the other answers with it.
            const seen = key && e && e.code === '23505' ? await byKey(p, key) : null;
            if (!seen) throw e;
            return res.status(200).json({ task: taskStore.present(seen), created: false });
        }
        log.info(`[Codes] task ${row.id} started by ${p.via} for ${p.subject}: ${row.state}`);
        return res.status(201).json({ task: taskStore.present(row), created: true });
    });

    r.get('/tasks/:id', guard('codes.task.read'), actorLimits.reads('codes.read'), async (req, res) => {
        const row = await mine(req);
        if (!row) return problem(req, res, 404, 'codes.task_not_found', 'no such task of this service for this person');
        return res.json(taskStore.present(await taskStore.refresh(row)));
    });

    r.post('/tasks/:id/cancel', guard('codes.task.cancel'), actorLimits.budget('codes.task.start'), async (req, res) => {
        let row = await mine(req);
        if (!row) return problem(req, res, 404, 'codes.task_not_found', 'no such task of this service for this person');
        if (row.job_id && !TERMINAL.has(row.state)) {
            try { await run.cancel(row.job_id, taskStore.who(row)); } catch (e) { log.warn(`[Codes] cancel ${row.id}: ${e.message}`); }
            row = await taskStore.refresh(row, { force: true });
        }
        return res.json(taskStore.present(row));
    });

    return r;
}

module.exports = { createTasksApi };
