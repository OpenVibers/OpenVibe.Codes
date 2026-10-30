'use strict';

/**
 * Telling a person that their conductor needs them (Codes C9b): one OpenVibe notification through the Network, the
 * only notification store (ADR-020). Codes pushes directly, with its own service token (network.notifications.push and
 * identity.subject.resolve), because an approval is transactional: a person asked on their phone is not a domain event
 * for Events to render.
 *
 *   createNotify({ config, fetchImpl, log, send })
 *     push({ subject, type, title, message, url, priority, category, icon }) → { sent, skipped?, reason? }
 *
 * The optional `send` is for tests and for a caller that already knows how to reach the Network: it gets the same
 * object body. A Network that is not configured (no client secret) or that does not answer is said, never thrown: a
 * notification that could not be sent must not stop the thing it is about.
 */

const TYPES = new Set(['APPROVAL_NEEDED', 'WATCH_TRIGGERED', 'SYSTEM']);

function createNotify({ config = {}, fetchImpl = null, log = console, send = null } = {}) {
    const enabled = !!(config.oauth && config.oauth.clientSecret);
    let client = null;

    function clientOnce() {
        if (client) return client;
        const { createClient } = require('openvibe-sdk');
        const { createServiceTokenClient } = require('openvibe-sdk/auth');
        const { createNotificationsClient } = require('openvibe-sdk/notifications');
        const tokens = createServiceTokenClient({
            tokenUrl: `${config.networkInternalUrl}/oauth/token`,
            clientId: config.oauth.clientId,
            clientSecret: config.oauth.clientSecret,
            audience: 'openvibe.network',
            scope: 'network.notifications.push identity.subject.resolve',
            ...(fetchImpl ? { fetch: fetchImpl } : {}),
        });
        client = createNotificationsClient(createClient({ tokenProvider: tokens, timeoutMs: 8000, ...(fetchImpl ? { fetch: fetchImpl } : {}) }), { baseUrl: config.networkInternalUrl });
        return client;
    }

    /**
     * One notification to one person. The body is Network's own: type, title, message and a url back into Codes.
     * Never throws; the answer says whether Network made a decision and whether the person switched it off.
     */
    async function push({ subject, type = 'SYSTEM', title, message, url, priority = 'normal', category = 'codes', icon = '🎛️' } = {}) {
        if (!subject) return { sent: false, reason: 'no_subject' };
        if (!title || !message) return { sent: false, reason: 'empty' };
        const body = {
            subjectId: subject,
            type: TYPES.has(type) ? type : 'SYSTEM',
            category, service: 'codes', icon, priority,
            title: String(title).slice(0, 120),
            message: String(message).slice(0, 300),
            ...(url ? { url: String(url).slice(0, 500) } : {}),
        };
        if (send) {
            try { return await send(body); } catch (e) { return { sent: false, reason: String((e && e.message) || e).slice(0, 200) }; }
        }
        if (!enabled) return { sent: false, reason: 'not_configured' };
        try {
            return await clientOnce().push(body);
        } catch (e) {
            log.warn(`[Codes] notification to ${subject} failed: ${String((e && e.message) || e).slice(0, 200)}`);
            return { sent: false, reason: 'network_error' };
        }
    }

    return { push, enabled: enabled || !!send, TYPES };
}

module.exports = { createNotify, TYPES };
