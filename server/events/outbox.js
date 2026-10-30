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
 * a failure's attempt and backoff, and leaves it for the next pass. An event OpenVibe.Events refuses (its envelope
 * can never pass) is marked dead after a fixed number of tries instead of being retried forever. Under CODES_DRILL
 * no loop starts.
 *
 *   { task_id, state, agent, repo, cost_usd, files_changed, started_at, finished_at, error }
 */
const { ids, serviceAuth, validate } = require('openvibe-contracts');

const TOPICS = Object.freeze([
    'codes.task.queued', 'codes.task.running', 'codes.task.succeeded', 'codes.task.failed', 'codes.task.cancelled',
]);
const TOPIC_SET = new Set(TOPICS);
const MAX_BACKOFF_MS = 5 * 60_000;
// The envelope contract (events.event-envelope@1): the envelope Codes sends has to match it, or OpenVibe.Events
// refuses the event with a 422 and the row is retried forever.
const ENVELOPE_CONTRACT = 'events.event-envelope@1';
// An event Events refused (4xx: its envelope can never pass) is dead after this many tries; an event that keeps
// failing for another reason is dead after this many. A dead event is not sent again.
const DEAD_AFTER_REFUSALS = 3;
const DEAD_AFTER_ATTEMPTS = 20;

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
    const stats = { published: 0, failed: 0, dead: 0, last_error: null };
    // How many tries an event gets before it is marked dead: a refusal (its envelope can never pass) fewer than a
    // failure of another kind.
    const deadAfterRefusals = Math.max(1, Number((config.events && config.events.deadAfterRefusals) || DEAD_AFTER_REFUSALS));
    const deadAfterAttempts = Math.max(1, Number((config.events && config.events.deadAfterAttempts) || DEAD_AFTER_ATTEMPTS));
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
                 WHERE o2.published_at IS NULL AND o2.dead_at IS NULL AND o2.next_attempt_at <= $1::timestamptz
                   AND (o2.claimed_at IS NULL OR o2.claimed_at < $3::timestamptz)
                 ORDER BY o2.created_at ASC, o2.event_id ASC
                 LIMIT $4
                 FOR UPDATE SKIP LOCKED
             )
             RETURNING o.*`,
            [now, worker, stale, Math.min(100, Math.max(1, limit))],
        );
    }

    /**
     * The envelope OpenVibe.Events is given (events.event-envelope@1): the priority is one of the contract's own
     * three words (critical | important | low), never a word of Codes' own.
     */
    function envelope(row) {
        return {
            event_id: row.event_id,
            event_type: row.topic,
            version: 1,
            source: 'codes',
            actor: { type: 'user', id: row.subject },
            subject: { type: 'user', id: row.subject },
            timestamp: store.iso(),
            priority: 'important',
            visibility: 'internal',
            payload: row.payload,
        };
    }

    /**
     * What is wrong with an envelope, per the contract itself: null when it matches. It is a warning, not a refusal:
     * OpenVibe.Events is the authority on what it accepts, and an envelope that does not match here is sent anyway
     * (and refused there, which is what marks the row dead).
     */
    function envelopeIssue(doc) {
        try {
            const out = validate(ENVELOPE_CONTRACT, doc);
            if (!out || out.valid) return null;
            const errors = Array.isArray(out.errors) ? out.errors : [];
            return errors.map((e) => `${e.path || ''} ${e.message || ''}`.trim()).join('; ') || 'the envelope does not match the contract';
        } catch (e) {
            return null;   // the contract is not in the pinned version: nothing to say about it
        }
    }

    async function send(row) {
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...(await tokens.authHeaders()) };
        const doc = envelope(row);
        const issue = envelopeIssue(doc);
        if (issue) log.warn(`[Codes] outbox ${row.event_id} does not match ${ENVELOPE_CONTRACT}: ${issue}`);
        const res = await fetchImpl(`${eventsUrl}/api/v1/events`, {
            method: 'POST', headers, body: JSON.stringify(doc), signal: AbortSignal.timeout(15_000),
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
                    // A refusal (4xx) is the envelope being turned down: it can never pass, so it dies after a fixed
                    // number of tries. Another failure is worth more tries, and dies too in the end.
                    const status = Number(err && err.status) || 0;
                    const refused = status >= 400 && status < 500;
                    const deadAfter = refused ? deadAfterRefusals : deadAfterAttempts;
                    if (attempts >= deadAfter) {
                        await db.exec(
                            `UPDATE codes_outbox SET attempts = attempts + 1, last_error = $1, dead_at = $2::timestamptz, dead_reason = $3,
                               claimed_at = NULL, claimed_by = NULL WHERE event_id = $4`,
                            [message, store.iso(), refused ? 'refused' : 'failed', row.event_id],
                        );
                        stats.dead++;
                        log.warn(`[Codes] outbox ${row.event_id} is dead after ${attempts} tries: ${message}`);
                        continue;
                    }
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
        pending: async () => Number(await db.value('SELECT COUNT(*)::int AS n FROM codes_outbox WHERE published_at IS NULL AND dead_at IS NULL')) || 0,
        dead: async () => Number(await db.value('SELECT COUNT(*)::int AS n FROM codes_outbox WHERE dead_at IS NOT NULL')) || 0,
        status: async () => ({
            enabled: configured,
            pending: await db.value('SELECT COUNT(*)::int AS n FROM codes_outbox WHERE published_at IS NULL AND dead_at IS NULL'),
            dead: await db.value('SELECT COUNT(*)::int AS n FROM codes_outbox WHERE dead_at IS NOT NULL'),
            last_error: stats.last_error,
        }),
        stats: () => ({ ...stats }),
    };
}

module.exports = { createOutbox, createPublisher, TOPICS, TOPIC_SET, topicFor, groupOf, payloadOf, repoSlug, MAX_BACKOFF_MS, DEAD_AFTER_REFUSALS, DEAD_AFTER_ATTEMPTS };
