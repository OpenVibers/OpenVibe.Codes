'use strict';

/**
 * Telling a person a task finished, or needs them (Codes C9c). One OpenVibe notification through the Network — the only
 * notification store (ADR-020) — honouring the two switches in Settings (notify_done, notify_needs).
 *
 * The notice is recorded once per task and state in codes_notices in the same act that sends it, so a redelivered
 * Run event, a fallback read or two racing ticks never tell the person twice. The Action Center needs no push: it reads
 * the same tasks (codes.task@1 → common.action-item@1), so a task that ended is there whether or not a notification
 * could be sent.
 *
 *   createNotices({ store, config, notify, userSettings, log })
 *     done(task, note)    → { sent, reason?, skipped? }
 *     needs(task, note)   → { sent, reason?, skipped? }
 *
 * A notification that cannot be sent never stops the thing it is about, and a switched-off choice is not an error.
 */

const TASK = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const KINDS = new Set(['done', 'needs']);

const text = (value, max) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

function createNotices({ store, config = {}, notify = null, userSettings = null, log = console } = {}) {
    const db = store.db;

    /**
     * One notice for one task and state. The row is claimed first: if another caller already claimed it, nothing is
     * sent. The choice and the push are best effort and are said in the answer, never thrown.
     */
    async function send(task, kind, note) {
        if (!task || !TASK.test(String(task.id || '')) || !KINDS.has(kind)) return { sent: false, reason: 'bad_input' };
        if (!task.subject) return { sent: false, reason: 'no_subject' };
        const claimed = await db.maybe(
            `INSERT INTO codes_notices (task_id, kind, result) VALUES ($1, $2, $3)
             ON CONFLICT (task_id, kind) DO NOTHING RETURNING task_id`,
            [task.id, kind, text(note, 300) || null],
        );
        if (!claimed) return { sent: false, reason: 'already' };
        if (!notify) return { sent: false, reason: 'not_configured' };
        let settings = { notify_done: true, notify_needs: true };
        try { if (userSettings) settings = await userSettings.get(task.subject); } catch { /* the default is to tell */ }
        if (kind === 'done' && settings.notify_done === false) return { sent: false, reason: 'switched_off' };
        if (kind === 'needs' && settings.notify_needs === false) return { sent: false, reason: 'switched_off' };
        const base = String(config.baseUrl || '').replace(/\/+$/, '');
        const line = text(note, 300);
        try {
            const out = await notify.push({
                subject: task.subject,
                type: 'SYSTEM',
                title: kind === 'done' ? 'Your task is done' : 'Your task needs you',
                message: line || (kind === 'done' ? 'It finished. Open it to see what changed.' : 'It stopped and needs a person to carry on.'),
                url: `${base}/tasks/${encodeURIComponent(task.id)}`,
                priority: kind === 'needs' ? 'high' : 'normal',
                category: 'codes',
                icon: kind === 'done' ? '✅' : '🙋',
            });
            return out || { sent: true };
        } catch (e) {
            log.warn(`[Codes] notice ${kind} for ${task.id} was not sent: ${String((e && e.message) || e).slice(0, 200)}`);
            return { sent: false, reason: 'network_error' };
        }
    }

    /** "Done": the task's outcome is done. */
    const done = (task, note = null) => send(task, 'done', note);
    /** "Needs you": an unfinished task, a stop at its budget, or a task that could not start. */
    const needs = (task, note = null) => send(task, 'needs', note);

    return { send, done, needs, KINDS };
}

module.exports = { createNotices, KINDS };
