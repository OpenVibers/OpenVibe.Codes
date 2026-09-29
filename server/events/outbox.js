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
 * emit() runs inside the PostgreSQL transaction that makes the change, so an event exists if and only
 * if its change committed. The relay publishes with Codes' OWN service token (events.event.publish,
 * audience openvibe.events) only when EVENTS_URL and OV_OAUTH_CLIENT_SECRET are set; otherwise rows
 * wait in event_outbox and /api/ready reports the relay as off. Payloads never carry a secret.
 */
const { createServiceOutbox } = require('openvibe-sdk/events');

const EVENT_TYPES = ['codes.app.published', 'codes.app.deprecated', 'codes.app.revoked', 'codes.moderation.action'];

/** Codes' wiring of the SDK's shared outbox (plan T1). */
function createCodesOutbox({ db, config, fetchImpl, now, log = console }) {
    return createServiceOutbox({
        db,
        source: 'codes',
        eventsUrl: config.events.url,
        networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        intervalMs: config.events.intervalMs,
        log,
        eventTypes: EVENT_TYPES,
        autoDiscover: false,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        ...(now ? { now } : {}),
    });
}

module.exports = { createCodesOutbox, EVENT_TYPES };
