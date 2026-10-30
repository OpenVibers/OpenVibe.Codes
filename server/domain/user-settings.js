'use strict';

/**
 * A person's workspace choices (Codes C4b): the default agent, the default machine, their notifications, the safety
 * level and the limits on every task (Codes C9a: steps and minutes, null meaning no limit). One row per person in
 * codes_user_settings (migrations 0013 and 0014); a person without a row reads the defaults, so the Settings screen is
 * complete before anything is saved.
 *
 *   createUserSettings({ store })
 *     get(subject)                 → { default_agent, default_machine, notify_done, notify_needs, safety,
 *                                     steps, minutes }
 *     save(subject, patch)         → the saved row, in the same shape
 *
 * Only a usr_ subject is accepted: a service token has no preferences of its own to keep.
 */
const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const SAFETY = ['ask', 'project', 'full'];
const AGENT = /^[a-z0-9-]{1,40}$/;
const MACHINE = /^(?:nod_)?[0-9A-HJKMNP-TV-Z]{26}$/;
/** The most a person may set (the portal's own cap): a number of steps or minutes, or none at all. */
const LIMIT_MAX = 100000;

const DEFAULTS = Object.freeze({
    default_agent: null, default_machine: null, notify_done: true, notify_needs: true, safety: 'ask',
    steps: null, minutes: null,
});

/** A nullable limit from a form or an API: '' / 'off' / 0 / null mean no limit; a negative or silly number is refused. */
function limit(v, field) {
    if (v === undefined) return undefined;
    if (v === null || v === '' || v === 0 || v === '0' || String(v).toLowerCase() === 'off') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > LIMIT_MAX) {
        throw Object.assign(new Error(`${field} is a positive number, or empty for No limit`), { status: 422, code: 'settings.limit_invalid' });
    }
    return Math.round(n);
}

function present(row) {
    if (!row) return { ...DEFAULTS };
    return {
        default_agent: row.default_agent || null,
        default_machine: row.default_machine || null,
        notify_done: row.notify_done !== false,
        notify_needs: row.notify_needs !== false,
        safety: SAFETY.includes(row.safety) ? row.safety : 'ask',
        steps: row.steps == null ? null : Number(row.steps),
        minutes: row.minutes == null ? null : Number(row.minutes),
    };
}

function createUserSettings({ store }) {
    const db = store.db;

    async function get(subject) {
        if (!USER.test(String(subject || ''))) return { ...DEFAULTS };
        return present(await db.maybe('SELECT * FROM codes_user_settings WHERE subject = $1', [subject]));
    }

    /**
     * Save the choices a form sent. A value that is not one Codes knows is refused with a 422 rather than stored, and a
     * field the form did not send keeps what it had: a partly filled form never wipes the rest.
     */
    async function save(subject, patch = {}) {
        if (!USER.test(String(subject || ''))) {
            throw Object.assign(new Error('subject must be a usr_ subject'), { status: 400, code: 'subject.required' });
        }
        const now = present(await db.maybe('SELECT * FROM codes_user_settings WHERE subject = $1', [subject]));
        const next = { ...now };
        if (patch.default_agent !== undefined) {
            const v = patch.default_agent === '' || patch.default_agent == null ? null : String(patch.default_agent);
            if (v !== null && !AGENT.test(v)) throw Object.assign(new Error('the default agent is a harness id, or empty for Auto'), { status: 422, code: 'settings.agent_unknown' });
            next.default_agent = v;
        }
        if (patch.default_machine !== undefined) {
            const v = patch.default_machine === '' || patch.default_machine == null ? null : String(patch.default_machine);
            if (v !== null && !MACHINE.test(v)) throw Object.assign(new Error('the default machine is one of your machines, or empty for Auto'), { status: 422, code: 'settings.machine_unknown' });
            next.default_machine = v;
        }
        if (patch.notify_done !== undefined) next.notify_done = patch.notify_done !== false && patch.notify_done !== '0';
        if (patch.notify_needs !== undefined) next.notify_needs = patch.notify_needs !== false && patch.notify_needs !== '0';
        if (patch.safety !== undefined) {
            const v = String(patch.safety);
            if (!SAFETY.includes(v)) throw Object.assign(new Error(`the safety level is one of ${SAFETY.join(', ')}`), { status: 422, code: 'settings.safety_unknown' });
            next.safety = v;
        }
        // Settings → Limits: steps and minutes per task, for every harness at once. No value means no limit.
        const steps = limit(patch.steps, 'steps per task');
        if (steps !== undefined) next.steps = steps;
        const minutes = limit(patch.minutes, 'minutes per task');
        if (minutes !== undefined) next.minutes = minutes;
        await db.exec(
            `INSERT INTO codes_user_settings (subject, default_agent, default_machine, notify_done, notify_needs, safety,
                 steps, minutes, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
             ON CONFLICT (subject) DO UPDATE SET default_agent = EXCLUDED.default_agent, default_machine = EXCLUDED.default_machine,
                 notify_done = EXCLUDED.notify_done, notify_needs = EXCLUDED.notify_needs, safety = EXCLUDED.safety,
                 steps = EXCLUDED.steps, minutes = EXCLUDED.minutes, updated_at = now()`,
            [subject, next.default_agent, next.default_machine, next.notify_done, next.notify_needs, next.safety, next.steps, next.minutes],
        );
        return next;
    }

    return { get, save, DEFAULTS, SAFETY, LIMIT_MAX };
}

module.exports = { createUserSettings, present, DEFAULTS, SAFETY, LIMIT_MAX };
