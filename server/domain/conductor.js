'use strict';

/**
 * The conductor (Codes C9b): a long-lived task whose single attempt is one agent session on a machine the person
 * chooses. The agent is their "Who leads your tasks" choice (Claude Code on Opus by default, migration 0030). It is the
 * orchestrator that used to be a Claude Code session on the workstation, running in openvibe.codes.
 *
 *   createConductor({ store, config, log, run, attempts, tasks, sessions, approvals, notify, fetchImpl })
 *     create({ subject, project, folder, machine, model, safety, note })  the task, its one attempt and the hand-over turn
 *     message(task, { text, attachments })                                  a message: the next turn, queued while one runs
 *     onTurnEnd(taskId)                                                     a turn ended: land its message, start the next
 *     stop(task, { subject })                                               stop the running turn; nothing carries on
 *     view(task)                                                            the conductor as its page shows it
 *     presentMessage(message)                                               one turn as the API shows it
 *     fragment()                                                            the first-turn text (engine/fragments/conductor.md)
 *
 * One task, one attempt, many turns. The attempt keeps the session id; each turn is a Run job that resumes it
 * (`claude --resume`), so the conductor keeps its context across messages. A message waits in codes_conductor_messages
 * while a turn runs; when the turn ends the next queued message starts. A conductor is never "done": when a turn ends
 * and nothing waits, it is idle (state succeeded, outcome NULL) until the person writes again.
 *
 * The conductor uses the person's own login on the machine (Node's plan_logins, opt-in and read-only, for one job) and
 * never a key of ours. It sets no steps or minutes budget; a turn's wall time is Run's job cap.
 *
 * Failover (owner 2026-11-03, conductor-failover.js): before each turn the conductor's agent and the fallbacks the
 * person chose in Settings are read against their machine's usage windows; the turn runs on the first with room under
 * the switch point, and goes back to the primary once its window frees. Each agent keeps its own session (the turn's
 * row records the agent, the model and the session it ended with), and an agent that takes over is first told what
 * happened in the conversation since it last took part.
 */

const fs = require('fs');
const path = require('path');
const failover = require('./conductor-failover');
const { windowFull } = require('../../engine/router');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const MESSAGE_STATES = ['queued', 'running', 'done', 'failed', 'stopped'];
const SAFETY = ['ask', 'project', 'full'];
const MODEL = /^[A-Za-z0-9._:-]{1,100}$/;
const NODE = /^(?:nod_)?[0-9A-HJKMNP-TV-Z]{26}$/;
const FRAGMENT = path.join(__dirname, '..', '..', 'engine', 'fragments', 'conductor.md');
const MAX_MESSAGE = 16000;
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 50 * 1024 * 1024;
/** The legacy inline path (an image as base64 in the JSON body): four small images, as before the upload API. */
const MAX_INLINE_ATTACHMENTS = 4;
const MAX_INLINE_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_NOTE = 4000;
const MAX_FOLDER = 4096;
/** The most of the conversation an agent taking over is told, so the turn stays inside a job's 16,000 characters. */
const MAX_CATCH_UP = 9000;
/** A fleet reading older than this is read again when the person writes (their token is at hand then). */
const FLEET_FRESH_MS = 5 * 60_000;
const PRIMARY_AGENT = 'claude-code';

const iso = (v) => {
    if (!v) return null;
    const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const asObject = (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); return p && typeof p === 'object' && !Array.isArray(p) ? p : null; } catch { return null; } }
    return null;
};
const asArray = (v) => (Array.isArray(v) ? v : (Array.isArray(v && v.items) ? v.items : []));

/** The folder a conductor may open: absolute, no control characters, a real place. */
function validFolder(folder) {
    const f = String(folder || '').trim();
    if (!f || f.length > MAX_FOLDER) return null;
    if (/[\0-\x1f\x7f]/.test(f)) return null;
    if (!f.startsWith('/')) return null;
    return f;
}

/**
 * The legacy attachments (an image as base64 in the JSON body), still accepted from an old client: four small images.
 * A new client uploads first and sends `attachment_ids`, which attachments.js stores and checks.
 */
