'use strict';
/**
 * Spare usage: get every ounce of your plans (plan §AD.37; the owner, 2026-11-21: "if the weekly reset's coming up and
 * there's still usage available, you should be able to set a task list if it's not doing something else already, so
 * that you actually get every ounce of your usage across all your code harnesses").
 *
 * A person keeps a list of things worth doing (a prompt, a repository, which agent or any, a priority, whether it comes
 * back after it ran). Every few minutes the planner reads their fleet (engine/usage.js through Link → Bot → fleet.js):
 * an agent whose plan window resets within `reset_within_hours` with at least `min_left_pct` left, that is not working
 * on anything of theirs, and whose shorter windows are not full, takes the next task of the list. Soonest reset first,
 * then most left. It stops at `keep_pct` left, and never runs more than `max_running` of the list at once.
 *
 *   plan({ settings, tasks, agents, busy, running, now })   pure: [{ task, agent, window, why }]
 *   createSpare({ store, fleet, harnesses, tasks: runTasks, log, now })
 *     get(subject) / saveSettings(subject, patch, project) / add / update / remove   the list, the person's own
 *     view(subject)    the list, the settings, and per agent its windows and why it would or would not take a task now
 *     tick()           start what may start, and settle what ended (the job runs it every 5 minutes)
 *
 * A reading older than its window's reset counts as that window reset (nothing used). A task the list started is an
 * ordinary Codes task (via 'spare'): its level, its approvals and its pull request are the person's as for any other.
 */
const { windowFull } = require('../../engine/router');

const DEFAULTS = { enabled: false, reset_within_hours: 12, min_left_pct: 15, keep_pct: 5, max_running: 1, agents: null };
const LIMITS = { reset_within_hours: [1, 168], min_left_pct: [1, 100], keep_pct: [0, 50], max_running: [1, 4] };
const AGENT = /^[a-z0-9-]{1,40}$/;
const MAX_TASKS = 100;
const ENDED = new Set(['succeeded', 'failed', 'cancelled', 'expired']);   // run-tasks TERMINAL
const OK_END = new Set(['succeeded']);

