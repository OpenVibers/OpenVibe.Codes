'use strict';

/**
 * The service API for coding tasks (Contracts 0.162 codes.task.*, plan T16/T17), under /api/v1: a first-party
 * service (OpenVibe.Actor) starts a coding task for a person, who is named in X-OV-Subject, reads it and cancels it.
 * The task is the same one openvibe.codes/run starts (domain/run-tasks): an OpenVibe.Run job on the person's own
 * machine, in the project of their latest /run task.
 *
 *   POST /tasks              codes.task.start    codes.task-start-request@1 → codes.task-start-result@1 (201, or 200 again)
 *   GET  /tasks              codes.task.read     → { tasks: codes.task@1 … with its outcome } (the person's own; ?state=)
 *   GET  /tasks/:id          codes.task.read     → codes.task@2 (the task as codes.task@1, with its attempts and
 *                                                   its outcome added to it)
 *   POST /tasks/:id/cancel   codes.task.cancel   → codes.task@1
 *   GET  /tasks/:id/events   codes.task.read     → the task's event stream (server-sent events)
 *   POST /tasks/:id/continue codes.task.start    → the next attempt now (a switch when an agent is named)
 *   POST /tasks/:id/stop     codes.task.cancel   → the running attempt stops; nothing carries it on
 *
 * A Network service token for audience openvibe.codes (CODES_AUDIENCE), from a svc: principal holding the route's
 * capability. A service sees only the tasks it started, for that person; anything else is 404. The owner may read
 * and act on their own tasks without a token (the session cookie), or with their own Network access token as a Bearer
 * — the token openvibe.codes signs a person in with, and the one `openvibe-codes task` reads from OPENVIBE_TOKEN.
 * A person sees every task they own, whoever started it. Calls count against the person's own per-actor budget
 * (actor-limits.js), not the service's.
 *
 * Stage C2: a task's timeline is its attempts. GET /tasks/:id answers codes.task@2: the task itself with the same
 * fields it always had, and, added to them, its attempts and its outcome in plain words ("done", "unfinished" with
 * what is left, or "stopped"). GET /tasks/:id/events replays the session's lines in order — resumable with
 * Last-Event-ID, a heartbeat every 15 s — with the attempt each line belongs to.
 */
const express = require('express');
const { serviceAuth, capabilities, http, validate } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { parseArgs } = require('../../harness/job');
const { createRunTasks, TERMINAL } = require('../domain/run-tasks');
const { createTaskEvents } = require('./task-events');

const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const TASK = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;

