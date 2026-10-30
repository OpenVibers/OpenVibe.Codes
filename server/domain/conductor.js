'use strict';

/**
 * The conductor (Codes C9b): a long-lived task whose single attempt is one Claude Code session on a machine the person
 * chooses. It is the orchestrator that used to be a Claude Code session on the workstation, running in openvibe.codes.
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
 * The conductor uses the person's own Claude Code login on the machine (Node's plan_logins, opt-in and read-only, for
 * one job) and never a key of ours. It sets no steps or minutes budget; a turn's wall time is Run's job cap.
 */

const fs = require('fs');
const path = require('path');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const MESSAGE_STATES = ['queued', 'running', 'done', 'failed', 'stopped'];
const SAFETY = ['ask', 'project', 'full'];
const MODEL = /^[A-Za-z0-9._:-]{1,100}$/;
const NODE = /^(?:nod_)?[0-9A-HJKMNP-TV-Z]{26}$/;
const FRAGMENT = path.join(__dirname, '..', '..', 'engine', 'fragments', 'conductor.md');
const MAX_MESSAGE = 16000;
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_NOTE = 4000;
const MAX_FOLDER = 4096;

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

/** One attachment as it is stored: an image, its type and its bytes (base64). */
function cleanAttachments(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const a of list.slice(0, MAX_ATTACHMENTS)) {
        if (!a || typeof a !== 'object') continue;
        const name = String(a.name || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
        const mime = String(a.mime || '').toLowerCase();
        const data = typeof a.data === 'string' ? a.data.replace(/^data:[^;]+;base64,/, '') : '';
        if (!name || !/^image\//.test(mime) || !data) continue;
        let bytes = 0;
        try { bytes = Buffer.from(data, 'base64').length; } catch { bytes = 0; }
        if (!bytes || bytes > MAX_ATTACHMENT_BYTES) continue;
        out.push({ name, mime, data, size: bytes });
    }
    return out;
}

function createConductor({ store, config = {}, log = console, run, attempts, tasks, sessions, approvals = null, notify = null, fetchImpl = null }) {
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

    /** The one attempt of a conductor task. */
    async function attemptOf(taskId) {
        return await db.maybe('SELECT * FROM codes_attempts WHERE task_id = $1 ORDER BY n ASC LIMIT 1', [taskId]);
    }

    /**
     * Create the conductor: the task row, its one attempt and the hand-over turn. The first turn starts at once
     * (startNext), so a person who pressed "Start your conductor" sees it begin to work.
     */
    async function create({ subject, project, folder, machine = null, model = 'opus', safety = 'ask', note = null, key = null } = {}) {
        const work = validFolder(folder);
        if (!work) throw Object.assign(new Error('the working folder must be an absolute path'), { status: 422, code: 'conductor.folder_invalid' });
        if (!MODEL.test(String(model || ''))) throw Object.assign(new Error('the model is not a model name'), { status: 422, code: 'conductor.model_invalid' });
        if (!SAFETY.includes(safety)) throw Object.assign(new Error('safety is ask, project or full'), { status: 422, code: 'conductor.safety_invalid' });
        if (machine && !NODE.test(String(machine))) throw Object.assign(new Error('the machine is not one of the person\'s machines'), { status: 422, code: 'conductor.machine_invalid' });
        if (!subject) throw Object.assign(new Error('a conductor belongs to a person'), { status: 422, code: 'conductor.subject_required' });

        const first = fragment() + (note && String(note).trim() ? `\n\n---\n\n## What the owner asked now\n\n${String(note).trim().slice(0, MAX_NOTE)}\n` : '');
        const id = store.newId('tsk');
        const at = store.now();
        const repo = `conductor://${work}`.slice(0, 300);
        let row;
        await store.tx(async () => {
            row = await db.one(
                `INSERT INTO run_tasks (id, subject, project_id, repo, prompt, agent, model, kind, folder, machine, safety, state, idempotency_key, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, 'claude-code', $6, 'conductor', $7, $8, $9, 'queued', $10, $11, $11) RETURNING *`,
                [id, subject, project, repo, first.slice(0, 16000), String(model).slice(0, 100), work, machine || null, safety, key || null, at],
            );
        });
        await attempts.create({
            task: row, agent: 'claude-code', model: String(model).slice(0, 100), machine: machine || null,
            why: 'the conductor session starts here', kind: 'first', state: 'queued',
        });
        const message = await enqueue(row, { text: first, attachments: [], first: true });
        const started = await startNext(id);
        return { task: await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [id]), message, started };
    }

    /** Write one message: the next turn. It waits if a turn is running. */
    async function enqueue(task, { text, attachments = [], first = false } = {}) {
        const prompt = String(text == null ? '' : text).trim();
        const files = cleanAttachments(attachments);
        if (!prompt && !files.length) throw Object.assign(new Error('a message needs words or an image'), { status: 422, code: 'conductor.message_empty' });
        if (prompt.length > MAX_MESSAGE) throw Object.assign(new Error(`a message is at most ${MAX_MESSAGE} characters`), { status: 422, code: 'conductor.message_too_long' });
        const made = await store.tx(async () => {
            const current = await db.maybe('SELECT * FROM run_tasks WHERE id = $1 FOR UPDATE', [task.id]);
            if (!current || current.kind !== 'conductor') throw Object.assign(new Error('no such conductor'), { status: 404, code: 'conductor.not_found' });
            if (current.outcome === 'stopped') throw Object.assign(new Error('this conductor was stopped: start a new one'), { status: 409, code: 'conductor.stopped' });
            const n = await db.one('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM codes_conductor_messages WHERE task_id = $1', [task.id]);
            return await db.one(
                `INSERT INTO codes_conductor_messages (id, task_id, n, prompt, attachments, state, created_at)
                 VALUES ($1, $2, $3, $4, $5::jsonb, 'queued', $6::timestamptz) RETURNING *`,
                [store.newId('msg'), task.id, n.n, prompt || (first ? 'Begin.' : 'Look at the attached image.'), files.length ? JSON.stringify(files) : null, store.iso()],
            );
        });
        return made;
    }

    /** A message the person writes. Starts the turn when the conductor is idle; otherwise it waits. */
    async function message(task, { text, attachments = [] } = {}) {
        const made = await enqueue(task, { text, attachments });
        const started = await startNext(task.id);
        return { message: made, started };
    }

    /** The job input of one turn: the same folder, model and safety, and the session the attempt carries. */
    function turnArgs(task, message, attempt) {
        const files = Array.isArray(message.attachments) ? message.attachments : [];
        return {
            kind: 'conductor',
            task_id: task.id,
            message_id: message.id,
            folder: task.folder,
            prompt: message.prompt,
            agent: 'claude-code',
            model: task.model || 'opus',
            safety: task.safety || 'ask',
            mcp: true,
            codes_url: baseUrl,
            ...(attempt && attempt.session ? { resume: attempt.session } : {}),
            // The image's bytes stay in the database: the job fetches it with the person's token and writes it as a
            // file on the machine, so a turn's input stays far inside Run's limit.
            ...(files.length
                ? { attachments: files.map((a, i) => ({ name: a.name, mime: a.mime, size: a.size, url: `${baseUrl}/api/v1/tasks/${encodeURIComponent(task.id)}/messages/${encodeURIComponent(message.id)}/attachments/${i}` })) }
                : {}),
        };
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
        let job;
        try {
            job = await run.submit({
                subject: task.subject, project: task.project_id, args: turnArgs(task, turn, attempt), key: turn.id,
                limits: { wall_ms: wallMs, cpu_ms: wallMs, mem_bytes: 4 * 1024 ** 3 }, ttlMs: Math.min(86_400_000, wallMs + 10 * 60_000),
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
            if (attempt) await attempts.bind(attempt.id, { job_id: job.id, state: 'queued', machine: task.machine, model: task.model });
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
                await db.exec(
                    `UPDATE codes_conductor_messages SET state = $2, result = $3::jsonb, error = $4, session = $5, finished_at = $6::timestamptz WHERE id = $1`,
                    [turn.id, ok ? 'done' : 'failed', task.result == null ? null : JSON.stringify(task.result),
                        ok ? null : String(task.error || 'the turn failed').slice(0, 1000), (attempt && attempt.session) || null, task.finished_at || store.iso()],
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
        };
    }

    /** One attachment's bytes, for the runner to write as a file on the machine. */
    async function attachment(taskId, messageId, index) {
        const row = await db.maybe('SELECT * FROM codes_conductor_messages WHERE id = $1 AND task_id = $2', [messageId, taskId]);
        if (!row) return null;
        const files = Array.isArray(row.attachments) ? row.attachments : [];
        const file = files[Number(index)];
        if (!file || !file.data) return null;
        return { name: String(file.name || 'image'), mime: String(file.mime || 'application/octet-stream'), buffer: Buffer.from(String(file.data), 'base64') };
    }

    return {
        create, enqueue, message, startNext, onTurnEnd, stop, view, presentMessage, attachment, fragment, turnArgs, projectFor,
        SAFETY, MESSAGE_STATES, MAX_MESSAGE, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES,
    };
}

module.exports = { createConductor, validFolder, cleanAttachments, SAFETY, MODEL, NODE };
