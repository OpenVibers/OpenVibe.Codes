'use strict';

/**
 * The learned placement counts (agent plan A1, section 3), one row per (person, option key, step kind) in
 * placement_outcomes. The row is plain data — two decayed weights and when they were last written — never text and
 * never a payload.
 *
 *   createPlacementOutcomes({ store, now }) →
 *     forPerson(person)        the person's rows and everyone else's, for place()'s outcomes
 *     record({ person, key, kind, ok, at })  learn() once and persist the resulting row
 *     global()                 everyone's rows, cached for five minutes
 *
 * The SDK's learn() applies the 14-day half-life at write time; successOf() applies it again at read time. Global
 * counts are a SUM over the other people's rows; reading them through one query per five minutes keeps a placement
 * to one outcomes read of the person's own rows.
 */
const { learn } = require('openvibe-sdk/placement');

const GLOBAL_TTL_MS = 5 * 60_000;
const toRow = (r) => ({
    person: r.person_id, key: r.option_key, kind: r.step_kind,
    ok_w: Number(r.ok_w) || 0, n_w: Number(r.n_w) || 0,
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
});

function createPlacementOutcomes({ store, now = store.now, log = console, globalTtlMs = GLOBAL_TTL_MS } = {}) {
    const db = store.db;
    let cached = { at: 0, rows: [] };

    async function read(where, args) {
        return (await db.many(`SELECT person_id, option_key, step_kind, ok_w, n_w, updated_at FROM placement_outcomes ${where}`, args)).map(toRow);
    }

    /** Everyone else's rows, cached: a placement reads it at most once every five minutes. */
    async function global() {
        if (cached.at && now() - cached.at < globalTtlMs) return cached.rows;
        let rows = [];
        try { rows = await read('', []); } catch (e) {
            // A placement must not fail because the learning table is briefly unreadable; it just has no priors.
            log.warn(`[Codes] placement outcomes could not be read: ${String((e && e.message) || e).slice(0, 200)}`);
        }
        cached = { at: now(), rows };
        return rows;
    }

    /** The person's own rows plus the others', without counting the person's rows twice. */
    async function forPerson(person) {
        if (!person) return await global();
        let mine = [];
        try { mine = await read('WHERE person_id = $1', [person]); } catch (e) {
            log.warn(`[Codes] placement outcomes for ${person} could not be read: ${String((e && e.message) || e).slice(0, 200)}`);
        }
        const others = (await global()).filter((r) => r.person !== person);
        return [...mine, ...others];
    }

    async function upsert(row) {
        await db.exec(
            `INSERT INTO placement_outcomes (person_id, option_key, step_kind, ok_w, n_w, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
             ON CONFLICT (person_id, option_key, step_kind) DO UPDATE SET
                 ok_w = EXCLUDED.ok_w, n_w = EXCLUDED.n_w, updated_at = EXCLUDED.updated_at`,
            [row.person, row.key, row.kind, row.ok_w, row.n_w, row.updated_at],
        );
        cached.at = 0;
    }

    /** learn() the outcome and persist exactly the row it returns for this person, key and kind. */
    async function record({ person, key, kind, ok, at }) {
        if (!person || !key || !kind) return null;
        const before = await read('WHERE person_id = $1 AND option_key = $2 AND step_kind = $3', [person, key, kind]);
        const next = learn(before, { person, key, kind, ok: !!ok, at });
        const row = next.find((r) => r.person === person && r.key === key && r.kind === kind);
        if (!row) return null;
        await upsert(row);
        return row;
    }

    /**
     * Persist the counts escalate() returns, for this person, exactly as they are: escalate() already learned the
     * failed try, so a consumer must not call record() for the same failure again.
     */
    async function recordAll(rows, person) {
        const mine = (Array.isArray(rows) ? rows : []).filter((r) => r && r.person === person && r.key && r.kind);
        for (const row of mine) await upsert(row);
        return mine.length;
    }

    return { forPerson, global, record, recordAll, GLOBAL_TTL_MS };
}

module.exports = { createPlacementOutcomes, GLOBAL_TTL_MS };
