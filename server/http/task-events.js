'use strict';

/**
 * A task's event stream (GET /api/v1/tasks/:id/events): the session's lines in the order they happened, the attempt
 * each line belongs to, and the attempts themselves (started, ended with why). The stream is resumable: a client
 * that reconnects sends the last line's seq as Last-Event-ID and gets only what came after it. A heartbeat every 15
 * seconds keeps the connection alive through a proxy that would otherwise drop it.
 *
 *   createTaskEvents({ store, config, log, attempts })
 *     stream(req, res, row)   the stream of one task
 *
 * The lines come from codes_session_lines (the session the machine streamed, back-filled from its final result) and
 * the attempts from codes_attempts. Nothing here writes anything: the stream only reads.
 */

const { TERMINAL } = require('../domain/run-tasks');

const POLL_MS = 1000;
const PAGE = 500;
const ENDED = ['done', 'failed', 'stopped', 'budget-stopped', 'interrupted'];

function createTaskEvents({ store, config = {}, log = console, attempts = null }) {
    const db = store.db;
    const heartbeatMs = Math.max(1000, Number(config.sse && config.sse.heartbeatMs) || 15_000);
    const attemptStore = attempts || require('../domain/attempts').createAttempts({ store, config, log });

    /** One SSE frame. */
    const frame = (event, data, id = null) => (id == null ? '' : `id: ${id}\n`) + `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    const started = (a) => ({
        type: 'attempt_started', attempt_n: Number(a.n), id: a.id, agent: a.agent || null, model: a.model || null, effort: a.effort || null,
        why: a.why || null, state: 'queued', at: a.created_at ? new Date(a.created_at).toISOString() : null,
    });
    const ended = (a) => ({
        type: 'attempt_ended', attempt_n: Number(a.n), id: a.id, agent: a.agent || null, model: a.model || null,
        why: a.why || null, state: a.state, reason: a.reason || null,
        end_why: a.reason ? attemptStore.wordsOf(a.reason) : null,
        cost_usd: a.cost_usd == null ? null : Number(a.cost_usd),
        tokens: a.tokens == null ? null : Number(a.tokens),
        steps: a.steps == null ? null : Number(a.steps),
        at: a.finished_at ? new Date(a.finished_at).toISOString() : null,
    });

    /** The stream of one task: its lines, its attempts, a heartbeat, and an end when the task has ended. */
    async function stream(req, res, row) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no',
            Connection: 'keep-alive',
        });
        if (res.flushHeaders) res.flushHeaders();

        const asked = String(req.get('last-event-id') || (req.query && req.query.last_event_id) || '0').trim();
        let lastSeq = /^\d+$/.test(asked) ? Number(asked) : 0;
        let closed = false;
        let busy = false;
        let terminalAt = 0;

        const write = (text) => {
            if (closed || !text) return;
            res.write(text);
        };

        // The attempts a client has not seen: from the attempt its last line belongs to.
        const anchor = lastSeq
            ? await db.maybe('SELECT attempt_n FROM codes_session_lines WHERE task_id = $1 AND seq = $2', [row.id, lastSeq])
            : null;
        const fromN = anchor && anchor.attempt_n ? Number(anchor.attempt_n) : 1;
        const known = await attemptStore.list(row.id);
        const sent = new Map(known.map((a) => [a.id, a.state]));
        let out = '';
        for (const a of known) {
            if (Number(a.n) < fromN) continue;
            out += frame('attempt', started(a));
            if (ENDED.includes(a.state)) out += frame('attempt', ended(a));
        }
        write(out);

        const sendLines = async () => {
            const lines = await db.many(
                'SELECT seq, at, kind, body, attempt_n FROM codes_session_lines WHERE task_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3',
                [row.id, lastSeq, PAGE],
            );
            for (const line of lines) {
                write(frame('line', {
                    seq: Number(line.seq),
                    at: line.at ? new Date(line.at).toISOString() : null,
                    kind: line.kind,
                    attempt_n: line.attempt_n == null ? null : Number(line.attempt_n),
                    body: line.body,
                }, Number(line.seq)));
                lastSeq = Math.max(lastSeq, Number(line.seq));
            }
            return lines.length;
        };
        await sendLines();

        // The proof of the task (stage C8): one event per item — the tests, the pages, the diff, the review.
        const sentProof = new Set();
        const sendProof = async () => {
            const items = await db.many('SELECT * FROM codes_task_proof WHERE task_id = $1 ORDER BY n ASC', [row.id]);
            let wrote = 0;
            for (const item of items) {
                if (sentProof.has(item.id)) continue;
                sentProof.add(item.id);
                wrote++;
                write(frame('proof', {
                    id: item.id,
                    n: Number(item.n),
                    kind: item.kind,
                    label: item.label,
                    ok: item.ok === true,
                    skipped: item.skipped === true,
                    summary: item.summary || null,
                    family: item.family || null,
                    attempt_n: item.attempt_n == null ? null : Number(item.attempt_n),
                    at: item.created_at ? new Date(item.created_at).toISOString() : null,
                }));
            }
            return wrote;
        };
        await sendProof();

        const tick = async () => {
            if (closed || busy) return;
            busy = true;
            try {
                const sentLines = await sendLines();
                await sendProof();
                const fresh = await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [row.id]);
                const rows = await attemptStore.list(row.id);
                let updates = '';
                for (const a of rows) {
                    const was = sent.get(a.id);
                    if (was === a.state) continue;
                    sent.set(a.id, a.state);
                    if (was === undefined) updates += frame('attempt', started(a));
                    if (ENDED.includes(a.state)) updates += frame('attempt', ended(a));
                }
                write(updates);
                if (fresh && TERMINAL.has(fresh.state) && !rows.some((a) => ['queued', 'running'].includes(a.state))) {
                    if (!terminalAt) terminalAt = Date.now();
                    // The task has ended and its outcome is known: the stream is done. A task whose decision is still
                    // being made (no outcome yet) keeps the stream a little longer, so a follow-up is not missed.
                    if (fresh.outcome || Date.now() - terminalAt > 10_000) {
                        closed = true;
                        clearInterval(poll);
                        clearInterval(beat);
                        res.end();
                    }
                } else {
                    terminalAt = 0;
                }
            } catch (e) {
                log.warn(`[Codes] task ${row.id} events: ${e.message}`);
            } finally {
                busy = false;
            }
        };

        const poll = setInterval(tick, POLL_MS);
        const beat = setInterval(() => write(': heartbeat\n\n'), heartbeatMs);
        const stop = () => {
            if (closed) return;
            closed = true;
            clearInterval(poll);
            clearInterval(beat);
        };
        req.on('close', stop);
        res.on('close', stop);
        return undefined;
    }

    return { stream, heartbeatMs };
}

module.exports = { createTaskEvents };
