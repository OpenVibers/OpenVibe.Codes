'use strict';

/**
 * codes.task.* events out (plan 2026-10-28 §6, decision 3): the transactional outbox the task's state changes write
 * into, and the relay that publishes it to OpenVibe.Events.
 *
 *   const outbox = createOutbox({ store });
 *   await store.tx(async () => { …change run_tasks…; await outbox.emitTask(row, before.state); });
 *
 * The fixed evt_ id is chosen at insert, so a retry or a restart never makes a second event. The publisher claims due
 * rows with a short lease (two processes never send one row at once), sends each envelope once under that id, records
 * a failure's attempt and backoff, and leaves it for the next pass. Under CODES_DRILL no loop starts.
 *
 *   { task_id, state, agent, repo, cost_usd, files_changed, started_at, finished_at, error }
 */
const { ids, serviceAuth } = require('openvibe-contracts');

const TOPICS = Object.freeze([
    'codes.task.queued', 'codes.task.running', 'codes.task.succeeded', 'codes.task.failed', 'codes.task.cancelled',
]);
const TOPIC_SET = new Set(TOPICS);
const MAX_BACKOFF_MS = 5 * 60_000;

/** queued | running | succeeded | failed | cancelled: the five states codes.task.* announces. */
function groupOf(state) {
    if (state === 'queued') return 'queued';
    if (state === 'placed' || state === 'running') return 'running';
    if (state === 'succeeded') return 'succeeded';
    if (state === 'failed' || state === 'expired') return 'failed';
    if (state === 'cancelled') return 'cancelled';
    return null;
}

function topicFor(state, previousState) {
    const group = groupOf(state);
    if (!group) return null;
    if (groupOf(previousState) === group) return null;   // placed → running is the same announced state
    return `codes.task.${group}`;
}

/** owner/name from a repository URL, or null (never a host or a query string). */
function repoSlug(url) {
    if (typeof url !== 'string') return null;
    try {
        const u = new URL(url);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        const parts = u.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/').filter(Boolean);
        return parts.length >= 2 ? `${parts[0]}/${parts[1]}`.slice(0, 300) : null;
    } catch { return null; }
}

function objectOf(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string') { try { const v = JSON.parse(value); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } }
    return null;
}

