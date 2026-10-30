'use strict';

/**
 * The approvals inbox (Codes C9b): when the conductor's safety level is `ask`, a risky tool call is written here and
 * waits for the person to decide — from the task page, or from their phone. The approve MCP tool (bin/mcp.js) posts the
 * call and waits; the person allows or denies it with the command in front of them.
 *
 *   createApprovals({ store, config, log, notify, userSettings })
 *     create({ task, tool, input, summary })        one waiting approval (and one notification, best effort)
 *     get(taskId, id) · pending(taskId) · inbox(subject)
 *     decide(taskId, id, { decision, message })     allow | deny, once
 *     decideAny(subject, id, { decision, message }) from the phone, without the task in the url
 *     stop(taskId)                                  the conductor stopped: nothing waits any more
 *     present(row)                                  one approval as the API and the page show it
 *
 * Nothing here runs a command: the decision travels back to the MCP tool in the job, which answers Claude Code with
 * {behavior: 'allow'|'deny'}. A row decided once is never decided again (the first answer wins), and an approval whose
 * conductor ended is denied with the reason, so a waiting tool is never left hanging.
 *
 * The stored `input` is the tool's arguments, for the record; the `summary` is the one line the person reads. Neither is
 * ever sent to the Network: the notification carries the summary and a link, nothing more.
 */

const TASK = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUMMARY_MAX = 400;
const INPUT_MAX = 16 * 1024;

const iso = (v) => {
    if (!v) return null;
    const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** A short line for the person: the command, the file, whatever the tool carries. */
function summarize(tool, input) {
    const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const v = i.command || i.cmd || i.file_path || i.filePath || i.path || i.notebook_path || i.url || i.pattern || i.query || i.description || '';
    const line = String(v).replace(/\s+/g, ' ').trim();
    return (line || String(tool || 'a tool')).slice(0, SUMMARY_MAX);
}

/** The input kept for the record: a plain object, no larger than 16 KB, its longest strings cut. */
function keptInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    let json;
    try { json = JSON.stringify(input); } catch { return null; }
    if (json.length <= INPUT_MAX) return input;
    const clone = { ...input };
    for (const key of Object.keys(clone)) {
        if (typeof clone[key] === 'string') clone[key] = clone[key].slice(0, 2000);
    }
    return JSON.stringify(clone).length <= INPUT_MAX ? clone : { note: 'the arguments were too long to keep whole' };
}

