'use strict';

/**
 * A finished task's proof: its tests, its pages, its diff and the second model's opinion.
 *
 * The proof arrives with the machine's result (the job worker collected it there, in the clone the agent worked in),
 * and this module keeps it: one row per proof item, one event per item on the task's stream, and the task's outcome
 * in the plain words a person reads.
 *
 *   createProof({ store, config, log })
 *     record(taskId, attemptN, items)   the items of one attempt: the rows, and the lines for the stream
 *     list(taskId)                     the items of a task, in order
 *     present(items)                   the items as the API shows them
 *     outcomeOf(items, fallback)       the outcome in plain words
 *
 * The outcome is what the spec asks for: "Done with proof", "Didn't finish, with what is left" and "Stopped by
 * you". The engine's own verdict stands (a task the agent did not finish is unfinished); the proof says out loud
 * what the evidence says, so a task that claims to be done and whose tests fail does not pass for done.
 */

const { proofNote } = require('../../engine/proof');

/** The kinds of proof item, in the order they are read. */
const KINDS = ['tests', 'screenshots', 'diff', 'review'];

/** How much of an item's own data is kept. */
const MAX_DETAIL = 64 * 1024;

const iso = (v) => {
    if (!v) return null;
    const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

function createProof({ store, config = {}, log = console }) {
    const db = store.db;

    /**
     * The proof of one attempt: the rows, and the lines the task's stream shows (one per item).
     *
     * Recording the same attempt twice changes nothing: the row's place in the proof is fixed (the attempt's number
     * and the item's), so a second recording finds the rows there and writes no second event.
     *
     * @param {string} taskId the task
     * @param {number|null} attemptN the attempt the proof belongs to
     * @param {object[]} items the proof items
     * @returns {Promise<{ rows: object[], lines: object[] }>} the rows, and the lines to append to the stream
     */
    async function record(taskId, attemptN, items) {
        const list = Array.isArray(items) ? items : [];
        if (!taskId || !list.length) return { rows: [], lines: [] };
        const known = await db.many('SELECT id, n FROM codes_task_proof WHERE task_id = $1', [taskId]);
        const seen = new Set(known.map((r) => Number(r.n)));
        const attempt = attemptN == null ? 0 : Number(attemptN);
        const stored = [];
        for (const item of list) {
            const kind = KINDS.includes(item && item.kind) ? item.kind : 'note';
            let n = stored.length + 1;
            while (seen.has(n)) n++;
            seen.add(n);
            const id = store.newId('prf');
            const detail = item && item.detail !== undefined ? item.detail : item;
            let body = null;
            try { body = JSON.stringify(detail); } catch { body = null; }
            if (body && body.length > MAX_DETAIL) body = body.slice(0, MAX_DETAIL);
            const row = await db.maybe(
                'INSERT INTO codes_task_proof (id, task_id, attempt_n, n, kind, label, ok, skipped, summary, family, detail, created_at)'
                + ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::timestamptz)'
                + ' ON CONFLICT DO NOTHING RETURNING *',
                [id, taskId, attempt, n, kind, clip(item && item.label, 80),
                    item && item.ok === false ? false : true, item && item.skipped === true ? true : false,
                    clip(item && item.summary, 1000), clip(item && item.family, 80), body, store.iso()],
            );
            if (row) stored.push(row);
        }
        // One line per item on the task's stream, after the lines that are already there.
        let seq = await nextSeq(taskId);
        const at = store.iso();
        const lines = stored.map((row) => ({
            seq: seq++, at, kind: 'proof',
            body: {
                t: 'proof', kind: row.kind, label: row.label, ok: row.ok === true,
                skipped: row.skipped === true, summary: row.summary || null, family: row.family || null,
            },
        }));
        return { rows: stored, lines };
    }

    /** The first seq on the task's stream that nothing uses. */
    async function nextSeq(taskId) {
        const rows = await db.many('SELECT seq FROM codes_session_lines WHERE task_id = $1', [taskId]);
        const taken = new Set(rows.map((r) => Number(r.seq)));
        const max = rows.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0);
        let seq = max + 1;
        let tries = 0;
        while (taken.has(seq) && tries++ < 10000) seq++;
        return seq;
    }

    /** The items of a task, in order. */
    async function list(taskId) {
        if (!taskId) return [];
        return await db.many('SELECT * FROM codes_task_proof WHERE task_id = $1 ORDER BY n ASC', [taskId]);
    }

    /** The items as the API shows them. */
    function present(items) {
        return (Array.isArray(items) ? items : []).map((r) => ({
            kind: r.kind,
            label: r.label,
            ok: r.ok === true,
            skipped: r.skipped === true,
            summary: r.summary || null,
            family: r.family || null,
            attempt_n: r.attempt_n == null ? null : Number(r.attempt_n),
            detail: r.detail || null,
            created_at: iso(r.created_at),
        }));
    }

    /**
     * The outcome in plain words, from the proof.
     *
     * @param {object[]} items the proof items
     * @param {object} [fallback] { state, note } the outcome without a proof (the engine's own verdict)
     * @returns {{ state: string, note: string }} the outcome
     */
    function outcomeOf(items, fallback = {}) {
        const list = Array.isArray(items) ? items : [];
        if (!list.length) return { state: fallback.state || null, note: fallback.note || null };
        const failed = list.filter((i) => i && i.ok === false);
        const note = proofNote(list);
        // Proof, not promises: when the evidence failed, the task is not called done, whatever the agent claimed. A task
        // the person stopped stays stopped: that outcome is theirs, not the evidence's.
        const state = fallback.state === 'stopped' ? 'stopped' : (failed.length ? 'unfinished' : (fallback.state || 'done'));
        return { state, note: note + (fallback.note ? ' ' + fallback.note : '') };
    }

    return { KINDS, record, list, present, outcomeOf };
}

module.exports = { createProof, KINDS };