const iso = (v) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const clampInt = (v, [lo, hi]) => (Number.isInteger(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : null);

/** A window's percent used, or null; a reading past its own reset is a reset window. */
function usedOf(w, now) {
    if (!w) return null;
    if (w.resets_at && Date.parse(w.resets_at) <= now) return 0;
    if (w.pct != null) return Number(w.pct);
    if (w.used != null && w.limit) return (Number(w.used) / Number(w.limit)) * 100;
    return null;
}

/**
 * Which agents may take a task now, and the task each takes.
 *   agents   fleet.agents() rows: { agent, state, signed_in, windows: [{ name, pct|used/limit, resets_at }] }
 *   busy     Set of agents running anything of the person's (any task, not only the list's)
 *   running  how many of the list's tasks are running now
 * → { picks: [{ task, agent, window, why }], agents: [{ agent, take, why, window }] }
 */
function plan({ settings, tasks, agents, busy = new Set(), running = 0, now = Date.now() }) {
    const s = { ...DEFAULTS, ...(settings || {}) };
    const out = { picks: [], agents: [] };
    const allowed = Array.isArray(s.agents) && s.agents.length ? new Set(s.agents) : null;
    const candidates = [];
    for (const a of agents || []) {
        const say = (why, take = false, window = null) => out.agents.push({ agent: a.agent, take, why, window });
        if (allowed && !allowed.has(a.agent)) { say('not on your list of agents'); continue; }
        if (!a.signed_in) { say('not signed in on any of your computers'); continue; }
        const windows = (a.windows || []).filter((w) => w && w.resets_at);
        if (!windows.length) { say('its plan reports no window with a reset time'); continue; }
        // A shorter window that is full stops it whatever the long one says.
        if ((a.windows || []).some((w) => usedOf(w, now) != null && usedOf(w, now) > 0 && windowFull({ ...w, pct: usedOf(w, now) }, now))) { say('a window of its plan is full right now'); continue; }
        // The window that resets soonest with room left is the one to use up.
        const usable = windows.map((w) => ({ w, hours: (Date.parse(w.resets_at) - now) / 3600e3, left: 100 - (usedOf(w, now) ?? 100) }))
            .filter((x) => x.hours > 0)
            .sort((x, y) => x.hours - y.hours);
        const soon = usable.find((x) => x.hours <= s.reset_within_hours);
        if (!soon) { const next = usable[0]; say(next ? `its next reset is in ${Math.round(next.hours)} h (you said ${s.reset_within_hours} h)` : 'no reset ahead'); continue; }
        if (soon.left < s.min_left_pct) { say(`${Math.round(soon.left)}% of its ${soon.w.name} window is left (you asked for ${s.min_left_pct}%)`); continue; }
        if (soon.left <= s.keep_pct) { say(`it is down to the ${s.keep_pct}% you keep`); continue; }
        if (busy.has(a.agent)) { say('it is working on something of yours'); continue; }
        candidates.push({ agent: a.agent, window: soon.w.name, hours: soon.hours, left: soon.left });
    }
    candidates.sort((x, y) => x.hours - y.hours || y.left - x.left);
    const queue = (tasks || []).filter((t) => t.state === 'queued').sort((x, y) => x.priority - y.priority || String(x.created_at).localeCompare(String(y.created_at)));
    const taken = new Set();
    let slots = Math.max(0, s.max_running - running);
    for (const c of candidates) {
        const task = slots > 0 ? queue.find((t) => !taken.has(t.id) && (t.agent === 'any' || t.agent === c.agent)) : null;
        const why = `${Math.round(c.left)}% of its ${c.window} window left, resetting in ${c.hours < 1 ? `${Math.round(c.hours * 60)} min` : `${Math.round(c.hours)} h`}`;
        if (task) {
            taken.add(task.id);
            slots--;
            out.picks.push({ task, agent: c.agent, window: c.window, why });
            out.agents.push({ agent: c.agent, take: true, why, window: c.window });
        } else {
            out.agents.push({ agent: c.agent, take: false, why: slots > 0 ? `${why}: nothing on the list for it` : `${why}: ${s.max_running} of the list already running`, window: c.window });
        }
    }
    return out;
}

/** A task as the API shows it. */
function present(t) {
    return {
        id: t.id, title: t.title, prompt: t.prompt, repo: t.repo || null, agent: t.agent, priority: t.priority, repeat: !!t.repeat,
        state: t.state, task_id: t.task_id || null, last_agent: t.last_agent || null, last_window: t.last_window || null,
        note: t.note || null, runs: t.runs || 0, created_at: iso(t.created_at), started_at: iso(t.started_at), ended_at: iso(t.ended_at),
    };
}

/** A new or changed task from a request body → { fields } or { error }. */
function taskFields(b, { partial = false } = {}) {
    const f = {};
    const str = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max);
    if (!partial || b.prompt !== undefined) {
        f.prompt = str(b.prompt, 8000);
        if (!f.prompt) return { error: 'Say what to do (the prompt).' };
    }
    if (!partial || b.title !== undefined) f.title = str(b.title, 120) || (f.prompt ? f.prompt.split('\n')[0].slice(0, 80) : '');
    if (!partial || b.repo !== undefined) {
        // A Codes task runs in a repository: an https address, or owner/name for its GitHub address.
        let r = str(b.repo, 300).replace(/\.git$/, '');
        if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)) r = `https://github.com/${r}`;
        if (!/^https:\/\/[^\s/]+\/[^\s]+$/.test(r)) return { error: 'Name the repository: owner/name or its https address.' };
        f.repo = r;
    }
    if (b.agent !== undefined) {
        const a = str(b.agent, 40) || 'any';
        if (a !== 'any' && !AGENT.test(a)) return { error: 'The agent is "any" or an agent id.' };
        f.agent = a;
    }
    if (b.priority !== undefined) {
        const p = clampInt(b.priority, [1, 5]);
        if (p == null) return { error: 'The priority is 1 (first) to 5.' };
        f.priority = p;
    }
    if (b.repeat !== undefined) f.repeat = b.repeat === true || b.repeat === 'true' || b.repeat === 'on' || b.repeat === '1';
    if (b.state !== undefined) {
        if (!['queued', 'paused'].includes(b.state)) return { error: 'A task can be set to queued or paused.' };
        f.state = b.state;
    }
    return { fields: f };
}