function createApprovals({ store, config = {}, log = console, notify = null, userSettings = null }) {
    const db = store.db;

    /** One notification to the person who owns the task, best effort, honouring their "a task needs me" choice. */
    async function tell(task, row) {
        if (!notify || !task || !task.subject) return;
        try {
            if (userSettings) {
                const settings = await userSettings.get(task.subject);
                if (!settings.notify_needs) return;
            }
            await notify.push({
                subject: task.subject,
                type: 'APPROVAL_NEEDED',
                title: 'Your conductor needs you',
                message: `${row.tool}: ${row.summary || 'a tool wants to run'}`,
                url: `${String(config.baseUrl || '').replace(/\/+$/, '')}/tasks/${task.id}#approvals`,
                priority: 'high',
                icon: '🛂',
            });
        } catch (e) {
            log.warn(`[Codes] approval ${row.id}: the notification was not sent: ${String((e && e.message) || e).slice(0, 200)}`);
        }
    }

    async function create({ task, tool, input = null, summary = null } = {}) {
        if (!task || !task.id) throw Object.assign(new Error('an approval belongs to a task'), { status: 422, code: 'approval.task_required' });
        const name = String(tool || '').trim().slice(0, 100);
        if (!name) throw Object.assign(new Error('an approval names the tool that wants to run'), { status: 422, code: 'approval.tool_required' });
        // One waiting approval per (task, tool, summary): Claude Code asks again for the same call only when the first
        // answer was lost, and a person should not be asked the same thing twice.
        const line = (summary == null ? summarize(name, input) : String(summary).replace(/\s+/g, ' ').trim()).slice(0, SUMMARY_MAX);
        const seen = await db.maybe(
            'SELECT * FROM codes_approvals WHERE task_id = $1 AND tool = $2 AND summary = $3 AND decision IS NULL ORDER BY created_at DESC LIMIT 1',
            [task.id, name, line],
        );
        if (seen) return seen;
        const row = await db.one(
            `INSERT INTO codes_approvals (id, task_id, tool, input, summary, created_at)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6::timestamptz) RETURNING *`,
            [store.newId('apr'), task.id, name, keptInput(input) ? JSON.stringify(keptInput(input)) : null, line, store.iso()],
        );
        await tell(task, row);
        log.info(`[Codes] approval ${row.id}: ${name} waits for ${task.subject}`);
        return row;
    }

    async function get(taskId, id) {
        if (!TASK.test(String(taskId)) || !id) return null;
        return await db.maybe('SELECT * FROM codes_approvals WHERE id = $1 AND task_id = $2', [String(id), taskId]);
    }

    /** The approvals still waiting on a task, oldest first. */
    async function pending(taskId) {
        return await db.many('SELECT * FROM codes_approvals WHERE task_id = $1 AND decision IS NULL ORDER BY created_at ASC', [taskId]);
    }

    /**
     * The person's waiting approvals, across their tasks: the task's own brief and machine come along, so the inbox reads
     * as a list of decisions and not of ids.
     */
    async function inbox(subject) {
        return await db.many(
            `SELECT a.*, t.prompt, t.folder, t.machine, t.state AS task_state
               FROM codes_approvals a JOIN run_tasks t ON t.id = a.task_id
              WHERE t.subject = $1 AND a.decision IS NULL
              ORDER BY a.created_at ASC LIMIT 50`,
            [subject],
        );
    }

    /** Record a decision once; the first one wins (a second press answers the row it found). */
    async function settle(id, decision, message) {
        const made = decision === 'allow' || decision === 'always' ? 'allow' : 'deny';
        return await store.tx(async () => {
            const row = await db.maybe('SELECT * FROM codes_approvals WHERE id = $1 FOR UPDATE', [id]);
            if (!row) return null;
            if (row.decision) return row;
            return await db.one(
                `UPDATE codes_approvals SET decision = $2, message = $3, decided_at = $4::timestamptz WHERE id = $1 RETURNING *`,
                [row.id, made, message ? String(message).slice(0, 500) : null, store.iso()],
            );
        });
    }

    async function decide(taskId, id, { decision, message = null } = {}) {
        const row = await get(taskId, id);
        if (!row) return null;
        return await settle(row.id, decision, message);
    }

    /** The phone's inbox is not under a task: the person's own approval, found by its id. */
    async function decideAny(subject, id, { decision, message = null } = {}) {
        const row = await db.maybe(
            'SELECT a.* FROM codes_approvals a JOIN run_tasks t ON t.id = a.task_id WHERE a.id = $1 AND t.subject = $2',
            [String(id || ''), subject],
        );
        if (!row) return null;
        return await settle(row.id, decision, message);
    }

    /** The conductor stopped: anything still waiting is denied with that reason, so the tool it asked about is answered. */
    async function stop(taskId) {
        return await db.exec(
            `UPDATE codes_approvals SET decision = 'deny', message = $2, decided_at = $3::timestamptz
              WHERE task_id = $1 AND decision IS NULL`,
            [taskId, 'the conductor was stopped', store.iso()],
        );
    }

    /** One approval as the API and the page show it: the command, never the whole arguments. */
    function present(row) {
        if (!row) return null;
        return {
            id: row.id,
            task_id: row.task_id,
            tool: row.tool,
            summary: row.summary || null,
            decision: row.decision || null,
            message: row.message || null,
            created_at: iso(row.created_at),
            decided_at: iso(row.decided_at),
            ...(row.prompt ? { task_prompt: String(row.prompt).slice(0, 300) } : {}),
            ...(row.machine ? { machine: row.machine } : {}),
            ...(row.task_state ? { task_state: row.task_state } : {}),
        };
    }

    return { create, get, pending, inbox, decide, decideAny, stop, present, summarize };
}

module.exports = { createApprovals, summarize, keptInput };