const isoOf = (value) => {
    if (value == null) return null;
    const t = value instanceof Date ? value.getTime() : Date.parse(String(value));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** The payload the proposal schemas describe; `state` is the announced state (placed is running). */
function payloadOf(row) {
    const result = objectOf(row.result) || {};
    const state = groupOf(row.state);
    const cost = typeof result.cost_usd === 'number' && Number.isFinite(result.cost_usd) && result.cost_usd >= 0 ? result.cost_usd : null;
    const files = Array.isArray(result.files) ? result.files.length : null;
    return {
        task_id: row.id,
        state: state || row.state,
        agent: row.agent == null ? null : String(row.agent).slice(0, 80),
        repo: repoSlug(row.repo),
        cost_usd: cost,
        files_changed: files,
        started_at: isoOf(row.started_at),
        finished_at: isoOf(row.finished_at),
        error: row.error == null ? null : String(row.error).slice(0, 500),
    };
}

function createOutbox({ store, log = console }) {
    const db = store.db;

    /** Write the state change's event in the caller's (ambient) transaction. → the evt_ id, or null. */
    async function emitTask(row, previousState) {
        if (!row || !row.id || !row.subject) return null;
        const topic = topicFor(row.state, previousState);
        if (!topic || !TOPIC_SET.has(topic)) return null;
        const eventId = ids.newId('event', store.now());
        const at = store.iso();
        await db.exec(
            `INSERT INTO codes_outbox (event_id, topic, subject, payload, created_at, next_attempt_at)
             VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $5::timestamptz)`,
            [eventId, topic, row.subject, JSON.stringify(payloadOf(row)), at],
        );
        return eventId;
    }

    return { emitTask, payloadOf, topicFor, groupOf };
}

function createPublisher({ config, store, fetchImpl = globalThis.fetch, log = console, intervalMs = (config.events && config.events.intervalMs) || 5000 }) {
    const db = store.db;
    const worker = `codes-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
    const eventsUrl = String((config.events && config.events.url) || '').replace(/\/+$/, '');
    const configured = Boolean(eventsUrl && config.oauth && config.oauth.clientSecret);
    const tokens = configured ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.events',
        scope: (config.events && config.events.scope) || 'events.event.publish',
        fetch: fetchImpl,
    }) : null;
    const stats = { published: 0, failed: 0, last_error: null };
    let timer = null;
    let running = false;
    let active = false;

    function backoffMs(attempts) {
        return Math.min(MAX_BACKOFF_MS, 5000 * Math.pow(2, Math.max(0, Math.min(6, attempts))));
    }

    async function claim(limit = 20) {
        const now = store.iso();
        const stale = new Date(store.now() - 2 * 60_000).toISOString();
        return await db.many(
            `UPDATE codes_outbox o SET claimed_at = $1::timestamptz, claimed_by = $2
             WHERE o.event_id IN (
                 SELECT o2.event_id FROM codes_outbox o2
                 WHERE o2.published_at IS NULL AND o2.next_attempt_at <= $1::timestamptz
                   AND (o2.claimed_at IS NULL OR o2.claimed_at < $3::timestamptz)
                 ORDER BY o2.created_at ASC, o2.event_id ASC
                 LIMIT $4
                 FOR UPDATE SKIP LOCKED
             )
             RETURNING o.*`,
            [now, worker, stale, Math.min(100, Math.max(1, limit))],
        );
    }

    function envelope(row) {
        return {
            event_id: row.event_id,
            event_type: row.topic,
            version: 1,
            source: 'codes',
            actor: { type: 'user', id: row.subject },
            subject: { type: 'user', id: row.subject },
            timestamp: store.iso(),
            priority: 'normal',
            visibility: 'internal',
            payload: row.payload,
        };
    }

    async function send(row) {
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...(await tokens.authHeaders()) };
        const res = await fetchImpl(`${eventsUrl}/api/v1/events`, {
            method: 'POST', headers, body: JSON.stringify(envelope(row)), signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            const err = new Error(`events ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
            err.status = res.status;
            throw err;
        }
        await db.exec('UPDATE codes_outbox SET published_at = $1::timestamptz, claimed_at = NULL, claimed_by = NULL, last_error = NULL WHERE event_id = $2',
            [store.iso(), row.event_id]);
    }

    async function runOnce({ limit = 20 } = {}) {
        if (!configured) return { configured: false, claimed: 0, published: 0, failed: 0 };
        if (running) return { configured: true, busy: true, claimed: 0, published: 0, failed: 0 };
        running = true;
        let claimed = 0; let published = 0; let failed = 0;
        try {
            const rows = await claim(limit);
            claimed = rows.length;
            for (const row of rows) {
                try {
                    await send(row);
                    published++;
                    stats.published++;
                } catch (err) {
                    failed++;
                    stats.failed++;
                    const message = String((err && err.message) || err).slice(0, 500);
                    stats.last_error = message;
                    const attempts = Number(row.attempts) + 1;
                    const next = new Date(store.now() + backoffMs(attempts)).toISOString();
                    await db.exec(
                        `UPDATE codes_outbox SET attempts = attempts + 1, last_error = $1, claimed_at = NULL, claimed_by = NULL,
                           next_attempt_at = $2::timestamptz WHERE event_id = $3`,
                        [message, next, row.event_id],
                    );
                    log.warn(`[Codes] outbox ${row.event_id} publish failed (attempt ${attempts}): ${message}`);
                }
            }
            return { configured: true, claimed, published, failed };
        } finally { running = false; }
    }

    function schedule(ms) {
        if (!configured || config.drill || !active) return;
        timer = setTimeout(async () => {
            timer = null;
            try { await runOnce(); } catch (err) { log.warn('[Codes] outbox tick failed:', err.message); }
            schedule(intervalMs);
        }, ms);
        if (timer.unref) timer.unref();
    }

    return {
        configured, runOnce,
        start() { if (!configured || config.drill || timer) return false; active = true; schedule(0); return true; },
        stop() { active = false; if (timer) clearTimeout(timer); timer = null; return Promise.resolve(); },
        pending: async () => Number(await db.value('SELECT COUNT(*)::int AS n FROM codes_outbox WHERE published_at IS NULL')) || 0,
        status: async () => ({ enabled: configured, pending: await db.value('SELECT COUNT(*)::int AS n FROM codes_outbox WHERE published_at IS NULL'), last_error: stats.last_error }),
        stats: () => ({ ...stats }),
    };
}

module.exports = { createOutbox, createPublisher, TOPICS, TOPIC_SET, topicFor, groupOf, payloadOf, repoSlug, MAX_BACKOFF_MS };