function cleanAttachments(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const a of list.slice(0, MAX_INLINE_ATTACHMENTS)) {
        if (!a || typeof a !== 'object') continue;
        const name = String(a.name || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
        const mime = String(a.mime || '').toLowerCase();
        const data = typeof a.data === 'string' ? a.data.replace(/^data:[^;]+;base64,/, '') : '';
        if (!name || !/^image\//.test(mime) || !data) continue;
        let bytes = 0;
        try { bytes = Buffer.from(data, 'base64').length; } catch { bytes = 0; }
        if (!bytes || bytes > MAX_INLINE_ATTACHMENT_BYTES) continue;
        out.push({ name, mime, data, size: bytes });
    }
    return out;
}

/** The agent and the session a turn's job reported (its result log's agent line; the job's own session field). */
function ranOf(result) {
    const d = asObject(result) || {};
    const log = Array.isArray(d.log) ? d.log : [];
    let agent = null; let session = null;
    for (const line of log) {
        if (!line || typeof line !== 'object' || line.t !== 'agent') continue;
        if (!agent && line.agent) agent = String(line.agent).slice(0, 40);
        if (!session && line.session) session = String(line.session).slice(0, 200);
    }
    if (!agent && Array.isArray(d.agents) && d.agents[0]) agent = String(d.agents[0]).slice(0, 40);
    if (!session && typeof d.session === 'string' && d.session) session = d.session.slice(0, 200);
    return { agent, session };
}

const agentOf = (m) => (m && m.agent) || PRIMARY_AGENT;

function createConductor({ store, config = {}, log = console, run, attempts, tasks, sessions, approvals = null, notify = null, fetchImpl = null, fleet = null, userSettings = null, harnesses = null, attachments: filesStore = null }) {
    const db = store.db;
    const fetch = fetchImpl || globalThis.fetch;
    const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
    const wallMs = Math.max(60_000, Number(config.conductor && config.conductor.wallMs) || 4 * 60 * 60_000);

    function fragment() {
        try { return fs.readFileSync(FRAGMENT, 'utf8'); } catch { return 'You are the OpenVibe orchestrator. Carry on the work in /home/workstation/openvibe from RESUME-2026-10-30.md, through the codes MCP tools.\n'; }
    }

    /**
     * The project a conductor runs in: the person's first project they may delegate in (created when they have none),
     * read from Network with their own token. A person whose token cannot read Network falls back to the project of
     * their latest task; null when there is none, and the caller says so.
     */
    async function projectFor(token, subject) {
        if (token) {
            try {
                const list = await fetch(`${String(config.networkInternalUrl || '').replace(/\/+$/, '')}/api/v1/projects`, {
                    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(8000),
                });
                if (list.ok) {
                    const projects = ((await list.json()).projects || []).filter((p) => ['owner', 'admin'].includes(p.role) && !p.archived_at);
                    if (projects.length) return projects[0].id;
                    const made = await fetch(`${String(config.networkInternalUrl || '').replace(/\/+$/, '')}/api/v1/projects`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                        body: JSON.stringify({ name: 'Conductor' }), signal: AbortSignal.timeout(8000),
                    });
                    if (made.ok) return (await made.json()).id;
                }
            } catch (e) {
                log.warn(`[Codes] conductor: the projects of ${subject} could not be read: ${String(e && e.message).slice(0, 160)}`);
            }
        }
        return await tasks.latestProject(subject);
    }

    /**
     * The agent and model a conductor leads with: the person's pick when they made one, else the "Who leads your tasks"
     * setting, else today's choice (Claude Code on Opus). A model is only ever paired with an agent that takes it:
     * Claude Code keeps Opus unless another model is named, and every other agent uses its own default.
     */
    async function leadFor(subject, agent = null, model = undefined) {
        let settings = null;
        if (userSettings && subject) { try { settings = await userSettings.get(subject); } catch { settings = null; } }
        const chosen = agent || (settings && settings.conductor_agent) || PRIMARY_AGENT;
        let chosenModel;
        if (model !== undefined) chosenModel = model === '' ? null : model;
        else if (settings && settings.conductor_agent && !agent) chosenModel = settings.conductor_model;
        else chosenModel = chosen === PRIMARY_AGENT ? 'opus' : null;
        if (chosenModel == null && chosen === PRIMARY_AGENT) chosenModel = 'opus';
        return { agent: chosen, model: chosenModel == null ? null : String(chosenModel).slice(0, 100) };
    }

    /** A task's own pick wins over the setting: the conductor page may retarget one conversation, not every one. */
    async function retarget(task, { agent = null, model = undefined } = {}) {
        if (!task || !task.id) throw Object.assign(new Error('no such conductor'), { status: 404, code: 'conductor.not_found' });
        if (agent == null && model === undefined) return task;
        const lead = await leadFor(task.subject, agent || task.agent, model === undefined ? (agent ? undefined : task.model) : model);
        if (!lead.agent || (harnesses && !harnesses.list().some((h) => h.id === lead.agent))) {
            throw Object.assign(new Error('the agent that leads this conductor is one Codes offers'), { status: 422, code: 'conductor.agent_invalid' });
        }
        if (lead.model != null && !MODEL.test(String(lead.model))) throw Object.assign(new Error('the model is not a model name'), { status: 422, code: 'conductor.model_invalid' });
        const row = await db.one('UPDATE run_tasks SET agent = $2, model = $3, updated_at = $4 WHERE id = $1 RETURNING *',
            [task.id, lead.agent, lead.model == null ? null : String(lead.model).slice(0, 100), store.now()]);
        const attempt = await attemptOf(task.id);
        if (attempt) await db.exec('UPDATE codes_attempts SET agent = $2, model = $3 WHERE id = $1', [attempt.id, lead.agent, lead.model == null ? null : String(lead.model).slice(0, 100)]);
        return row;
    }

    /** The one attempt of a conductor task. */
    async function attemptOf(taskId) {
        return await db.maybe('SELECT * FROM codes_attempts WHERE task_id = $1 ORDER BY n ASC LIMIT 1', [taskId]);
    }

    /**
     * Create the conductor: the task row, its one attempt and the hand-over turn. The first turn starts at once
     * (startNext), so a person who pressed "Start your conductor" sees it begin to work. A chosen machine is also
     * `pin`, its OpenVibe.Bot device id (`dev_…`, Codes C9c): every turn is pinned to it on Run, so the session runs
     * where its folder and its memory are.
     */
    async function create({ subject, project, folder, machine = null, pin = null, agent = null, model = undefined, safety = 'ask', note = null, key = null, attachmentIds = [] } = {}) {
        const work = validFolder(folder);
        if (!work) throw Object.assign(new Error('the working folder must be an absolute path'), { status: 422, code: 'conductor.folder_invalid' });
        const lead = await leadFor(subject, agent, model);
        if (!lead.agent || (harnesses && !harnesses.list().some((h) => h.id === lead.agent))) {
            throw Object.assign(new Error('the agent that leads this conductor is one Codes offers'), { status: 422, code: 'conductor.agent_invalid' });
        }
        if (lead.model != null && !MODEL.test(String(lead.model))) throw Object.assign(new Error('the model is not a model name'), { status: 422, code: 'conductor.model_invalid' });
        if (!SAFETY.includes(safety)) throw Object.assign(new Error('safety is ask, project or full'), { status: 422, code: 'conductor.safety_invalid' });
        if (machine && !NODE.test(String(machine))) throw Object.assign(new Error('the machine is not one of the person\'s machines'), { status: 422, code: 'conductor.machine_invalid' });
        if (pin != null && !/^dev_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(pin))) throw Object.assign(new Error('the pin is not a machine id'), { status: 422, code: 'conductor.machine_invalid' });
        if (!subject) throw Object.assign(new Error('a conductor belongs to a person'), { status: 422, code: 'conductor.subject_required' });

        const first = fragment() + (note && String(note).trim() ? `\n\n---\n\n## What the owner asked now\n\n${String(note).trim().slice(0, MAX_NOTE)}\n` : '');
        const id = store.newId('tsk');
        const at = store.now();
        const repo = `conductor://${work}`.slice(0, 300);
        let row;
        await store.tx(async () => {
            row = await db.one(
                `INSERT INTO run_tasks (id, subject, project_id, repo, prompt, agent, model, kind, folder, machine, pin, safety, state, idempotency_key, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'conductor', $8, $9, $10, $11, 'queued', $12, $13, $13) RETURNING *`,
                [id, subject, project, repo, first.slice(0, 16000), lead.agent, lead.model == null ? null : String(lead.model).slice(0, 100), work, machine || null, pin || null, safety, key || null, at],
            );
        });
        await attempts.create({
            task: row, agent: lead.agent, model: lead.model == null ? null : String(lead.model).slice(0, 100), machine: machine || null,
            why: 'the conductor session starts here', kind: 'first', state: 'queued',
        });
        const message = await enqueue(row, { text: first, attachments: [], attachmentIds, first: true });
        const started = await startNext(id);
        return { task: await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [id]), message, started };
    }

    /** Write one message: the next turn. It waits if a turn is running. */
    async function enqueue(task, { text, attachments = [], attachmentIds = [], first = false } = {}) {
        const prompt = String(text == null ? '' : text).trim();
        const legacy = cleanAttachments(attachments);
        const claimed = filesStore ? await filesStore.pending(task.subject, attachmentIds) : [];
        const count = claimed.length + legacy.length;
        const total = claimed.reduce((n, a) => n + Number(a.size || 0), 0) + legacy.reduce((n, a) => n + Number(a.size || 0), 0);
        if (count > MAX_ATTACHMENTS) throw Object.assign(new Error(`a message carries at most ${MAX_ATTACHMENTS} files`), { status: 422, code: 'conductor.attachments_too_many' });
        if (total > MAX_MESSAGE_BYTES) throw Object.assign(new Error('the files of one message are larger than 50 MB together'), { status: 413, code: 'conductor.attachments_too_large' });
        if (!prompt && !count) throw Object.assign(new Error('a message needs words or a file'), { status: 422, code: 'conductor.message_empty' });
        if (prompt.length > MAX_MESSAGE) throw Object.assign(new Error(`a message is at most ${MAX_MESSAGE} characters`), { status: 422, code: 'conductor.message_too_long' });
        const files = [...claimed.map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: Number(a.size) })), ...legacy];
        const id = store.newId('msg');
        const made = await store.tx(async () => {
            const current = await db.maybe('SELECT * FROM run_tasks WHERE id = $1 FOR UPDATE', [task.id]);
            if (!current || current.kind !== 'conductor') throw Object.assign(new Error('no such conductor'), { status: 404, code: 'conductor.not_found' });
            if (current.outcome === 'stopped') throw Object.assign(new Error('this conductor was stopped: start a new one'), { status: 409, code: 'conductor.stopped' });
            const n = await db.one('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM codes_conductor_messages WHERE task_id = $1', [task.id]);
            const row = await db.one(
                `INSERT INTO codes_conductor_messages (id, task_id, n, prompt, attachments, state, created_at)
                 VALUES ($1, $2, $3, $4, $5::jsonb, 'queued', $6::timestamptz) RETURNING *`,
                [id, task.id, n.n, prompt || (first ? 'Begin.' : 'Look at the attached files.'), files.length ? JSON.stringify(files) : null, store.iso()],
            );
            if (claimed.length) await filesStore.link(task.subject, claimed, { taskId: task.id, attemptN: 1, messageId: id });
            return row;
        });
        return made;
    }

    /**
     * A message the person writes. Starts the turn when the conductor is idle; otherwise it waits. With the person's
     * token at hand, a fleet reading older than five minutes is read again first, so the turn's agent is chosen on
     * today's usage.
     */
    async function message(task, { text, attachments = [], attachmentIds = [], agent = null, model = undefined, token = null } = {}) {
        const current = (agent != null || model !== undefined) ? await retarget(task, { agent, model }) : task;
        const made = await enqueue(current, { text, attachments, attachmentIds });
        await refreshFleet(current.subject, token);
        const started = await startNext(current.id);
        return { message: made, started };
    }

    /**
     * The job input of one turn: the same folder and safety; the agent, model and session of the turn's choice (`over`,
     * from startNext), or the conductor's own agent and the session the attempt carries.
     */
    function turnArgs(task, message, attempt, over = null) {
        const files = Array.isArray(message.attachments) ? message.attachments : asArray(message.attachments);
        const agent = (over && over.agent) || task.agent || PRIMARY_AGENT;
        const model = over && 'model' in over ? over.model : (task.model == null ? null : task.model);
        const resume = over && 'resume' in over ? over.resume : (attempt && attempt.session) || null;
        return {
            kind: 'conductor',
            task_id: task.id,
            message_id: message.id,
            folder: task.folder,
            prompt: (over && over.prompt) || message.prompt,
            agent,
            ...(model ? { model } : {}),
            safety: task.safety || 'ask',
            mcp: true,
            codes_url: baseUrl,
            ...(resume ? { resume } : {}),
            // The file's bytes stay in the database: the job fetches it with the person's token and writes it under
            // .openvibe/attachments/<message>/<name> on the machine, so a turn's input stays far inside Run's limit.
            ...(files.length
                ? { attachments: files.map((a, i) => ({ name: a.name, mime: a.mime, size: a.size, dir: message.id, url: `${baseUrl}/api/v1/tasks/${encodeURIComponent(task.id)}/messages/${encodeURIComponent(message.id)}/attachments/${i}` })) }
                : {}),
        };
    }

    /** Read the person's machines again when the stored reading is older than FLEET_FRESH_MS. Never throws. */
    async function refreshFleet(subject, token) {
        if (!fleet || !token || typeof fleet.refresh !== 'function') return;
        try {
            const { at } = await fleet.latest(subject);
            const age = at ? Date.now() - Date.parse(at) : Infinity;
            if (Number.isFinite(age) && age < FLEET_FRESH_MS) return;
            await fleet.refresh(subject, token);
        } catch (e) {
            log.warn(`[Codes] conductor: the fleet of ${subject} could not be read: ${String(e && e.message).slice(0, 160)}`);
        }
    }

    /** The conductor's chain: its own agent and model, then the person's fallbacks (none twice). */
    async function chainFor(task) {
        let settings = null;
        if (userSettings) { try { settings = await userSettings.get(task.subject); } catch { settings = null; } }
        const agent = task.agent || (settings && settings.conductor_agent) || PRIMARY_AGENT;
        const model = task.model != null ? task.model : (agent === PRIMARY_AGENT ? ((settings && settings.conductor_agent === PRIMARY_AGENT && settings.conductor_model) || 'opus') : null);
        const primary = { agent, model };
        const fallbacks = (settings && settings.conductor_fallbacks) || [];
        const chain = [primary, ...fallbacks.filter((f) => !(f.agent === primary.agent && (f.model || null) === primary.model))];
        return { chain, switchPct: (settings && settings.conductor_switch_pct) || failover.DEFAULT_SWITCH_PCT };
    }

    /**
     * What the person's machines say about each agent: the machine the conductor is pinned to when it is (its folder and
     * sessions are there, so only its own agents count), else the best across their machines. null with no reading.
     */
    async function fleetFor(task) {
        if (!fleet) return null;
        try {
            if (task.pin) {
                const { machines } = await fleet.latest(task.subject);
                const here = (machines || []).find((m) => m.id === task.pin);
                if (!here || !here.agents.length) return null;
                const out = {};
                for (const a of here.agents) {
                    const windows = Array.isArray(a.windows) ? a.windows : [];
                    out[a.agent] = { installed: a.installed, signed_in: a.signed_in, windows, room: a.installed && a.signed_in && !windows.some((w) => windowFull(w)) };
                }
                return out;
            }
            const by = await fleet.byHarness(task.subject);
            return by && Object.keys(by).length ? by : null;
        } catch (e) {
            log.warn(`[Codes] conductor ${task.id}: the fleet could not be read: ${String(e && e.message).slice(0, 160)}`);
            return null;
        }
    }

    /** The choice for the next turn (conductor-failover.js choose), with the chain it was made from. */
    async function choiceFor(task) {
        const { chain, switchPct } = await chainFor(task);
        const reading = await fleetFor(task);
        return { ...failover.choose({ chain, fleet: reading, switchPct }), switchPct, chain };
    }

    /**
     * What an agent taking over is told first: who it is carrying on from, and the conversation since it last took
     * part (all of it, the hand-over brief first, when it never did) — each turn's message and answer, newest kept when
     * it is long.
     */
    function catchUp(earlier, agent, fromAgent, note) {
        const lastOwn = [...earlier].reverse().find((m) => agentOf(m) === agent && m.session);
        const since = lastOwn ? earlier.filter((m) => Number(m.n) > Number(lastOwn.n)) : earlier;
        if (!since.length) return '';
        const brief = !lastOwn && since[0] && Number(since[0].n) === 1 ? since[0] : null;
        const turns = since.filter((m) => m !== brief);
        const clip = (v, n) => { const t = String(v || '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
        const blocks = turns.map((m) => {
            const r = asObject(m.result);
            const answer = r && typeof r.summary === 'string' ? r.summary : (m.error ? `(the turn did not finish: ${m.error})` : '(no answer recorded)');
            return `### Turn ${m.n} — ${failover.nameOf(agentOf(m))}\n\n**The owner:** ${clip(m.prompt, 1200)}\n\n**The answer:** ${clip(answer, 1500)}`;
        });
        const briefText = brief ? clip(brief.prompt, 4000) : '';
        let budget = MAX_CATCH_UP - briefText.length;
        const kept = [];
        for (let i = blocks.length - 1; i >= 0; i--) {
            if (blocks[i].length > budget) break;
            kept.unshift(blocks[i]);
            budget -= blocks[i].length;
        }
        const dropped = blocks.length - kept.length;
        const head = `## You are taking over this conversation\n\nYou are the owner's conductor, carrying on from ${failover.nameOf(fromAgent)}${note ? ` (${note.replace(/\.$/, '')})` : ''}. Below is what happened ${lastOwn ? 'since you last took part' : 'so far'}; then the owner's new message. Carry on from there: the same plan, the same Codes tools.`;
        return [
            head,
            briefText ? `## The hand-over brief this conversation started with\n\n${briefText}` : '',
            dropped ? `(${dropped} earlier turn${dropped === 1 ? '' : 's'} left out for length.)` : '',
            kept.length ? `## The turns\n\n${kept.join('\n\n')}` : '',
            '---\n\n## The owner\'s new message\n',
        ].filter(Boolean).join('\n\n');
    }

    /**
     * Start the next queued message, if no turn is running. The task row is locked while the message is taken, so two
     * presses start one turn and not two.
     */
    async function startNext(taskId) {
        const taken = await store.tx(async () => {
            const task = await db.maybe('SELECT * FROM run_tasks WHERE id = $1 FOR UPDATE', [taskId]);
            if (!task || task.kind !== 'conductor') return { error: 'not a conductor' };
            if (task.outcome === 'stopped') return { stopped: true };
            const running = await db.maybe("SELECT id FROM codes_conductor_messages WHERE task_id = $1 AND state = 'running' LIMIT 1", [taskId]);
            if (running) return { running: true };
            const next = await db.maybe("SELECT * FROM codes_conductor_messages WHERE task_id = $1 AND state = 'queued' ORDER BY n ASC LIMIT 1", [taskId]);
            if (!next) return { idle: true };
            const attempt = await attemptOf(taskId);
            const message = await db.one("UPDATE codes_conductor_messages SET state = 'running', started_at = $2::timestamptz WHERE id = $1 RETURNING *", [next.id, store.iso()]);
            await db.exec(
                `UPDATE run_tasks SET state = 'queued', outcome = NULL, outcome_note = NULL, error = NULL, finished_at = NULL,
                    session_complete_at = NULL, updated_at = $2 WHERE id = $1`,
                [taskId, store.now()],
            );
            return { task, message, attempt };
        });
        if (taken.error || taken.running || taken.idle || taken.stopped) return taken;

        const { task, message: turn, attempt } = taken;
        // The agent this turn runs on (failover), the session it resumes, and — when it is not the agent of the last
        // turn — what happened in the conversation while it was away.
        let over = null;
        try {
            const choice = await choiceFor(task);
            const pick = choice.pick || { agent: task.agent || PRIMARY_AGENT, model: task.model == null ? null : task.model };
            const earlier = await db.many('SELECT * FROM codes_conductor_messages WHERE task_id = $1 AND n < $2 ORDER BY n ASC', [task.id, turn.n]);
            const ran = earlier.filter((m) => m.started_at);
            const previous = ran.length ? agentOf(ran[ran.length - 1]) : null;
            const own = [...ran].reverse().find((m) => agentOf(m) === pick.agent && m.session);
            let resume = own ? own.session : null;
            if (!resume && pick.agent === (task.agent || PRIMARY_AGENT) && !earlier.some((m) => m.agent)) resume = (attempt && attempt.session) || null;
            let prompt = turn.prompt;
            if (previous && previous !== pick.agent) {
                const intro = catchUp(ran, pick.agent, previous, choice.note);
                if (intro) prompt = `${intro}\n${turn.prompt}`.slice(0, MAX_MESSAGE);
            }
            over = { agent: pick.agent, model: pick.model, resume, prompt };
            await db.exec('UPDATE codes_conductor_messages SET agent = $2, model = $3, switch_note = $4 WHERE id = $1',
                [turn.id, pick.agent, pick.model || null, choice.note ? String(choice.note).slice(0, 1000) : null]);
            if (choice.note) log.info && log.info(`[Codes] conductor ${task.id}: ${choice.note}`);
        } catch (e) {
            log.warn(`[Codes] conductor ${task.id}: the failover could not choose, the turn runs on its own agent: ${String(e && e.message).slice(0, 200)}`);
            over = null;
        }
        let job;
        try {
            // Who leads can be an API harness too (DeepSeek, OpenVibe.AI, a local model): that turn is funded like a
            // coding task, with the person's own key or a run token. A plan CLI needs nothing here.
            const args = turnArgs(task, turn, attempt, over);
            let funding = null;
            try { funding = await tasks.fundTurn({ subject: task.subject, taskId: task.id, attemptId: attempt ? attempt.id : null, agent: args.agent }); } catch (e) {
                log.warn(`[Codes] conductor ${task.id}: the turn could not be funded (${String(e && e.message).slice(0, 160)})`);
            }
            if (funding && funding.env && Object.keys(funding.env).length) args.env = funding.env;
            if (funding && attempt) await attempts.bind(attempt.id, { run_mode: funding.mode });
            job = await run.submit({
                subject: task.subject, project: task.project_id, args, key: turn.id,
                limits: { wall_ms: wallMs, cpu_ms: wallMs, mem_bytes: 4 * 1024 ** 3 }, ttlMs: Math.min(86_400_000, wallMs + 10 * 60_000),
                // Pinned to the machine the person chose (Codes C9c): the turn resumes a session whose folder and
                // memory are there, so Run must not place it anywhere else.
                node: task.pin || null,
            });
        } catch (e) {
            const why = String((e && (e.detail || e.message)) || 'the turn could not start').slice(0, 500);
            await store.tx(async () => {
                await db.exec("UPDATE codes_conductor_messages SET state = 'failed', error = $2, finished_at = $3::timestamptz WHERE id = $1", [turn.id, why, store.iso()]);
                await db.exec("UPDATE run_tasks SET state = 'failed', error = $2, outcome = 'unfinished', outcome_note = $3, finished_at = $4::timestamptz, updated_at = $5 WHERE id = $1",
                    [task.id, why, `the turn could not start: ${why}`, store.iso(), store.now()]);
            });
            log.warn(`[Codes] conductor ${task.id}: the turn could not start: ${why}`);
            return { error: why };
        }
        await store.tx(async () => {
            if (attempt) await attempts.bind(attempt.id, { job_id: job.id, state: 'queued', machine: task.machine, model: (over && over.model) || task.model });
            await db.exec("UPDATE codes_conductor_messages SET job_id = $2 WHERE id = $1", [turn.id, job.id]);
            await db.exec(
                `UPDATE run_tasks SET job_id = $2, state = $3, started_at = COALESCE($4::timestamptz, started_at), updated_at = $5 WHERE id = $1`,
                [task.id, job.id, job.state || 'queued', (job.timings && job.timings.started_at) || null, store.now()],
            );
        });
        pump(await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [task.id]), job, attempt).catch((e) => log.warn(`[Codes] conductor ${task.id} stream: ${String(e && e.message).slice(0, 200)}`));
        return { message: turn, job, attempt };
    }

    /**
     * Follow the turn's Run stream and record its lines as codes_session_lines, so the C2 SSE shows the transcript
     * even when no browser opened the Run page. When the stream ends, read the job once and apply it (the events
     * consumer would too; both are idempotent).
     */
    async function pump(task, job, attempt) {
        if (!run || typeof run.streamUrl !== 'function' || !sessions || !task) return;
        const url = await run.streamUrl(job.id, tasks.who(task));
        const response = await fetch(url, { headers: { Accept: 'text/event-stream' }, signal: AbortSignal.timeout(wallMs + 60_000) });
        if (!response.ok || !response.body) return;
        const recorder = sessions.recorder(task.id, { attemptN: attempt ? Number(attempt.n) : 1 });
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
            if (!url) break;
            try { await recorder.push(decoder.decode(chunk, { stream: true })); } catch (e) { log.warn(`[Codes] conductor ${task.id} lines: ${e.message}`); }
        }
        try { await recorder.push(decoder.decode()); await recorder.flush(); } catch { /* the stream said what it could */ }
        if (recorder.ended()) {
            try {
                const fresh = await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [task.id]);
                if (fresh && !TERMINAL.has(fresh.state)) {
                    const doc = await run.read(job.id, tasks.who(task));
                    await tasks.applyJob(fresh, doc);
                }
            } catch (e) { log.warn(`[Codes] conductor ${task.id}: ${String(e && e.message).slice(0, 200)}`); }
        }
    }

    /**
     * A turn ended. Land the message of the job that ended (done or failed), keep the session, and start the next
     * queued message. With nothing queued the conductor is idle: state succeeded, outcome NULL. A turn that failed
     * leaves the conductor "unfinished" so its page says what went wrong, and the next message still resumes the
     * session.
     *
     * `jobId` is the Run job whose end this is. A late delivery for a turn that is no longer the task's job changes
     * nothing: the next turn's job has already taken the task's job_id (startNext), so a second, racing call is a no-op.
     */
    async function onTurnEnd(taskId, jobId = null) {
        const result = await store.tx(async () => {
            const task = await db.maybe('SELECT * FROM run_tasks WHERE id = $1 FOR UPDATE', [taskId]);
            if (!task || task.kind !== 'conductor') return { skip: true };
            if (task.outcome === 'stopped') {
                await db.exec("UPDATE codes_conductor_messages SET state = 'stopped', finished_at = COALESCE(finished_at, $2::timestamptz) WHERE task_id = $1 AND state IN ('queued', 'running')", [taskId, store.iso()]);
                return { stop: true };
            }
            if (jobId && task.job_id && task.job_id !== jobId) return { skip: true, stale: true };
            const ended = jobId || task.job_id;
            const attempt = await attemptOf(taskId);
            const turn = ended
                ? await db.maybe('SELECT * FROM codes_conductor_messages WHERE task_id = $1 AND job_id = $2 ORDER BY n DESC LIMIT 1', [taskId, ended])
                : null;
            if (turn && turn.state === 'running') {
                const ok = task.state === 'succeeded';
                // The session this turn ended with belongs to the agent that ran it: the next turn of that agent
                // resumes it. A machine whose Codes runner is older runs Claude Code whatever was asked; the row then
                // says so, and keeps the session under the agent that really ran.
                const ran = ranOf(task.result);
                const asked = turn.agent || task.agent || PRIMARY_AGENT;
                const agent = ran.agent && failover.CONDUCTOR_AGENTS.includes(ran.agent) ? ran.agent : asked;
                const session = ran.session || (agent === (task.agent || PRIMARY_AGENT) && !turn.agent ? (attempt && attempt.session) : null) || null;
                let note = turn.switch_note || null;
                if (agent !== asked) {
                    note = `${note ? `${note} ` : ''}Your machine ran ${failover.nameOf(agent)} instead of ${failover.nameOf(asked)}: its Codes runner is older than the switch. Update OpenVibe Node on it to let the conductor switch agents.`.slice(0, 1000);
                }
                await db.exec(
                    `UPDATE codes_conductor_messages SET state = $2, result = $3::jsonb, error = $4, session = $5, finished_at = $6::timestamptz,
                        agent = $7, switch_note = $8 WHERE id = $1`,
                    [turn.id, ok ? 'done' : 'failed', task.result == null ? null : JSON.stringify(task.result),
                        ok ? null : String(task.error || 'the turn failed').slice(0, 1000), session, task.finished_at || store.iso(), agent, note],
                );
            } else if (turn && turn.state !== 'done' && turn.state !== 'failed' && turn.state !== 'stopped') {
                await db.exec("UPDATE codes_conductor_messages SET state = $2, finished_at = COALESCE(finished_at, $3::timestamptz) WHERE id = $1",
                    [turn.id, task.state === 'succeeded' ? 'done' : 'failed', store.iso()]);
            }
            const queued = await db.maybe("SELECT id FROM codes_conductor_messages WHERE task_id = $1 AND state = 'queued' LIMIT 1", [taskId]);
            if (!queued && task.state !== 'succeeded') {
                const note = `The conductor's turn ended without finishing: ${String(task.error || 'the machine said nothing more')}. Its session is kept; write a message to carry on.`;
                return { row: await db.one("UPDATE run_tasks SET outcome = 'unfinished', outcome_note = $2, updated_at = $3 WHERE id = $1 RETURNING *", [taskId, note.slice(0, 1000), store.now()]) };
            }
            const row = await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [taskId]);
            return { row, next: !!queued };
        });
        if (result.skip || result.stop || !result.row) return result.row || null;
        if (result.next) {
            const started = await startNext(taskId);
            if (started && started.task) return started.task;
        }
        return await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [taskId]);
    }

    /** Stop the conductor: the running turn and every waiting message stop; nothing carries on. */
    async function stop(task) {
        const out = await tasks.stopTask(task);
        if (out.error) return out;
        await db.exec("UPDATE codes_conductor_messages SET state = 'stopped', finished_at = COALESCE(finished_at, $2::timestamptz) WHERE task_id = $1 AND state IN ('queued', 'running')", [task.id, store.iso()]);
        if (approvals) await approvals.stop(task.id);
        return out;
    }

    /** One message as the API and the page show it: its words, its state, never the attachment bytes. */
    function presentMessage(m) {
        if (!m) return null;
        const files = Array.isArray(m.attachments) ? m.attachments : asArray(m.attachments);
        return {
            id: m.id, n: Number(m.n) || 0, state: m.state,
            prompt: String(m.prompt || '').slice(0, 16000),
            attachments: files.map((a) => ({ name: a.name, mime: a.mime, size: a.size == null ? null : Number(a.size) })),
            job_id: m.job_id || null, session: m.session || null,
            agent: agentOf(m), agent_name: failover.nameOf(agentOf(m)), model: m.model || null, switch_note: m.switch_note || null,
            result: asObject(m.result) ? { ok: asObject(m.result).ok === true, summary: typeof asObject(m.result).summary === 'string' ? asObject(m.result).summary.slice(0, 4000) : null } : null,
            error: m.error ? String(m.error).slice(0, 1000) : null,
            created_at: iso(m.created_at), started_at: iso(m.started_at), finished_at: iso(m.finished_at),
        };
    }

    /** The conductor as its page shows it: the task, its one attempt and its turns. */
    async function view(task) {
        if (!task) return null;
        const attempt = await attemptOf(task.id);
        const messages = await db.many('SELECT * FROM codes_conductor_messages WHERE task_id = $1 ORDER BY n ASC', [task.id]);
        const pending = approvals ? await approvals.pending(task.id) : [];
        // The usage the next turn will be chosen on: each agent of the chain, how full its fullest window is, when it
        // frees, and which one the next turn would take.
        let usage = null;
        try {
            const choice = await choiceFor(task);
            usage = {
                switch_pct: choice.switchPct,
                next: choice.pick,
                note: choice.note,
                fallbacks: choice.chain.length - 1,
                chain: choice.usage.map((u) => ({ ...u, resets: failover.resetsLabel(u.resets_at) })),
            };
        } catch { usage = null; }
        return {
            task: tasks.present(task),
            kind: 'conductor',
            folder: task.folder || null,
            model: task.model || null,
            safety: task.safety || 'ask',
            machine: task.machine || null,
            idle: task.state === 'succeeded' && !task.outcome,
            attempt: attempt ? attempts.present(attempt) : null,
            messages: messages.map(presentMessage),
            approvals: pending.map((a) => approvals.present(a)),
            usage,
        };
    }

    /** One attachment's bytes, for the runner to write as a file on the machine. */
    async function attachment(taskId, messageId, index) {
        const row = await db.maybe('SELECT * FROM codes_conductor_messages WHERE id = $1 AND task_id = $2', [messageId, taskId]);
        if (!row) return null;
        const files = Array.isArray(row.attachments) ? row.attachments : asArray(row.attachments);
        const file = files[Number(index)];
        if (!file) return null;
        // A file uploaded through the composer lives in codes_attachments, by its own id (two uploads can finish in
        // either order); an older message kept its image inline.
        if (file.id && filesStore) {
            const got = await filesStore.byId(file.id);
            if (got) return got;
        }
        if (!file.data) return null;
        return { name: String(file.name || 'file'), mime: String(file.mime || 'application/octet-stream'), buffer: Buffer.from(String(file.data), 'base64') };
    }

    return {
        create, enqueue, message, startNext, onTurnEnd, stop, view, presentMessage, attachment, fragment, turnArgs, projectFor, choiceFor, refreshFleet, leadFor, retarget,
        SAFETY, MESSAGE_STATES, MAX_MESSAGE, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_MESSAGE_BYTES,
    };
}

module.exports = { createConductor, validFolder, cleanAttachments, ranOf, SAFETY, MODEL, NODE };
