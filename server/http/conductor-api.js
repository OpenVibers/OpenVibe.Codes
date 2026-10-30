'use strict';

/**
 * The conductor's API (Codes C9b), under /api/v1. A conductor is one long-lived Claude Code session on a machine the
 * person chose; a turn is a message, and each turn resumes the session. The approve MCP tool (bin/mcp.js) and
 * `openvibe-codes mcp` speak these routes with the person's own Network token.
 *
 *   POST /conductor                          create it (folder, machine?, model?, safety?, note?)
 *   GET  /conductor/:id                      the conductor, its one attempt and its turns
 *   POST /conductor/:id/messages             a message: the next turn, queued while one runs
 *   POST /conductor/:id/stop                 stop the running turn and everything queued
 *   POST /conductor/:id/tasks                a sub-task on another harness (never Anthropic: see below)
 *   GET  /tasks/:id/lines?limit=20           the last lines of a task's session (what `codes_task_show` prints)
 *   GET  /tasks/:id/messages/:mid/attachments/:i   one image, for the machine to write as a file
 *   POST /tasks/:id/approvals                the approve MCP asks the person (tool, input, summary)
 *   GET  /tasks/:id/approvals/:aid?wait=1    the decision, long-polled
 *   GET  /approvals                          the person's waiting approvals, across tasks
 *   POST /approvals/:id                      the decision: allow or deny
 *
 * Who is asking: the signed-in person (the session cookie), or their own Network access token as a Bearer — the token
 * `openvibe-codes task` reads from ~/.config/openvibe/token. Always the person's own rows; another person's task is 404.
 *
 * The rule: the conductor may start sub-tasks on any agent except an Anthropic one. codes.task_start refuses
 * claude-code, claude-other and an Anthropic model: the conductor is the only Anthropic session in the system. A
 * sub-task with no agent named is `auto` (Codes C9c): the router reads the fleet and picks the agent with room, never
 * a fixed one and never an Anthropic one.
 */

const express = require('express');
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { parseArgs } = require('../../harness/job');

const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const TASK = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const MESSAGE = /^msg_[0-9A-HJKMNP-TV-Z]{26}$/;
const APPROVAL = /^apr_[0-9A-HJKMNP-TV-Z]{26}$/;
const ANTHROPIC_AGENTS = new Set(['claude-code', 'claude-other']);
const ANTHROPIC_MODEL = /(^|[^a-z])(claude|opus|sonnet|haiku|anthropic)([^a-z]|$)/i;
const WAIT_MS = 20_000;
const WAIT_POLL_MS = 750;