function createTasksApi({ config, store, keys, run, harnesses, actorLimits, tasks = null, log = console }) {
    const r = asyncRouter();
    const db = store.db;
    const taskStore = tasks || createRunTasks({ store, run, config, log });
    const taskEvents = createTaskEvents({ store, config, log, attempts: taskStore.attempts });
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
        if (req.principal.owner) return db.maybe('SELECT * FROM run_tasks WHERE id = $1 AND subject = $2', [req.params.id, req.principal.subject]);
        return db.maybe('SELECT * FROM run_tasks WHERE id = $1 AND subject = $2 AND via = $3', [req.params.id, req.principal.subject, req.principal.via]);
    };
    const byKey = (p, key) => db.maybe('SELECT * FROM run_tasks WHERE subject = $1 AND via IS NOT DISTINCT FROM $2 AND idempotency_key = $3', [p.subject, p.via, key]);

    /** The owner (signed in, or their own access token as a Bearer), or a service token with the capability acting
     *  for the person in X-OV-Subject. */
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;

    /** A service, app, module or node token: its sub says so. Read (not verified) to send it to the service guard,
     *  so a principal token is never tried (and logged) as a person's. */
    const principalToken = (token) => {
        const parts = String(token || '').split('.');
        if (parts.length !== 3) return true;
        try {
            const c = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
            return ['service', 'app', 'mod', 'node'].includes(c.actor_type) || /^(svc|app|mod|node):/.test(String(c.sub || ''));
        } catch { return true; }
    };

    /**
     * The person a Network access token belongs to, or null. A person's token is issued for their session audience
     * (openvibe.network) and, when the Network is asked for the Codes audience, for openvibe.codes: either is accepted
     * here. A person token carries no capability claim: being that person is what authorizes their own tasks.
     */
    const personOf = async (token) => {
        if (!keys.loaded()) await keys.ensure();
        const v = await keys.verifyUser(token, { issuer: config.networkIssuer, audience: [config.oauth.sessionAudience, config.serviceAudience] });
        if (!v.ok) return null;
        const subject = typeof v.claims.subject_id === 'string' ? v.claims.subject_id : null;
        return USER.test(subject || '') ? subject : null;
    };

    const guardAny = (cap) => async (req, res, next) => {
        const header = String(req.headers.authorization || '');
        if (header.startsWith('Bearer ')) {
            const token = header.slice(7).trim();
            if (principalToken(token)) return guard(cap)(req, res, next);
            const subject = await personOf(token);
            if (subject) {
                req.principal = { sub: `user:${subject}`, subject, via: 'user', owner: true };
                return next();
            }
            return problem(req, res, 401, 'token.invalid', 'that token is not a person’s Network access token');
        }
        if (signedIn(req)) {
            req.principal = { sub: `user:${req.viewer.subject}`, subject: req.viewer.subject, via: null, owner: true };
            return next();
        }
        return problem(req, res, 401, 'token.required', `${cap} needs a Network service token for ${config.serviceAudience}, or a signed-in owner`);
    };

    /** The task, its attempts and its outcome in plain words. The task's own fields stay at the top level. */
    const timeline = async (row) => {
        const attempts = await taskStore.attempts.list(row.id);
        return {
            ...taskStore.present(row),
            attempts: attempts.map((a) => taskStore.attempts.present(a)),
            outcome: { state: row.outcome || null, note: row.outcome_note || null },
        };
    };

    r.post('/tasks', guardAny('codes.task.start'), actorLimits.budget('codes.task.start'), json, async (req, res) => {
        const b = req.body;
        // Actor back-reference: the contract does not carry these yet, so they are stripped before validation and stored
        // separately. When the contract is amended, pass them through instead.
        const actorRef = {};
        if (typeof b.actor_task_id === 'string') actorRef.task_id = b.actor_task_id;
        if (typeof b.actor_step_id === 'string') actorRef.step_id = b.actor_step_id;
        const bodyForValidate = { ...b };
        delete bodyForValidate.actor_task_id;
        delete bodyForValidate.actor_step_id;
        const check = validate('codes.task-start-request@1', bodyForValidate);
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
            row = await taskStore.start({ subject: p.subject, project, args, via: p.via, key, actorRef: Object.keys(actorRef).length ? actorRef : null });
        } catch (e) {
            // Two requests with one key at once: the unique index lets one in; the other answers with it.
            const seen = key && e && e.code === '23505' ? await byKey(p, key) : null;
            if (!seen) throw e;
            return res.status(200).json({ task: taskStore.present(seen), created: false });
        }
        log.info(`[Codes] task ${row.id} started by ${p.via} for ${p.subject}: ${row.state}`);
        return res.status(201).json({ task: taskStore.present(row), created: true });
    });

    /**
     * The caller's tasks, newest first: the person's own (whoever started them), or the ones this service started for
     * the person. ?state=narrows it to the words `openvibe-codes task list` prints: running (queued, placed, running),
     * needs (the engine left it unfinished for the person), done (ended, and not unfinished).
     */
    const LIST_LIMIT = 100;
    r.get('/tasks', guardAny('codes.task.read'), actorLimits.reads('codes.read'), async (req, res) => {
        const p = req.principal;
        const state = String(req.query.state || '').trim();
        if (state && !['running', 'needs', 'done'].includes(state)) return problem(req, res, 422, 'codes.task_invalid', 'state is running, needs or done');
        const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), LIST_LIMIT);
        const where = p.owner ? { sql: 'subject = $1', args: [p.subject] } : { sql: 'subject = $1 AND via = $2', args: [p.subject, p.via] };
        if (state === 'running') where.sql += " AND state IN ('queued', 'placed', 'running')";
        if (state === 'needs') where.sql += " AND outcome = 'unfinished'";
        if (state === 'done') where.sql += " AND state IN ('succeeded', 'failed', 'cancelled', 'expired') AND outcome IS DISTINCT FROM 'unfinished'";
        const rows = await db.many(`SELECT * FROM run_tasks WHERE ${where.sql} ORDER BY created_at DESC LIMIT $${where.args.length + 1}`, [...where.args, limit]);
        return res.json({ tasks: rows.map((row) => ({ ...taskStore.present(row), outcome: { state: row.outcome || null, note: row.outcome_note || null } })) });
    });

    r.get('/tasks/:id', guardAny('codes.task.read'), actorLimits.reads('codes.read'), async (req, res) => {
        const row = await mine(req);
        if (!row) return problem(req, res, 404, 'codes.task_not_found', 'no such task of this service for this person');
        return res.json(await timeline(await taskStore.refresh(row)));
    });

    /** The task's event stream: the session's lines in order, resumable with Last-Event-ID, plus the attempts. */
    r.get('/tasks/:id/events', guardAny('codes.task.read'), actorLimits.reads('codes.read'), async (req, res) => {
        const row = await mine(req);
        if (!row) return problem(req, res, 404, 'codes.task_not_found', 'no such task of this service for this person');
        return await taskEvents.stream(req, res, row);
    });

    /** The next attempt now: the owner carries the task on, or hands it to another agent. */
    r.post('/tasks/:id/continue', guardAny('codes.task.start'), actorLimits.budget('codes.task.start'), json, async (req, res) => {
        const row = await mine(req);
        if (!row) return problem(req, res, 404, 'codes.task_not_found', 'no such task of this service for this person');
        const b = req.body || {};
        const note = typeof b.note === 'string' ? b.note.slice(0, 4000) : null;
        const agent = typeof b.agent === 'string' && b.agent ? b.agent : null;
        if (agent && !harnesses.list().some((a) => a.id === agent)) return problem(req, res, 422, 'codes.agent_unknown', 'agent is one of GET /api/v1/harnesses');
        const out = await taskStore.continueTask(row, { note, agent });
        if (out.error) return problem(req, res, 409, 'codes.task_conflict', out.error);
        log.info(`[Codes] task ${row.id} carried on (${agent ? `with ${agent}` : 'by the owner'})`);
        return res.json(await timeline(out.row));
    });

    /** The running attempt stops: the outcome is "stopped" and nothing carries it on. */
    r.post('/tasks/:id/stop', guardAny('codes.task.cancel'), actorLimits.budget('codes.task.start'), async (req, res) => {
        const row = await mine(req);
        if (!row) return problem(req, res, 404, 'codes.task_not_found', 'no such task of this service for this person');
        const out = await taskStore.stopTask(row);
        if (out.error) return problem(req, res, 409, 'codes.task_conflict', out.error);
        log.info(`[Codes] task ${row.id} stopped by ${req.principal.via || req.principal.subject}`);
        return res.json(await timeline(out.row));
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
