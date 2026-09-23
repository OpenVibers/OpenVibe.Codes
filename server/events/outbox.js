'use strict';

/**
 * Codes → OpenVibe.Events through the openvibe-sdk transactional outbox (ADR-004).
 *
 *   codes.app.published    a release became public            subject { type: 'app', id: app_… }
 *   codes.app.deprecated   a public release was deprecated    (payload: release id, version, kind,
 *   codes.app.revoked      a public release was revoked        environment, trust tier, reason…)
 *
 * emit() runs inside the SQLite transaction that makes the change, so an event exists if and only
 * if its change committed. The relay publishes with Codes' OWN service token (events.event.publish,
 * audience openvibe.events) only when EVENTS_URL and OV_OAUTH_CLIENT_SECRET are set; otherwise rows
 * wait in event_outbox and /api/ready reports the relay as off. Payloads never carry a secret.
 */
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createEventsClient, createOutbox } = require('openvibe-sdk/events');

const EVENT_TYPES = ['codes.app.published', 'codes.app.deprecated', 'codes.app.revoked'];

function createCodesOutbox({ db, config, fetchImpl, now, log = console }) {
    const enabled = Boolean(config.events.url && config.oauth.clientSecret);
    const clientOpts = { baseUrls: { events: config.events.url || 'http://127.0.0.1:4300' }, retries: 0, autoDiscover: false };
    if (fetchImpl) clientOpts.fetch = fetchImpl;
    if (enabled) {
        clientOpts.tokenProvider = createServiceTokenClient({
            tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
            scope: { 'openvibe.events': 'events.event.publish' }, ...(fetchImpl ? { fetch: fetchImpl } : {}),
        });
    } else {
        clientOpts.getToken = async () => { throw new Error('events relay disabled (EVENTS_URL / OV_OAUTH_CLIENT_SECRET unset)'); };
    }
    const events = createEventsClient(createClient(clientOpts), { source: 'codes' });
    let lastError = null;
    const outbox = createOutbox(db, {
        events,
        intervalMs: config.events.intervalMs,
        now,
        onError: (err) => {
            const msg = err && err.message;
            if (msg !== lastError) log.warn('[Codes] event publish failed (will retry):', msg);
            lastError = msg;
        },
    });
    outbox.ensureSchema();

    /** Inside the caller's transaction. Returns the complete envelope (with its event_id). */
    function emit(envelope, { traceparent } = {}) {
        if (!EVENT_TYPES.includes(envelope.event_type)) throw new Error(`Codes does not produce ${envelope.event_type}`);
        return outbox.enqueue(envelope, { traceparent });
    }

    return {
        emit,
        outbox,
        enabled,
        start() { if (enabled) outbox.start(); },
        stop: () => outbox.stop(),
        status: () => ({ enabled, pending: outbox.pending(), rejected: outbox.rejected(), last_error: lastError }),
    };
}

module.exports = { createCodesOutbox, EVENT_TYPES };
