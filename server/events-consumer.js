'use strict';

/**
 * OpenVibe.Events → Codes, and the subscriptions that bring the deliveries (plan 2026-10-28 §6, decision 2).
 *
 *   run.job.queued|started|succeeded|failed|cancelled|expired
 *                         a job that is a Codes task is finalized from its event (state, timings, and on an end state
 *                         the result read once from Run). The event id is claimed in codes_events_inbox in the same
 *                         transaction as the row update, so a redelivery changes nothing.
 *   network.account.export_requested / network.account.deleted
 *                         handed to openvibe-sdk/account-data (server/account-data.js), which keeps its own idempotency.
 *
 * POST /internal/events is a signed v2 delivery endpoint (loopback only; nginx answers 404 for /internal), the shape
 * Help and Today use. startSubscriptions() creates the missing subscriptions at Events at boot, idempotently, with
 * backoff; it is off without EVENTS_URL/CODES_EVENTS_SECRET/the OAuth client secret, under CODES_DRILL, or when
 * CODES_EVENTS_SUBSCRIBE=0.
 *
 *   const consumer = createEventsConsumer({ config, store, tasks, run, accountData, accountSend, log });
 *   app.use('/internal/events', consumer.router);
 */
const express = require('express');
const { http, serviceAuth } = require('openvibe-contracts');
const { parseDelivery } = require('openvibe-sdk/events');
const accountDataLib = require('openvibe-sdk/account-data');
const { TERMINAL, STATES } = require('./domain/run-tasks');

const RUN_TOPICS = Object.freeze([
    'run.job.queued', 'run.job.started', 'run.job.succeeded', 'run.job.failed', 'run.job.cancelled', 'run.job.expired',
]);
const TOPICS = Object.freeze([...RUN_TOPICS, ...accountDataLib.TOPICS]);
const EVENT_ID_RE = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/;
const JOB_RE = /^job_[0-9A-HJKMNP-TV-Z]{26}$/;
const STATE_OF_TOPIC = {
    'run.job.queued': 'queued', 'run.job.started': 'running', 'run.job.succeeded': 'succeeded',
    'run.job.failed': 'failed', 'run.job.cancelled': 'cancelled', 'run.job.expired': 'expired',
};

function errorText(error) {
    if (!error) return null;
    if (typeof error === 'string') return error.slice(0, 1000);
    if (typeof error === 'object') return `${error.code || 'run.error'}${error.detail ? `: ${error.detail}` : ''}`.slice(0, 1000);
    return null;
}

function createEventsConsumer({ config, store, tasks, run, accountData, accountSend = null, log = console, now = store.now }) {
    const db = store.db;
    const secrets = (config.events && config.events.secrets ? config.events.secrets : []).filter((x) => typeof x === 'string' && x.length >= 32);
    const stats = { received: 0, applied: 0, duplicates: 0, ignored: 0, refused: 0, failed: 0, last_at: null };

    /** Record an event that had no effect; a replay answers duplicate. */
    async function ignore(event, outcome, taskId = null) {
        const inserted = await db.maybe(
            `INSERT INTO codes_events_inbox (event_id, event_type, task_id, outcome, processed_at)
             VALUES ($1, $2, $3, $4, $5::timestamptz) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
            [event.event_id, event.event_type, taskId, outcome, store.iso()],
        );
        return { duplicate: !inserted, outcome: inserted ? outcome : null, task_id: taskId || undefined };
    }

    async function handleRun(event) {
        const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : null;
        if (!payload) return await ignore(event, 'ignored:payload');
        const jobId = String(payload.job_id || '');
        if (!JOB_RE.test(jobId)) return await ignore(event, 'ignored:payload');
        const state = STATES.has(payload.state) ? payload.state : STATE_OF_TOPIC[event.event_type];
        if (!state) return await ignore(event, 'ignored:payload');
        const seen = await db.maybe('SELECT task_id FROM codes_events_inbox WHERE event_id = $1', [event.event_id]);
        if (seen) return { duplicate: true, outcome: null, task_id: seen.task_id || undefined };
        const row = await db.maybe('SELECT * FROM run_tasks WHERE job_id = $1', [jobId]);
        if (!row) return await ignore(event, 'ignored:not_a_codes_task');
        const requester = payload.requester && typeof payload.requester === 'object' ? payload.requester.id : null;
        if (requester && requester !== row.subject) return await ignore(event, 'ignored:another_subject', row.id);
        if (payload.project_id && payload.project_id !== row.project_id) return await ignore(event, 'ignored:another_project', row.id);

        // A terminal event reads the job once for the result (run.job.* carry no result). A failure here is retried by
        // Events; the inbox row is only written in the transaction that applies the event.
        let job = null;
        if (TERMINAL.has(state)) job = await run.read(jobId, tasks.who(row));

        return await store.tx(async () => {
            const inserted = await db.maybe(
                `INSERT INTO codes_events_inbox (event_id, event_type, task_id, outcome, processed_at)
                 VALUES ($1, $2, $3, $4, $5::timestamptz) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
                [event.event_id, event.event_type, row.id, state, store.iso()],
            );
            if (!inserted) return { duplicate: true, outcome: null, task_id: row.id };
            await tasks.applyEvent(row, {
                state, job, error: errorText(payload.error), timings: payload.timings && typeof payload.timings === 'object' ? payload.timings : null,
            });
            await db.exec('UPDATE codes_events_inbox SET outcome = $2 WHERE event_id = $1', [event.event_id, state]);
            return { duplicate: false, outcome: state, task_id: row.id };
        });
    }

    const router = express.Router();
    router.post('/', express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
        const ctx = http.requestContext(req.headers);
        const problem = (status, code, detail) => http.sendProblem(res, status, code, { detail, ctx });
        if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']) return problem(403, 'codes.internal_only', 'internal route');
        if (!secrets.length) return problem(503, 'codes.events_disabled', 'CODES_EVENTS_SECRET is not set');
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let delivery = null;
        for (const secret of secrets) { delivery = parseDelivery(raw, req.headers, secret, { requireV2: true, now: now() }); if (delivery) break; }
        if (!delivery) { stats.refused++; return problem(401, 'codes.bad_signature', 'X-OpenVibe-Signature-V2 does not verify or is outside the replay window'); }
        const event = delivery.event;
        if (!event || !EVENT_ID_RE.test(String(event.event_id || '')) || typeof event.event_type !== 'string') {
            stats.refused++;
            return problem(400, 'codes.bad_delivery', 'body must be { event: <envelope>, seq }');
        }
        stats.received++;
        stats.last_at = new Date(now()).toISOString();

        if (accountDataLib.TOPICS.includes(event.event_type)) {
            let outcome;
            try { outcome = await accountData.apply(event, { send: accountSend }); } catch (err) {
                stats.failed++;
                log.error(`[Codes] account event ${event.event_id} failed:`, err.message);
                return problem(503, 'codes.event_failed', 'processing failed; it will be retried');
            }
            if (String(outcome).startsWith('ignored:')) stats.ignored++; else stats.applied++;
            return res.json({ event_id: event.event_id, outcome });
        }

        if (!RUN_TOPICS.includes(event.event_type)) {
            const result = await ignore(event, 'ignored:type');
            if (result.duplicate) stats.duplicates++; else stats.ignored++;
            return res.json({ event_id: event.event_id, duplicate: result.duplicate, outcome: result.outcome });
        }

        let result;
        try { result = await handleRun(event); } catch (err) {
            stats.failed++;
            log.error(`[Codes] event ${event.event_id} (${event.event_type}) failed:`, err.message);
            return problem(503, 'codes.event_failed', 'processing failed; it will be retried');
        }
        if (result.duplicate) { stats.duplicates++; return res.json({ event_id: event.event_id, duplicate: true, outcome: null }); }
        if (String(result.outcome).startsWith('ignored:')) stats.ignored++; else stats.applied++;
        return res.json({ event_id: event.event_id, duplicate: false, outcome: result.outcome, ...(result.task_id ? { task_id: result.task_id } : {}) });
    });

    return { router, topics: TOPICS, runTopics: RUN_TOPICS, stats: () => ({ ...stats, enabled: secrets.length > 0 }) };
}

