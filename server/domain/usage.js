'use strict';

/**
 * What a person's tasks used, day by day (Codes C4b).
 *
 * Codes knows its own work: a task (run_tasks) and every attempt on it (codes_attempts), with the minutes between an
 * attempt's start and its end and the tokens its session reported. This module adds those up per calendar day.
 *
 * It knows no money. Prices are OpenVibe.Billing's: Billing's /api/v1/usage read is its ledger admin's
 * (billing.ledger.admin), and Codes holds no such grant, so the Usage screen shows runs, minutes and tokens and says
 * out loud that it shows no prices — it does not invent a ledger from its own cost fields.
 *
 *   createUsage({ store })
 *     daily(subject, { days })   → { days: [{ day, runs, attempts, minutes, tokens }], totals, window }
 */

const MAX_DAYS = 90;
const DEFAULT_DAYS = 14;

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? 0 : Number(v));

function createUsage({ store }) {
    const db = store.db;

    /**
     * The person's days, newest first. A day with no attempt is left out: a table of empty rows says nothing.
     * `minutes` is the time an attempt was running, to the minute; `tokens` is what its session reported.
     */
    async function daily(subject, { days = DEFAULT_DAYS } = {}) {
        const window = Math.min(MAX_DAYS, Math.max(1, Number(days) || DEFAULT_DAYS));
        if (!subject) return { days: [], totals: { runs: 0, attempts: 0, minutes: 0, tokens: 0 }, window };
        const rows = await db.many(
            `SELECT to_char(date_trunc('day', COALESCE(a.started_at, a.created_at)), 'YYYY-MM-DD') AS day,
                    count(DISTINCT a.task_id)::int AS runs,
                    count(a.id)::int AS attempts,
                    COALESCE(sum(GREATEST(0, EXTRACT(EPOCH FROM (a.finished_at - a.started_at)) / 60)), 0) AS minutes,
                    COALESCE(sum(a.tokens), 0) AS tokens
               FROM codes_attempts a JOIN run_tasks t ON t.id = a.task_id
              WHERE t.subject = $1 AND COALESCE(a.started_at, a.created_at) > now() - ($2::int * interval '1 day')
              GROUP BY 1 ORDER BY 1 DESC`,
            [subject, window],
        );
        const out = rows.map((r) => ({
            day: String(r.day),
            runs: num(r.runs),
            attempts: num(r.attempts),
            minutes: Math.round(num(r.minutes)),
            tokens: num(r.tokens),
        }));
        const totals = out.reduce((a, d) => ({
            runs: a.runs + d.runs, attempts: a.attempts + d.attempts, minutes: a.minutes + d.minutes, tokens: a.tokens + d.tokens,
        }), { runs: 0, attempts: 0, minutes: 0, tokens: 0 });
        return { days: out, totals, window };
    }

    return { daily, MAX_DAYS, DEFAULT_DAYS };
}

module.exports = { createUsage, MAX_DAYS, DEFAULT_DAYS };
