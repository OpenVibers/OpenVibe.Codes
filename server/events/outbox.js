'use strict';

/**
 * Codes → OpenVibe.Events through the openvibe-sdk transactional outbox (ADR-004).
 *
 *   codes.app.published    a release became public            subject { type: 'app', id: app_… }
 *   codes.app.deprecated   a public release was deprecated    (payload: release id, version, kind,
 *   codes.app.revoked      a public release was revoked        environment, trust tier, reason…)
 *   codes.moderation.action  Codes staff acted on someone else's app: revoked a release they
 *                          could not manage as a member, or set a trust tier (ADR-022, for
 *                          Network's moderation audit log; subject { type: 'moderation_action' })
 *
 * emit() runs inside the SQLite transaction that makes the change, so an event exists if and only
 * if its change committed. The relay publishes with Codes' OWN service token (events.event.publish,
 * audience openvibe.events) only when EVENTS_URL and OV_OAUTH_CLIENT_SECRET are set; otherwise rows
 * wait in event_outbox and /api/ready reports the relay as off. Payloads never carry a secret.
 */
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createEventsClient, createOutbox } = require('openvibe-sdk/events');

const EVENT_TYPES = ['codes.app.published', 'codes.app.deprecated', 'codes.app.revoked', 'codes.moderation.action'];

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

    /**
     * codes.moderation.action (common.moderation-action@1), inside the caller's transaction. actor:
     * the staff member's subject; target: { type, id, owner_subject? }. Never the content.
     */
    function moderationAction({ action, target, actorSubject, reason = null, details = {} }, { traceparent } = {}) {
        const t = { type: target.type, id: String(target.id).slice(0, 200), owner_subject: target.owner_subject || null };
        return emit({
            event_type: 'codes.moderation.action',
            actor: actorSubject ? { type: 'user', id: actorSubject } : { type: 'service', id: 'codes' },
            subject: { type: 'moderation_action', id: `${t.type}:${t.id}`.slice(0, 200) },
            visibility: 'internal',
            payload: { action, target: t, actor_subject: actorSubject || null, reason: reason ? String(reason).slice(0, 500) : null, details: details || {} },
        }, { traceparent });
    }

    return {
        emit,
        moderationAction,
        outbox,
        enabled,
        start() { if (enabled) outbox.start(); },
        stop: () => outbox.stop(),
        status: () => ({ enabled, pending: outbox.pending(), rejected: outbox.rejected(), last_error: lastError }),
    };
}

module.exports = { createCodesOutbox, EVENT_TYPES };