function createConductorApi({ config, store, keys, harnesses, tasks, conductor, approvals, machines = null, fleet = null, actorLimits, log = console }) {
    const r = asyncRouter();
    const db = store.db;
    const problem = (req, res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const json = express.json({ limit: '12mb' });          // four 2 MB images, base64
    const small = express.json({ limit: '64kb' });
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const sameOrigin = (req) => {
        const origin = req.get('origin');
        if (!origin) return true;
        try { return new URL(origin).origin === new URL(config.baseUrl).origin; } catch { return false; }
    };

    /** The person a Network access token belongs to, or null (the same check the tasks API makes). */
    async function personOf(token) {
        if (!keys.loaded()) await keys.ensure();
        const v = await keys.verifyUser(token, { issuer: config.networkIssuer, audience: [config.oauth.sessionAudience, config.serviceAudience] });
        if (!v.ok) return null;
        const subject = typeof v.claims.subject_id === 'string' ? v.claims.subject_id : null;
        return USER.test(subject || '') ? subject : null;
    }

    /** The signed-in person, or their own Bearer → req.person { subject, token }. A service token is not accepted. */
    const person = async (req, res, next) => {
        const header = String(req.headers.authorization || '');
        if (header.startsWith('Bearer ')) {
            const token = header.slice(7).trim();
            const subject = await personOf(token);
            if (!subject) return problem(req, res, 401, 'token.invalid', 'that is not a person’s Network access token');
            req.person = { subject, token };
            return next();
        }
        if (signedIn(req)) {
            req.person = { subject: req.viewer.subject, token: req.viewer.token || null };
            return next();
        }
        return problem(req, res, 401, 'token.required', 'sign in, or send your Network access token as a Bearer');
    };

    /** The person's own task, or null. */
    const ownTask = async (req, id) => {
        if (!TASK.test(String(id))) return null;
        return await db.maybe('SELECT * FROM run_tasks WHERE id = $1 AND subject = $2', [id, req.person.subject]);
    };
    const ownConductor = async (req, id) => {
        const row = await ownTask(req, id);
        return row && row.kind === 'conductor' ? row : null;
    };

    /**
     * The project a conductor runs in: the person's first project they may delegate in (created when they have none),
     * read from Network with their own token; a person whose token cannot read Network falls back to the project of
     * their latest task, and is told when there is none.
     */
    async function projectFor(req) {
        return await conductor.projectFor(req.person.token, req.person.subject);
    }

    /** The machine is one of the person's own, when Network can say (it places on their machines only, either way). */
    async function machineProblem(req, machine) {
        if (!machine || !machines || !req.person.token) return null;
        try {
            const out = await machines.list(req.person.token);
            if (!out.ok) return null;
            const hit = (out.machines || []).find((m) => m.id === machine || m.node_id === machine);
            if (!hit) return 'that machine is not one of yours';
            if (hit.state === 'revoked') return 'that machine is revoked: pair it again';
            return null;
        } catch { return null; }
    }

    /**
     * The machine a conductor runs on, pinned (Codes C9c): its OpenVibe.Bot device id (`dev_…`), which is what Run
     * places a job on. Network knows the machine by its principal (`nod_…`); Bot's list names both. A machine Codes
     * cannot find there, or a Bot that does not answer, is a problem — a conductor must never fall back to running
     * wherever Run likes, because its folder and its memory are on the chosen machine.
     */
    async function pinFor(req, machine) {
        if (!fleet) return { problem: { status: 503, code: 'conductor.machine_unpinned', detail: 'Codes cannot pin a conductor to a machine here' } };
        let hit;
        try {
            hit = await fleet.deviceFor(req.person.token, machine);
        } catch (e) {
            log.warn(`[Codes] conductor: ${machine} could not be pinned: ${String(e && e.message).slice(0, 200)}`);
            return { problem: { status: 503, code: 'conductor.machine_unpinned', detail: 'OpenVibe.Bot did not answer, so Codes cannot pin the conductor to that machine; a conductor runs where its folder is, never wherever' } };
        }
        if (!hit) return { problem: { status: 422, code: 'conductor.machine_invalid', detail: 'that machine is not on openvibe.bot/machines: add it there, so a conductor can run where its folder is' } };
        if (!hit.online) return { problem: { status: 409, code: 'conductor.machine_offline', detail: `${hit.name || 'that machine'} is offline: a conductor starts on the machine its folder is on` } };
        return { device: hit.device };
    }

    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

    r.post('/conductor', person, actorLimits.budget('codes.task.start'), small, async (req, res) => {
        if (!sameOrigin(req)) return problem(req, res, 403, 'cross_site', 'cross-site JSON posts are refused');
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const folder = typeof b.folder === 'string' ? b.folder.trim() : '';
        const machine = typeof b.machine === 'string' && b.machine ? b.machine : null;
        const bad = await machineProblem(req, machine);
        if (bad) return problem(req, res, 422, 'conductor.machine_invalid', bad);
        const pin = machine ? await pinFor(req, machine) : { device: null };
        if (pin.problem) return problem(req, res, pin.problem.status, pin.problem.code, pin.problem.detail);
        const project = await projectFor(req);
        if (!project) return problem(req, res, 409, 'codes.no_project', 'start one task at ' + config.baseUrl + '/run first: a conductor runs in your project, on your machine');
        try {
            const made = await conductor.create({
                subject: req.person.subject, project, folder, machine, pin: pin.device,
                model: typeof b.model === 'string' && b.model ? b.model : 'opus',
                safety: typeof b.safety === 'string' && b.safety ? b.safety : 'ask',
                note: typeof b.note === 'string' ? b.note : null,
            });
            log.info(`[Codes] conductor ${made.task.id} started for ${req.person.subject}`);
            return res.status(201).json(await conductor.view(made.task));
        } catch (e) {
            return problem(req, res, e.status || 500, e.code || 'conductor.failed', String((e && e.message) || 'the conductor could not start'));
        }
    });

    r.get('/conductor/:id', person, actorLimits.reads('codes.read'), async (req, res) => {
        const row = await ownConductor(req, req.params.id);
        if (!row) return problem(req, res, 404, 'codes.task_not_found', 'no such conductor of yours');
        return res.json(await conductor.view(await tasks.refresh(row)));
    });

    r.post('/conductor/:id/messages', person, actorLimits.budget('codes.task.start'), json, async (req, res) => {
        if (!sameOrigin(req)) return problem(req, res, 403, 'cross_site', 'cross-site JSON posts are refused');
        const row = await ownConductor(req, req.params.id);
        if (!row) return problem(req, res, 404, 'codes.task_not_found', 'no such conductor of yours');
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        try {
            const out = await conductor.message(row, { text: b.text, attachments: b.attachments });
            return res.status(201).json({
                message: conductor.presentMessage(out.message),
                started: !!(out.started && out.started.job),
                task: tasks.present(await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [row.id])),
            });
        } catch (e) {
            return problem(req, res, e.status || 500, e.code || 'conductor.message_failed', String((e && e.message) || 'the message could not be sent'));
        }
    });

    r.post('/conductor/:id/stop', person, actorLimits.budget('codes.task.start'), async (req, res) => {
        if (!sameOrigin(req)) return problem(req, res, 403, 'cross_site', 'cross-site posts are refused');
        const row = await ownConductor(req, req.params.id);
        if (!row) return problem(req, res, 404, 'codes.task_not_found', 'no such conductor of yours');
        const out = await conductor.stop(row);
        if (out.error) return problem(req, res, 409, 'codes.task_conflict', out.error);
        return res.json(await conductor.view(out.row));
    });

    /**
     * A sub-task on another harness. The rule: never an Anthropic one — that is the conductor's session alone. An
     * unnamed agent is `auto`: the router picks among the agents the fleet says have room, never a fixed one.
     */
    r.post('/conductor/:id/tasks', person, actorLimits.budget('codes.task.start'), small, async (req, res) => {
        if (!sameOrigin(req)) return problem(req, res, 403, 'cross_site', 'cross-site JSON posts are refused');
        const row = await ownConductor(req, req.params.id);
        if (!row) return problem(req, res, 404, 'codes.task_not_found', 'no such conductor of yours');
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
        if (!prompt) return problem(req, res, 422, 'codes.task_invalid', 'a sub-task needs a prompt');
        const named = typeof b.agent === 'string' && b.agent.trim() ? b.agent.trim() : null;
        const wanted = named && named !== 'auto' ? named : null;
        const model = typeof b.model === 'string' && b.model ? b.model : null;
        if ((wanted && (ANTHROPIC_AGENTS.has(wanted) || ANTHROPIC_MODEL.test(wanted))) || (model && ANTHROPIC_MODEL.test(model))) {
            return problem(req, res, 422, 'conductor.anthropic_subtask', 'the conductor may start sub-tasks on any agent except an Anthropic one: it is the only Anthropic session here');
        }
        const agent = wanted;
        if (agent && !harnesses.list().some((h) => h.id === agent)) return problem(req, res, 422, 'codes.agent_unknown', `agent is one of GET /api/v1/harnesses, and not an Anthropic one`);
        if (typeof b.repo !== 'string' || !/^https:\/\//.test(b.repo)) return problem(req, res, 422, 'codes.task_invalid', 'a sub-task needs the repository it works in (https://…)');
        let args;
        try {
            args = parseArgs(JSON.stringify({ repo: b.repo, ref: b.ref || null, prompt, ...(agent ? { agent } : {}), ...(model ? { model } : {}), permission: 'edit' }));
        } catch (e) {
            return problem(req, res, 422, 'codes.task_invalid', e.message);
        }
        const task = await tasks.start({ subject: req.person.subject, project: row.project_id, args, via: 'conductor', key: null, actorRef: { conductor: { task_id: row.id } } });
        log.info(`[Codes] conductor ${row.id} started sub-task ${task.id} on ${agent || 'auto'}`);
        return res.status(201).json({ task: { ...tasks.present(task), outcome: { state: task.outcome || null, note: task.outcome_note || null } } });
    });

    /** The last lines of a task's session, newest last: what `codes_task_show` prints as its tail. */
    r.get('/tasks/:id/lines', person, actorLimits.reads('codes.read'), async (req, res) => {
        const row = await ownTask(req, req.params.id);
        if (!row) return problem(req, res, 404, 'codes.task_not_found', 'no such task of yours');
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const rows = await db.many(
            'SELECT seq, at, kind, body FROM codes_session_lines WHERE task_id = $1 ORDER BY seq DESC LIMIT $2', [row.id, limit],
        );
        return res.json({ task_id: row.id, lines: rows.reverse().map((l) => ({ seq: Number(l.seq), at: l.at, kind: l.kind, body: l.body })) });
    });

    /** One attached image, as its bytes: the machine writes it as a file for the turn. */
    r.get('/tasks/:id/messages/:mid/attachments/:i', person, async (req, res) => {
        const row = await ownTask(req, req.params.id);
        if (!row || !MESSAGE.test(String(req.params.mid))) return problem(req, res, 404, 'codes.task_not_found', 'no such attachment');
        const file = await conductor.attachment(row.id, req.params.mid, Number(req.params.i));
        if (!file) return problem(req, res, 404, 'codes.attachment_not_found', 'no such attachment');
        res.set('Content-Type', file.mime);
        res.set('Content-Disposition', `inline; filename="${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
        return res.send(file.buffer);
    });

    /** The approve MCP asks: one waiting approval for a tool call in this task. */
    r.post('/tasks/:id/approvals', person, actorLimits.budget('codes.task.start'), small, async (req, res) => {
        if (!sameOrigin(req)) return problem(req, res, 403, 'cross_site', 'cross-site JSON posts are refused');
        const row = await ownTask(req, req.params.id);
        if (!row) return problem(req, res, 404, 'codes.task_not_found', 'no such task of yours');
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        try {
            const made = await approvals.create({ task: row, tool: b.tool, input: b.input, summary: b.summary });
            return res.status(201).json(approvals.present(made));
        } catch (e) {
            return problem(req, res, e.status || 500, e.code || 'approval.failed', String((e && e.message) || 'the approval could not be asked'));
        }
    });

    /** The answer, long-polled: a decision at once, or within 20 s; ?wait=0 answers what is there now. */
    r.get('/tasks/:id/approvals/:aid', person, actorLimits.reads('codes.read'), async (req, res) => {
        const row = await ownTask(req, req.params.id);
        if (!row || !APPROVAL.test(String(req.params.aid))) return problem(req, res, 404, 'approval.not_found', 'no such approval');
        const wait = String(req.query.wait || '1') !== '0';
        const until = Date.now() + WAIT_MS;
        let found = await approvals.get(row.id, req.params.aid);
        while (found && !found.decision && wait && Date.now() < until) {
            await new Promise((done) => setTimeout(done, WAIT_POLL_MS));
            found = await approvals.get(row.id, req.params.aid);
        }
        if (!found) return problem(req, res, 404, 'approval.not_found', 'no such approval');
        return res.json(approvals.present(found));
    });

    r.get('/approvals', person, actorLimits.reads('codes.read'), async (req, res) => {
        const rows = await approvals.inbox(req.person.subject);
        return res.json({ approvals: rows.map((a) => approvals.present(a)) });
    });

    r.post('/approvals/:id', person, actorLimits.budget('codes.task.start'), small, async (req, res) => {
        if (!sameOrigin(req)) return problem(req, res, 403, 'cross_site', 'cross-site JSON posts are refused');
        if (!APPROVAL.test(String(req.params.id))) return problem(req, res, 404, 'approval.not_found', 'no such approval');
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const decision = b.decision === 'allow' ? 'allow' : b.decision === 'deny' ? 'deny' : null;
        if (!decision) return problem(req, res, 422, 'approval.decision_invalid', 'decision is allow or deny');
        const row = await approvals.decideAny(req.person.subject, req.params.id, { decision, message: b.message });
        if (!row) return problem(req, res, 404, 'approval.not_found', 'no such approval of yours');
        log.info(`[Codes] approval ${row.id} ${row.decision} by ${req.person.subject}`);
        return res.json(approvals.present(row));
    });

    return r;
}

module.exports = { createConductorApi, ANTHROPIC_AGENTS, ANTHROPIC_MODEL };