function createSpare({ store, fleet = null, harnesses = null, tasks = null, log = console, now = () => Date.now(), config = {} }) {
    const db = store.db;
    const fleetOf = () => (typeof fleet === 'function' ? fleet() : fleet);

    async function settingsOf(subject) {
        const row = await db.maybe('SELECT * FROM codes_spare_settings WHERE subject = $1', [subject]);
        return row ? { enabled: row.enabled, reset_within_hours: row.reset_within_hours, min_left_pct: row.min_left_pct, keep_pct: row.keep_pct, max_running: row.max_running, agents: row.agents || null, project_id: row.project_id || null } : { ...DEFAULTS, project_id: null };
    }
    async function list(subject) {
        return db.many('SELECT * FROM codes_spare_tasks WHERE subject = $1 ORDER BY (state = \'queued\') DESC, priority, created_at LIMIT $2', [subject, MAX_TASKS]);
    }
    async function saveSettings(subject, b, { project = null } = {}) {
        const cur = await settingsOf(subject);
        const next = { ...cur };
        if (b.enabled !== undefined) next.enabled = b.enabled === true || b.enabled === 'true' || b.enabled === 'on' || b.enabled === '1';
        for (const [k, range] of Object.entries(LIMITS)) {
            if (b[k] === undefined || b[k] === '') continue;
            const v = clampInt(b[k], range);
            if (v == null) throw Object.assign(new Error(`${k} is a whole number from ${range[0]} to ${range[1]}`), { status: 422, code: 'spare.invalid' });
            next[k] = v;
        }
        if (b.agents !== undefined) {
            const list = Array.isArray(b.agents) ? b.agents : b.agents ? String(b.agents).split(',') : [];
            const ids = [...new Set(list.map((x) => String(x).trim()).filter((x) => AGENT.test(x)))].slice(0, 20);
            next.agents = ids.length ? ids : null;
        }
        if (next.keep_pct >= next.min_left_pct) next.keep_pct = Math.max(0, next.min_left_pct - 1);
        await db.exec(`INSERT INTO codes_spare_settings (subject, enabled, reset_within_hours, min_left_pct, keep_pct, max_running, agents, project_id, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,now())
            ON CONFLICT (subject) DO UPDATE SET enabled = EXCLUDED.enabled, reset_within_hours = EXCLUDED.reset_within_hours, min_left_pct = EXCLUDED.min_left_pct,
                keep_pct = EXCLUDED.keep_pct, max_running = EXCLUDED.max_running, agents = EXCLUDED.agents,
                project_id = COALESCE(EXCLUDED.project_id, codes_spare_settings.project_id), updated_at = now()`,
        [subject, next.enabled, next.reset_within_hours, next.min_left_pct, next.keep_pct, next.max_running, next.agents ? JSON.stringify(next.agents) : null, project]);
        return settingsOf(subject);
    }
    async function add(subject, b) {
        const { fields, error } = taskFields(b || {});
        if (error) throw Object.assign(new Error(error), { status: 422, code: 'spare.invalid' });
        const count = Number(await db.value("SELECT count(*) FROM codes_spare_tasks WHERE subject = $1 AND state <> 'done'", [subject]));
        if (count >= MAX_TASKS) throw Object.assign(new Error(`The list holds ${MAX_TASKS} open tasks at most.`), { status: 409, code: 'spare.full' });
        const id = store.newId('spt');
        await db.exec(`INSERT INTO codes_spare_tasks (id, subject, title, prompt, repo, agent, priority, repeat, state, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',now(),now())`,
        [id, subject, fields.title, fields.prompt, fields.repo || null, fields.agent || 'any', fields.priority || 3, !!fields.repeat]);
        return present(await db.one('SELECT * FROM codes_spare_tasks WHERE id = $1', [id]));
    }
    async function update(subject, id, b) {
        const row = await db.maybe('SELECT * FROM codes_spare_tasks WHERE id = $1 AND subject = $2', [id, subject]);
        if (!row) return null;
        const { fields, error } = taskFields(b || {}, { partial: true });
        if (error) throw Object.assign(new Error(error), { status: 422, code: 'spare.invalid' });
        if (row.state === 'running' && fields.state) delete fields.state;   // a running task finishes first
        const keys = Object.keys(fields);
        if (!keys.length) return present(row);
        const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
        await db.exec(`UPDATE codes_spare_tasks SET ${sets}, updated_at = now() WHERE id = $1 AND subject = $2`, [id, subject, ...keys.map((k) => fields[k])]);
        return present(await db.one('SELECT * FROM codes_spare_tasks WHERE id = $1', [id]));
    }
    async function remove(subject, id) {
        const out = await db.maybe('DELETE FROM codes_spare_tasks WHERE id = $1 AND subject = $2 RETURNING id', [id, subject]);
        return !!out;
    }
    async function busyOf(subject) {
        // run_tasks keeps its times as epoch milliseconds.
        const rows = await db.many('SELECT agent, state FROM run_tasks WHERE subject = $1 AND updated_at > $2', [subject, now() - 86_400_000]);
        const busy = new Set();
        for (const r of rows) if (r.agent && !ENDED.has(String(r.state))) busy.add(r.agent);
        return busy;
    }
    async function agentsOf(subject) {
        const f = fleetOf();
        if (!f || typeof f.agents !== 'function') return [];
        try { return await f.agents(subject, harnesses); } catch (e) { log.warn(`[Codes] spare: the fleet of ${subject} could not be read: ${String(e && e.message).slice(0, 160)}`); return []; }
    }
    /** The list, the settings, and per agent what the planner would do now and why. */
    async function view(subject) {
        const [settings, rows, agents, busy] = await Promise.all([settingsOf(subject), list(subject), agentsOf(subject), busyOf(subject)]);
        const running = rows.filter((t) => t.state === 'running').length;
        const p = plan({ settings, tasks: rows, agents, busy, running, now: now() });
        const meters = agents.map((a) => ({
            agent: a.agent, name: a.name, state: a.state,
            windows: (a.windows || []).map((w) => ({ name: w.name, used_pct: usedOf(w, now()) == null ? null : Math.round(usedOf(w, now())), resets_at: w.resets_at || null })),
            ...(p.agents.find((x) => x.agent === a.agent) || {}),
        }));
        const { project_id: _p, ...publicSettings } = settings;
        return { settings: publicSettings, tasks: rows.map(present), agents: meters };
    }
    /** Settle what ended; then start what may start. → { started, settled } */
    async function tick() {
        let settled = 0, started = 0;
        const runningRows = await db.many("SELECT s.id, s.subject, s.repeat, t.state AS task_state FROM codes_spare_tasks s LEFT JOIN run_tasks t ON t.id = s.task_id WHERE s.state = 'running'");
        for (const r of runningRows) {
            if (r.task_state && !ENDED.has(String(r.task_state))) continue;
            const ok = OK_END.has(String(r.task_state));
            const next = r.repeat && ok ? 'queued' : ok ? 'done' : 'failed';
            await db.exec('UPDATE codes_spare_tasks SET state = $2, ended_at = now(), note = $3, updated_at = now() WHERE id = $1', [r.id, next, r.task_state ? `ended ${r.task_state}` : 'its task is gone']);
            settled++;
        }
        if (!tasks || typeof tasks.start !== 'function') return { started, settled };
        const subjects = await db.many("SELECT s.subject FROM codes_spare_settings s WHERE s.enabled AND EXISTS (SELECT 1 FROM codes_spare_tasks t WHERE t.subject = s.subject AND t.state = 'queued')");
        for (const { subject } of subjects) {
            const settings = await settingsOf(subject);
            const rows = await list(subject);
            const p = plan({ settings, tasks: rows, agents: await agentsOf(subject), busy: await busyOf(subject), running: rows.filter((t) => t.state === 'running').length, now: now() });
            for (const pick of p.picks) {
                const project = settings.project_id || (typeof tasks.latestProject === 'function' ? await tasks.latestProject(subject).catch(() => null) : null);
                if (!project) { await db.exec("UPDATE codes_spare_tasks SET note = $2, updated_at = now() WHERE id = $1", [pick.task.id, 'waiting: open your spare-usage settings once so Codes knows which project to run in']); continue; }
                try {
                    const args = require('../../harness/job').parseArgs(JSON.stringify({ repo: pick.task.repo || null, prompt: pick.task.prompt, agent: pick.agent, permission: 'edit' }));
                    const row = await tasks.start({ subject, project, args, via: 'spare' });
                    await db.exec(`UPDATE codes_spare_tasks SET state = 'running', task_id = $2, last_agent = $3, last_window = $4, note = $5, runs = runs + 1, started_at = now(), ended_at = NULL, updated_at = now() WHERE id = $1`,
                        [pick.task.id, row.id, pick.agent, pick.window, pick.why]);
                    started++;
                    log.info && log.info(`[Codes] spare: ${subject} ${pick.task.id} → ${pick.agent} (${pick.why})`);
                } catch (e) {
                    await db.exec('UPDATE codes_spare_tasks SET note = $2, updated_at = now() WHERE id = $1', [pick.task.id, `not started: ${String((e && e.message) || e).slice(0, 200)}`]);
                }
            }
        }
        return { started, settled };
    }
    let stopTimer = null;
    return {
        get: settingsOf, list, saveSettings, add, update, remove, view, tick, plan,
        start() {
            if (stopTimer || config.drill) return false;
            stopTimer = require('../utils/jobs').every('codes-spare-usage', 5 * 60_000, () => tick().catch((e) => log.warn(`[Codes] spare tick failed: ${e.message}`)), { initialDelayMs: 90_000, jitterMs: 30_000, log });
            return true;
        },
        stop() { if (stopTimer) stopTimer(); stopTimer = null; },
    };
}

module.exports = { createSpare, plan, present, taskFields, usedOf, DEFAULTS, LIMITS };