/** Create any missing subscription for `topics` at Events (idempotent; retried in the background at boot). */
function startSubscriptions(opts = {}) {
    const config = opts.config || {};
    const events = config.events || {};
    const oauth = config.oauth || {};
    const port = opts.port != null ? opts.port : config.port;
    const secret = opts.secret != null ? opts.secret : (events.secrets && events.secrets[0]) || '';
    const eventsUrl = opts.eventsUrl != null ? opts.eventsUrl : events.url;
    const networkInternalUrl = opts.networkInternalUrl || config.networkInternalUrl;
    const clientId = opts.clientId || oauth.clientId;
    const clientSecret = opts.clientSecret || oauth.clientSecret;
    const drill = opts.drill != null ? opts.drill : config.drill;
    const topics = opts.topics || TOPICS;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const log = opts.log || console;
    if (!eventsUrl || !secret || !clientSecret || drill || process.env.CODES_EVENTS_SUBSCRIBE === '0') return null;
    const base = String(eventsUrl).replace(/\/+$/, '');
    const endpoint = opts.endpoint || events.endpoint || `http://127.0.0.1:${port}/internal/events`;
    const tokens = serviceAuth.createTokenClient({
        tokenUrl: `${networkInternalUrl}/oauth/token`, clientId, clientSecret,
        audience: 'openvibe.events', scope: 'events.subscription.manage', fetchImpl,
    });
    const call = async (method, path, body) => {
        const res = await fetchImpl(`${base}${path}`, {
            method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await tokens.authHeaders()) },
            body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
        });
        const json = await res.json().catch(() => ({}));
        return { status: res.status, ok: res.ok, body: json };
    };
    const attempt = async () => {
        const listed = await call('GET', '/api/v1/subscriptions');
        if (!listed.ok) throw new Error(`listing subscriptions: ${listed.status}`);
        const mine = (listed.body.subscriptions || []).filter((s) => s.endpoint === endpoint);
        for (const topic of topics) {
            if (mine.some((s) => s.topic_pattern === topic)) continue;
            const r = await call('POST', '/api/v1/subscriptions', { topic_pattern: topic, endpoint, secret });
            if (!r.ok && r.status !== 409) throw new Error(`subscribing to ${topic}: ${r.status} ${r.body.code || ''}`);
            if (r.ok) log.log(`[Events consumer] subscription created: ${r.body.id} (${topic} → ${endpoint})`);
        }
    };
    const delays = [0, 10_000, 60_000, 5 * 60_000, 15 * 60_000];
    let i = 0;
    let timer = null;
    let stopped = false;
    const run = () => {
        timer = null;
        if (stopped) return;
        attempt().catch((err) => {
            if (stopped) return;
            if (++i < delays.length) { timer = setTimeout(run, delays[i]); if (timer.unref) timer.unref(); }
            else log.warn('[Events consumer] subscriptions not created:', err.message);
        });
    };
    timer = setTimeout(run, delays[0]); if (timer.unref) timer.unref();
    return { topics, endpoint, stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; } };
}

module.exports = { createEventsConsumer, startSubscriptions, RUN_TOPICS, TOPICS, EVENT_ID_RE };
