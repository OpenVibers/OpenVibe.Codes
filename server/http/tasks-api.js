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
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { expandMatrix } = require('../domain/bench');
const childReport = require('../domain/child-report');
const { readMultipart, isMultipart } = require('./upload');
const { corsOpenVibe } = require('./openvibe-origins');
const start = require('./start');

const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const TASK = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const FIL = /^fil_[0-9A-HJKMNP-TV-Z]{26}$/;
// The Dock's Code tab shape (the home composer's three ways, as JSON): POST /tasks dispatches on it.
const DOCK_MODES = ['create', 'openvibe', 'repo'];

function createTasksApi({ config, store, keys, run, harnesses, actorLimits, tasks = null, fleet = null, sharing = null, conductor = null, attachments = null, log = console }) {
    const r = asyncRouter();
    const db = store.db;
    const taskStore = tasks || createRunTasks({ store, run, config, log });
    const taskEvents = createTaskEvents({ store, config, log, attempts: taskStore.attempts });
    const problem = (req, res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const json = express.json({ limit: '32kb' });
    // The Dock's Code tab calls these from another OpenVibe site with the person's bearer token: an allowed origin
    // is reflected so the page may read the answer (server/http/openvibe-origins.js). Only the Dock's own two
    // routes: another router's preflight must fall through to its own answer.
    r.use(corsOpenVibe({ methods: 'GET, POST, OPTIONS', paths: ['/tasks', /^\/tasks\/[^/]+\/stop$/, /^\/me\/agents\/[^/]+\/sheet$/] }));
    const benchTokens = config.oauth.clientSecret ? createServiceTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret, audience: 'openvibe.bench', scope: 'bench.run.publish',
    }) : null;

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

    /**
     * A read of a task: the caller's own (as before), or one shared with them (design 2026-11-06, canView). A service
     * token stays scoped to the tasks it started for the person; sharing is between people.
     */
    const viewable = async (req) => {
        const own = await mine(req);
        if (own) return own;
        if (!sharing || !req.principal.owner || !TASK.test(String(req.params.id))) return null;
        const any = await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [req.params.id]);
        if (!any) return null;
        const allowed = await sharing.canView({ subject: req.principal.subject }, any.id).catch(() => false);
        return allowed ? any : null;
    };

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
        // A conductor's child hands its parent the shaped report (path, ≤5 bullets, BLOCKED/CONCERNS);
        // anything else has none to give, and says nothing.
        const report = childReport.of(row);
        return {
            ...taskStore.present(row),
            attempts: attempts.map((a) => taskStore.attempts.present(a)),
            outcome: { state: row.end_state || row.outcome || null, note: row.outcome_note || null },
            ...(report ? { report } : {}),
        };
    };

    /**
     * The fleet (Codes C9c): each of the person's machines' agents and limit windows, read from OpenVibe.Bot with the
     * person's own token and kept here. A signed-in visitor or their own access token; never a service acting for
     * someone (a machine's windows are the person's own account).
     */
    r.get('/fleet', actorLimits.reads('codes.read'), async (req, res) => {
        let subject = null;
        let token = null;
        if (signedIn(req)) { subject = req.viewer.subject; token = req.viewer.token || null; }
        else {
            const header = String(req.headers.authorization || '');
            if (header.startsWith('Bearer ') && !principalToken(header.slice(7).trim())) {
                token = header.slice(7).trim();
                subject = await personOf(token);
            }
        }
        if (!subject) return problem(req, res, 401, 'token.required', 'sign in, or send your own Network access token, to read your fleet');
        if (!fleet) return res.json({ ok: false, machines: [], agents: [], problem: { status: 503, detail: 'the fleet is not configured here' } });
        let out;
        try { out = await fleet.refresh(subject, token); } catch (e) {
            if (e.status === 401) return problem(req, res, 401, 'token.invalid', 'the session expired: sign in again');
            out = { ok: false, problem: { status: e.status || 503, detail: String(e.message || 'the fleet could not be read').slice(0, 300) } };
        }
        const agents = await fleet.agents(subject, harnesses);
        const latest = await fleet.latest(subject);
        return res.json({ ok: out.ok !== false, machines: latest.machines, agents, at: latest.at, ...(out.problem ? { problem: out.problem } : {}) });
    });

    // One read for a coding harness on the person's machines. Attempts, not the task's initial agent, decide
    // attribution: a task may switch harnesses midway. Codes has no per-harness memory or schedule records.
    r.get('/me/agents/:id/sheet', guardAny('codes.task.read'), actorLimits.reads('codes.read'), async (req, res) => {
        if (!req.principal.owner) return problem(req, res, 403, 'codes.agent_owner_required', 'sign in as the owner to read this agent');
        const id = String(req.params.id || '');
        const offer = /^[a-z][a-z0-9-]{0,63}$/.test(id) && harnesses.list().find((item) => item.id === id);
        if (!offer) return problem(req, res, 404, 'codes.agent_not_found', 'no such coding agent');
        const fleetRows = fleet ? await fleet.agents(req.principal.subject, harnesses) : [];
        const availability = fleetRows.find((row) => row.agent === id) || null;
        const rows = await db.many(`SELECT a.id, a.task_id, a.n, a.state, a.why, a.reason, a.cost_usd,
                a.machine, a.started_at, a.finished_at, a.created_at, t.prompt, t.repo, t.outcome, t.outcome_note
            FROM codes_attempts a JOIN run_tasks t ON t.id = a.task_id
            WHERE t.subject = $1 AND a.agent = $2 ORDER BY a.created_at DESC LIMIT 100`, [req.principal.subject, id]);
        const work = rows.map((row) => ({
            id: row.id, task_id: row.task_id, title: String(row.prompt || '').replace(/\s+/g, ' ').slice(0, 240),
            what: row.why || null, result: row.outcome_note || row.reason || null, state: row.state,
            outcome: row.outcome || null, cost_usd: row.cost_usd == null ? null : Number(row.cost_usd),
            machine: row.machine || null, repo: row.repo || null, started_at: row.started_at || row.created_at,
            finished_at: row.finished_at || null, url: `${config.baseUrl}/tasks/${row.task_id}`,
        }));
        const now = work.find((row) => ['queued', 'running'].includes(row.state)) || null;
        const activity = Object.values(work.reduce((days, row) => {
            const day = String(row.started_at).slice(0, 10);
            (days[day] ||= { day, entries: [] }).entries.push({ task_id: row.task_id, what: row.what || row.title, result: row.result, outcome: row.outcome, cost_usd: row.cost_usd, url: row.url });
            return days;
        }, {}));
        return res.set('Cache-Control', 'private, no-store').json({
            agent: { id, name: offer.name, face: null, state: now ? 'working' : availability && availability.state || 'idle',
                kind: 'coding harness', availability },
            now, work, activity, asks: [], asks_empty: 'Requests to approve coding work will appear here when this agent needs you.',
            computer: null, schedules: [], memory: [], identity: { provider: offer.provider || null, capabilities: offer.capabilities || {} },
        });
    });

    /**
     * The Dock's Code tab start (the home composer's three ways, as JSON): { text, mode, repo?, attachments? }.
     * Only the owner starts one this way (a session, or their own Network token); a service keeps the
     * codes.task-start-request@1 shape below. The checks, limits and quota are the site's own (POST /chat): the
     * words, the repository, the project, and the files — all refused before any task is started.
     */
    async function dockCreate(req, res) {
        const p = req.principal;
        if (!p.owner) return problem(req, res, 422, 'codes.task_invalid', 'services start tasks with codes.task-start-request@1 (a prompt and a repo)');
        let b = req.body || {};
        let uploaded = [];
        if (isMultipart(req)) {
            if (!attachments) return problem(req, res, 503, 'codes.attachments_unavailable', 'file uploads are not configured here');
            try {
                const parsed = await readMultipart(req, { maxBytes: attachments.MAX_MESSAGE_BYTES });
                b = parsed.fields || {};
                uploaded = parsed.files || [];
            } catch (e) { return problem(req, res, e.status || 500, e.code || 'codes.task_invalid', String((e && e.message) || 'the form could not be read').slice(0, 300)); }
        }
        const first = (v) => (Array.isArray(v) ? v[0] : v);
        const text = String(first(b.text) || '').trim().slice(0, 16000);
        const mode = String(first(b.mode) || '').trim();
        if (!DOCK_MODES.includes(mode)) return problem(req, res, 422, 'codes.task_invalid', 'mode is create, openvibe or repo');
        if (!text) return problem(req, res, 422, 'codes.task_invalid', 'write what you want made or changed first');
        const repoIn = String(first(b.repo) || '').trim().slice(0, 500);
        const named = [
            ...(Array.isArray(b.attachments) ? b.attachments : b.attachments ? [b.attachments] : []),
            ...(Array.isArray(b.attachment_ids) ? b.attachment_ids : b.attachment_ids ? [b.attachment_ids] : []),
        ].map(String).filter(Boolean);
        // Something new: OpenVibe AI builds it on openvibe.space, like the site's own handover. No Codes task is
        // started: the answer is where to press Build. Files ride with a task, never with a handover.
        if (mode === 'create') {
            if (repoIn || named.length || uploaded.length) {
                return problem(req, res, 422, 'codes.create_invalid', 'Something new starts in OpenVibe AI, where you can add the repository and the files there.');
            }
            return res.json({ id: null, url: start.spaceHref({ text }) });
        }
        // The files this task carries: uploaded before send by their ids, or posted with the form now (no
        // JavaScript). A limit or a program is refused before any task is started; an id from outside Codes names
        // where it resolves (composer.attachment@1, once OpenVibe.Media serves it).
        let ids = [];
        if (named.length || uploaded.length) {
            if (!attachments) return problem(req, res, 503, 'codes.attachments_unavailable', 'file uploads are not configured here');
            const foreign = named.find((id) => !FIL.test(id));
            if (foreign) return problem(req, res, 422, 'codes.attachment_unresolved', `attach ${foreign.slice(0, 40)} on openvibe.codes first: shared library files arrive with composer.attachment@1`);
            try {
                const saved = uploaded.length ? await attachments.saveMany(p.subject, uploaded) : [];
                const pending = await attachments.pending(p.subject, [...saved.map((f) => f.id), ...named]);
                ids = pending.map((f) => f.id);
            } catch (e) { return problem(req, res, e.status || 500, e.code || 'codes.task_invalid', String((e && e.message) || 'the files could not be attached').slice(0, 300)); }
        }
        // Which repository the task works on: one of OpenVibe's own projects, or the person's own address.
        let targets = null;
        let repoUrl = '';
        if (mode === 'openvibe') {
            if (repoIn) {
                const hit = start.PROJECTS.find((x) => x.repository === repoIn || x.url === start.normalizeRepo(repoIn));
                if (!hit) return problem(req, res, 422, 'codes.repo_unknown', 'pick one of OpenVibe\u2019s own projects, or name yours with mode repo');
                repoUrl = hit.url;
            } else {
                const found = start.matchProjects(text);
                if (!found.length) {
                    return problem(req, res, 422, 'codes.project_unknown', 'say which OpenVibe site this is for, in your own words (like Live, Chat or Games, or \u201cthe navbar\u201d), or pick it from the list');
                }
                targets = found;
                repoUrl = found[0].url;
            }
        } else {
            repoUrl = start.normalizeRepo(repoIn);
            if (!repoUrl) {
                return problem(req, res, 422, 'codes.task_invalid', repoIn
                    ? 'That is not a Git address Codes can clone: use https://\u2026, git@host:owner/name or owner/name, with no password in it.'
                    : 'Pick a repository (owner/name or any Git URL), choose an OpenVibe site, or start something new.');
            }
        }
        let args;
        try {
            args = parseArgs(JSON.stringify({ repo: repoUrl, prompt: text, permission: 'edit' }));
        } catch (e) {
            return problem(req, res, 422, 'codes.task_invalid', e.message);
        }
        const header = String(req.headers.authorization || '');
        const token = req.token || (req.viewer && req.viewer.token) || (header.startsWith('Bearer ') ? header.slice(7).trim() : null);
        let project = null;
        try {
            project = await taskStore.latestProject(p.subject)
                || (conductor ? await conductor.projectFor(token, p.subject) : null);
        } catch { project = null; }
        if (!project) return problem(req, res, 409, 'codes.no_project', 'Codes could not find or make a project for you on OpenVibe.Services: sign in again and retry.');
        const jobInput = (repo, prompt) => JSON.stringify({ repo, prompt, permission: 'edit' });
        let firstRow = null;
        try {
            if (targets && targets.length > 1) {
                // One request across several projects: a task for each, each told what the others are, like the site.
                const names = targets.map((x) => x.repository.replace(/^OpenVibers\//, ''));
                for (const [i, x] of targets.entries()) {
                    const note = `\n\n(This request spans ${names.join(', ')}. This task is the ${names[i]} part; the others are separate tasks. Change only what this repository needs, and keep the names and behaviour consistent with the other parts.)`;
                    const each = parseArgs(jobInput(x.url, `${text}${note}`.slice(0, 16000)));
                    const row = await taskStore.start({ subject: p.subject, project, args: each, attachmentIds: i === 0 ? ids : [], mode: 'openvibe' });
                    if (!firstRow) firstRow = row;
                }
            } else {
                firstRow = await taskStore.start({ subject: p.subject, project, args, attachmentIds: ids, mode: mode === 'openvibe' ? 'openvibe' : 'repo' });
            }
        } catch (e) {
            return problem(req, res, e.status || 502, e.code || 'codes.task_failed', String((e && e.message) || 'the task could not start').slice(0, 300));
        }
        log.info(`[Codes] task ${firstRow.id} started from the Dock for ${p.subject} (${mode})`);
        return res.status(201).json({ id: firstRow.id, url: `${config.baseUrl}/tasks/${firstRow.id}` });
    }

    r.post('/tasks', guardAny('codes.task.start'), actorLimits.budget('codes.task.start'), json, async (req, res) => {
        const b = req.body;
        // The Dock's shape takes its own path; services and the site shape keep the contract below.
        if ((b && b.mode != null) || isMultipart(req)) return dockCreate(req, res);
        // Actor back-reference: the contract does not carry these yet, so they are stripped before validation and stored
        // separately. When the contract is amended, pass them through instead.
        const actorRef = {};
        if (typeof b.actor_task_id === 'string') actorRef.task_id = b.actor_task_id;
        if (typeof b.actor_step_id === 'string') actorRef.step_id = b.actor_step_id;
        const bodyForValidate = { ...b };
        delete bodyForValidate.actor_task_id;
        delete bodyForValidate.actor_step_id;
        delete bodyForValidate.goal;
        delete bodyForValidate.effort;
        const check = validate('codes.task-start-request@1', bodyForValidate);
        if (!check.valid) return problem(req, res, 422, 'codes.task_invalid', check.errors.map((e) => `${e.instancePath || 'body'} ${e.message}`).join('; ').slice(0, 500));
        let goal = null;
        if (b.goal != null) {
            if (!config.goals.enabled) return problem(req, res, 409, 'codes.goals_disabled', 'goal tasks are disabled');
            const g = b.goal, limits = g && g.budget || {};
            if (!g || typeof g !== 'object' || Array.isArray(g) || typeof g.goal !== 'string' || !g.goal.trim() || g.goal.length > 4000 || !g.check || !['command', 'url', 'rubric'].includes(g.check.kind) || typeof g.check.value !== 'string' || !g.check.value.trim() || g.check.value.length > 4000) return problem(req, res, 422, 'codes.goal_invalid', 'goal requires a condition and a typed check');
            if (!limits || typeof limits !== 'object' || Array.isArray(limits) || Object.entries(limits).some(([k, v]) => !['tokens', 'turns', 'active_minutes'].includes(k) || !Number.isInteger(v) || v < 1) || (g.no_progress_limit != null && (!Number.isInteger(g.no_progress_limit) || g.no_progress_limit < 1 || g.no_progress_limit > 20))) return problem(req, res, 422, 'codes.goal_invalid', 'goal budgets and no-progress limit must be positive bounded integers');
            goal = { goal: g.goal.trim(), check: { kind: g.check.kind, value: g.check.value.trim() }, budget: limits, no_progress_limit: g.no_progress_limit || 3, proposal: null, evidence: null, verdict: null };
        }
        if (b.agent && !harnesses.list().some((a) => a.id === b.agent)) return problem(req, res, 422, 'codes.agent_unknown', 'agent is one of GET /api/v1/harnesses, or absent for the router to pick');
        // The effort the task asks for (ai.effort@1 plus xhigh; auto is the harness default, resolved by AI's own
        // role and task defaults on the AI path). The contract does not carry it yet, so like the goal above it is
        // stripped before validation; when the contract is amended, pass it through instead.
        const effort = b.effort == null || b.effort === '' ? null : String(b.effort);
        if (effort != null && !['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return problem(req, res, 422, 'codes.effort_invalid', 'effort is auto, low, medium, high, xhigh or max');
        const p = req.principal;
        const key = b.idempotency_key || null;
        if (key) {
            const seen = await byKey(p, key);
            if (seen) return res.status(200).json({ task: taskStore.present(await taskStore.refresh(seen)), created: false });
        }
        let args;
        try {
            args = parseArgs(JSON.stringify({
                repo: b.repo, ref: b.ref || null, prompt: b.prompt, agent: b.agent || null, permission: b.permission || 'edit', ...(goal ? { goal } : {}),
                ...(effort ? { effort } : {}),
                ...(b.push ? { push: { pull_request: b.pull_request === true } } : {}),
            }));
        } catch (e) {
            return problem(req, res, 422, 'codes.task_invalid', e.message);
        }
        const project = await taskStore.latestProject(p.subject);
        if (!project) {
            return problem(req, res, 409, 'codes.no_project', `this person has not run a task on ${config.baseUrl}/run yet: a service's task runs in the project of their latest one there, on a machine of theirs (openvibe.my/#machines)`);
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

    // Bench is the only caller: it supplies a service token for Codes plus the signed-in user's short-lived
    // Network token in a private server-to-server header. The latter is used only to provision the user's own project.
    r.post('/benchmarks/:id/run', guardAny('codes.task.start'), json, async (req, res) => {
        const p = req.principal;
        if (p.owner) return problem(req, res, 403, 'codes.bench_service_required', 'Bench starts verified benchmark tasks.');
        const userToken = String(req.get('x-ov-user-token') || '').trim();
        const user = await keys.verifyUser(userToken, { issuer: config.networkIssuer, audience: config.oauth.sessionAudience });
        if (!user.ok || user.claims.subject_id !== p.subject) return problem(req, res, 403, 'codes.bench_subject_mismatch', 'The signed-in person must match X-OV-Subject.');
        if (!benchTokens) return problem(req, res, 503, 'codes.bench_unconfigured', 'Codes has no Network client credentials for Bench.');
        const b = req.body || {};
        const models = Array.isArray(b.models) ? b.models.map(String) : [];
        const requestedHarnesses = Array.isArray(b.harnesses) ? b.harnesses.map(String) : [];
        const repeat = Number(b.repeat);
        if (!models.length || !requestedHarnesses.length || !Number.isInteger(repeat) || repeat < 1 || repeat > 10
            || models.some((m) => !m || m.length > 120) || new Set(requestedHarnesses).size !== requestedHarnesses.length) {
            return problem(req, res, 422, 'codes.bench_invalid', 'models and harnesses are required; repeat must be 1–10.');
        }
        const available = new Set(harnesses.list().map((h) => h.id));
        if (requestedHarnesses.some((h) => !available.has(h))) return problem(req, res, 422, 'codes.bench_harness_unknown', 'A harness is not in GET /api/v1/harnesses.');
        let definition;
        try {
            const response = await fetch(`${config.bench.url}/api/v1/benchmarks/${encodeURIComponent(String(req.params.id))}`, {
                headers: { ...(await benchTokens.authHeaders()), Accept: 'application/json' }, signal: AbortSignal.timeout(15000),
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) return problem(req, res, response.status, body.code || 'codes.bench_definition_failed', body.detail || 'Bench did not return the benchmark definition.');
            definition = body.definition;
        } catch (e) { return problem(req, res, 503, 'codes.bench_unavailable', `Bench did not answer: ${e.message}`); }
        let matrix;
        try { matrix = expandMatrix(definition, models, requestedHarnesses, repeat); }
        catch (e) { return problem(req, res, 422, e.code || 'codes.bench_empty', e.message); }
        if (!matrix.length) return problem(req, res, 422, 'codes.bench_empty', 'The benchmark has no tasks.');
        const total = matrix.length;
        if (total > config.bench.maxMatrixSize) return problem(req, res, 422, 'codes.bench_matrix_too_large', `This matrix has ${total} tasks; the limit is ${config.bench.maxMatrixSize}.`);
        const running = Number(await db.value("SELECT COUNT(*)::int AS n FROM (SELECT actor_ref->'bench'->>'session' AS session FROM run_tasks WHERE subject = $1 AND actor_ref ? 'bench' GROUP BY actor_ref->'bench'->>'session' HAVING bool_or(state NOT IN ('succeeded','failed','cancelled','expired'))) active", [p.subject]));
        if (running >= 3) return problem(req, res, 429, 'codes.bench_concurrency_limit', 'A person may have at most three benchmark runs active.');
        const today = store.now() - (store.now() % 86400000);
        const daily = Number(await db.value("SELECT COUNT(*)::int AS n FROM run_tasks WHERE subject = $1 AND actor_ref ? 'bench' AND created_at >= $2", [p.subject, today]));
        if (daily + total > config.bench.dailyTasks) return problem(req, res, 429, 'codes.bench_daily_limit', `The daily benchmark task cap is ${config.bench.dailyTasks}.`);

        let project;
        try {
            const headers = { Authorization: `Bearer ${userToken}`, Accept: 'application/json' };
            const projectsResponse = await fetch(`${config.networkInternalUrl}/api/v1/projects`, { headers, signal: AbortSignal.timeout(8000) });
            if (!projectsResponse.ok) throw new Error(`Network answered ${projectsResponse.status}`);
            const projects = (await projectsResponse.json()).projects || [];
            project = projects.find((x) => x.name === 'bench' && !x.archived_at)?.id;
            if (!project) {
                const created = await fetch(`${config.networkInternalUrl}/api/v1/projects`, {
                    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'bench' }), signal: AbortSignal.timeout(8000),
                });
                if (!created.ok) throw new Error(`Network answered ${created.status}`);
                project = (await created.json()).id;
            }
        } catch (e) { return problem(req, res, 502, 'codes.bench_project_failed', `Could not get or create the person's bench project: ${e.message}`); }

        const session = `${req.params.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        const started = [];
        const runIds = new Map();
        try {
            for (const cell of matrix) {
                const { task, model, harness, repetition } = cell;
                const key = `${model}\u0000${harness}\u0000${repetition}`;
                if (!runIds.has(key)) runIds.set(key, store.newId('brn'));
                const runId = runIds.get(key);
                const harnessOffer = harnesses.list().find((h) => h.id === harness);
                const inputs = Array.isArray(task.files) ? JSON.stringify(task.files).slice(0, 3000) : '';
                const prompt = `Benchmark ${b.benchmark || req.params.id}, task ${task.id}.\n\n${String(task.prompt).slice(0, 10000)}${inputs ? `\n\nInput files:\n${inputs}` : ''}\n\nReturn only the requested artifact content. Respect the per-task limits: ${Number(definition.limits && definition.limits.ms) || 0} ms, ${Number(definition.limits && definition.limits.tokens) || 0} tokens, $${Number(definition.limits && definition.limits.usd) || 0}.`;
                const limits = definition.limits || {};
                const args = parseArgs(JSON.stringify({ kind: 'bench', prompt, agent: harness, model, limits }));
                const taskRow = await taskStore.start({ subject: p.subject, project, args, via: p.via,
                    actorRef: { bench: { run_id: runId, task_count: matrix.filter((x) => x.model === model && x.harness === harness && x.repetition === repetition).length, benchmark: `${req.params.id}@${Number(definition.version) || 1}`, session, model, provider: (harnessOffer && harnessOffer.provider) || String(model).split('/')[0] || 'unknown', harness, harness_version: (harnessOffer && harnessOffer.version) || 'unknown', repetition, task_id: String(task.id), kind: definition.kind, expected: task.expected, judges: definition.judges || [], scoring: definition.scoring || {}, limits: definition.limits || {} } } });
                started.push(taskStore.present(taskRow));
            }
        } catch (e) { return problem(req, res, 502, 'codes.bench_start_failed', `Codes started ${started.length} of ${total} tasks: ${e.message}`); }
        return res.status(202).json({ session, tasks: started, task: started[0] || null, total: started.length });
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
        return res.json({ tasks: rows.map((row) => ({ ...taskStore.present(row), outcome: { state: row.end_state || row.outcome || null, note: row.outcome_note || null } })) });
    });

    r.get('/tasks/:id', guardAny('codes.task.read'), actorLimits.reads('codes.read'), async (req, res) => {
        const row = await viewable(req);
        if (!row) return problem(req, res, 404, 'codes.task_not_found', 'no such task of this service for this person');
        return res.json(await timeline(await taskStore.refresh(row)));
    });

    /** The task's event stream: the session's lines in order, resumable with Last-Event-ID, plus the attempts. */
    r.get('/tasks/:id/events', guardAny('codes.task.read'), actorLimits.reads('codes.read'), async (req, res) => {
        const row = await viewable(req);
        if (!row) return problem(req, res, 404, 'codes.task_not_found', 'no such task of this service for this person');
        return await taskEvents.stream(req, res, row);
    });

    const agentRuns = require('../agent-ui/codes').createCodesRuns({ store, fallback: require('../agent-ui/titles').createTitleFallback({ config, clean: require('../agent-ui/codes').clean }) });
    r.get('/runs/:id', guardAny('codes.task.read'), actorLimits.reads('codes.read'), async (req, res) => {
        const match = /^(tsk_[0-9A-HJKMNP-TV-Z]{26})(?:~([1-9][0-9]*))?$/.exec(req.params.id);
        const attempt = match && match[2] ? Number(match[2]) : null;
        if (match) req.params.id = match[1];
        const task = await viewable(req);
        const row = task && await agentRuns.resolve(task, attempt);
        if (!row) return problem(req, res, 404, 'codes.task_not_found', 'no such task of this service for this person');
        if (!(config.agentUiSetting ? config.agentUiSetting() : config.agentUi)) return problem(req, res, 404, 'codes.runs_disabled', 'Run streams are disabled.');
        return res.json(await agentRuns.snapshot(row));
    });
    r.get('/runs/:id/events', guardAny('codes.task.read'), actorLimits.reads('codes.read'), async (req, res) => {
        const match = /^(tsk_[0-9A-HJKMNP-TV-Z]{26})(?:~([1-9][0-9]*))?$/.exec(req.params.id);
        const attempt = match && match[2] ? Number(match[2]) : null;
        if (match) req.params.id = match[1];
        const task = await viewable(req);
        const row = task && await agentRuns.resolve(task, attempt);
        if (!row) return problem(req, res, 404, 'codes.task_not_found', 'no such task of this service for this person');
        if (!(config.agentUiSetting ? config.agentUiSetting() : config.agentUi)) return problem(req, res, 404, 'codes.runs_disabled', 'Run streams are disabled.');
        return agentRuns.stream(req, res, row);
    });

    /** The next attempt now: the owner carries the task on, or hands it to another agent. */
    r.post('/tasks/:id/continue', guardAny('codes.task.start'), actorLimits.budget('codes.task.start'), json, async (req, res) => {
        const row = await mine(req);
        if (!row) return problem(req, res, 404, 'codes.task_not_found', 'no such task of this service for this person');
        const b = req.body || {};
        const note = typeof b.note === 'string' ? b.note.slice(0, 4000) : null;
        const agent = typeof b.agent === 'string' && b.agent ? b.agent : null;
        if (agent && !harnesses.list().some((a) => a.id === agent)) return problem(req, res, 422, 'codes.agent_unknown', 'agent is one of GET /api/v1/harnesses');
        const EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
        const model = typeof b.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\/#-]{0,99}$/.test(b.model) ? b.model : null;
        const effort = EFFORTS.includes(b.effort) ? b.effort : null;
        const out = await taskStore.continueTask(row, { note: note || (typeof b.text === 'string' ? b.text.slice(0, 4000) : null), agent, model, effort });
        if (out.error) return problem(req, res, 409, 'codes.task_conflict', out.error);
        // One continuation at a time: an attempt that is already live answers this press, and no second one starts.
        if (!out.live) log.info(`[Codes] task ${row.id} carried on (${agent ? `with ${agent}` : 'by the owner'})`);
        return res.json(await timeline(out.row));
    });

    /**
     * The running attempt stops: the outcome is "stopped" and nothing carries it on. The owner (the Dock's shape)
     * gets { ok }; a service keeps the timeline its capability was built on. Another person's task is 404, never
     * a refusal that says it exists.
     */
    r.post('/tasks/:id/stop', guardAny('codes.task.cancel'), actorLimits.budget('codes.task.start'), async (req, res) => {
        const row = await mine(req);
        if (!row) return problem(req, res, 404, 'codes.task_not_found', 'no such task of this service for this person');
        const out = await taskStore.stopTask(row);
        if (out.error) return problem(req, res, 409, 'codes.task_conflict', out.error);
        log.info(`[Codes] task ${row.id} stopped by ${req.principal.via || req.principal.subject}`);
        if (req.principal.owner) return res.json({ ok: true });
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
