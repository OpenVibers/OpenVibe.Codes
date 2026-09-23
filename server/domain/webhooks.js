'use strict';

/**
 * Webhook tester and signed-event inspector.
 *
 * OpenVibe.Events delivers `{ "event": <events.event-envelope@1>, "seq": <n> }` with
 * X-OpenVibe-Signature: sha256=<hex HMAC-SHA256 of the RAW body under the subscription secret>.
 * Verification here uses openvibe-sdk's own signDelivery/verifyDelivery (constant-time compare), so
 * the tester agrees with what a receiver built on the SDK does. The secret a developer types is used
 * for one computation and dropped: never stored, logged or rendered back.
 */
const crypto = require('crypto');
const contracts = require('openvibe-contracts');
const { signDelivery, verifyDelivery } = require('openvibe-sdk/events');

const MAX_BODY = 256 * 1024;

/**
 * → { valid, reason, expected, given, bodyBytes, parsed }
 *   expected is the signature the secret produces for this body (showing it does not reveal the
 *   secret, and it is what a developer needs to see why a comparison failed).
 */
function inspect({ rawBody, signature, secret }) {
    const body = typeof rawBody === 'string' ? rawBody : '';
    const given = typeof signature === 'string' ? signature.trim() : '';
    if (!body) return { valid: false, reason: 'paste the raw request body exactly as received (byte for byte)' };
    if (Buffer.byteLength(body) > MAX_BODY) return { valid: false, reason: 'body is larger than 256 KB' };
    if (!secret) return { valid: false, reason: 'enter the subscription secret' };
    const expected = signDelivery(body, secret);
    const valid = verifyDelivery(body, given, secret);
    let reason = null;
    if (!valid) {
        if (!given) reason = 'no X-OpenVibe-Signature value given';
        else if (!given.startsWith('sha256=')) reason = 'the header value must start with sha256=';
        else if (given.length !== expected.length) reason = 'wrong length: sha256= followed by 64 lowercase hex characters';
        else reason = 'the signature does not match this body and secret (check the body was not re-serialised: whitespace and key order matter)';
    }
    let parsed = null;
    try {
        const obj = JSON.parse(body);
        if (obj && typeof obj === 'object' && obj.event) {
            const v = contracts.validate('events.event-envelope@1', obj.event);
            parsed = { event_type: obj.event.event_type || null, event_id: obj.event.event_id || null, seq: obj.seq ?? null, envelopeValid: v.valid, envelopeErrors: v.errors };
        } else {
            parsed = { note: 'JSON, but not an Events delivery ({ event, seq })' };
        }
    } catch { parsed = { note: 'not JSON' }; }
    return { valid, reason, expected, given, bodyBytes: Buffer.byteLength(body), parsed };
}

/**
 * A sample delivery for an event type from the contracts catalog, signed with the given secret.
 * The envelope is valid events.event-envelope@1. Contracts define no per-event payload schemas yet,
 * so the payload is empty and the page says so rather than inventing fields.
 */
function sample({ eventType, secret, producer, now = Date.now() }) {
    const source = producer || String(eventType).split('.')[0];
    const envelope = {
        event_id: contracts.ids.newId('event', now),
        event_type: eventType,
        version: 1,
        source,
        actor: { type: 'service', id: source },
        timestamp: new Date(now).toISOString(),
        visibility: 'internal',
        subject: { type: 'example', id: 'example-1' },
        payload: {},
        trace_id: crypto.randomBytes(16).toString('hex'),
    };
    const check = contracts.validate('events.event-envelope@1', envelope);
    const seq = 1;
    const body = JSON.stringify({ event: envelope, seq });
    const subscriptionId = `sub_${contracts.ids.ulid(now)}`;
    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'OpenVibe.Events/0.1',
        'X-OpenVibe-Event-Id': envelope.event_id,
        'X-OpenVibe-Event-Type': eventType,
        'X-OpenVibe-Seq': String(seq),
        'X-OpenVibe-Subscription-Id': subscriptionId,
        'X-OpenVibe-Delivery-Attempt': '1',
        'X-OpenVibe-Hops': '0',
        'X-OpenVibe-Signature': signDelivery(body, secret),
        traceparent: `00-${envelope.trace_id}-${crypto.randomBytes(8).toString('hex')}-01`,
    };
    return { body, headers, envelopeValid: check.valid, envelopeErrors: check.errors };
}

/** A curl command that replays the sample against the developer's OWN endpoint (Codes never sends it). */
function curlFor(headers, body, endpoint = 'https://your-app.example/webhooks/openvibe') {
    const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
    const hs = Object.entries(headers).map(([k, v]) => `  -H ${q(`${k}: ${v}`)}`).join(' \\\n');
    return `curl -X POST ${q(endpoint)} \\\n${hs} \\\n  --data-binary ${q(body)}`;
}

module.exports = { inspect, sample, curlFor, MAX_BODY };
