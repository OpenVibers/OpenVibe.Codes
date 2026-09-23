'use strict';

/**
 * Webhook tester and signed-event inspector.
 *
 * OpenVibe.Events delivers `{ "event": <events.event-envelope@1>, "seq": <n> }` with two signatures
 * under the subscription secret:
 *   X-OpenVibe-Signature:    sha256=<hex HMAC-SHA256 of the RAW body>                       (v1)
 *   X-OpenVibe-Timestamp:    <unix seconds this attempt was sent>
 *   X-OpenVibe-Signature-V2: t=<that timestamp>,v2=<hex HMAC-SHA256 of "<t>.<raw body>">    (v2)
 * Every consumer requires v2 and refuses it more than 300 s from its own clock (replay window).
 * Verification here uses openvibe-sdk's own signDelivery/verifyDelivery and signDeliveryV2/
 * verifyDeliveryV2 (constant-time compare), so the tester agrees with what a receiver built on the
 * SDK does. The secret a developer types is used for one computation and dropped: never stored,
 * logged or rendered back.
 */
const crypto = require('crypto');
const contracts = require('openvibe-contracts');
const { signDelivery, verifyDelivery, signDeliveryV2, verifyDeliveryV2, signDeliveryHeaders } = require('openvibe-sdk/events');

const MAX_BODY = 256 * 1024;
/** The replay window every Events consumer applies to v2 (openvibe-sdk's default). */
const V2_WINDOW_SEC = 300;
/** Wide enough to check the v2 HMAC alone, so a stale-but-correct signature is told apart from a wrong one. */
const ANY_TIME = Number.MAX_SAFE_INTEGER;

function checkV1(body, given, secret) {
    const expected = signDelivery(body, secret);
    const valid = verifyDelivery(body, given, secret);
    let reason = null;
    if (!valid) {
        if (!given) reason = 'no X-OpenVibe-Signature value given';
        else if (!given.startsWith('sha256=')) reason = 'the header value must start with sha256=';
        else if (given.length !== expected.length) reason = 'wrong length: sha256= followed by 64 lowercase hex characters';
        else reason = 'the signature does not match this body and secret (check the body was not re-serialised: whitespace and key order matter)';
    }
    return { present: !!given, valid, reason, expected, given };
}

/** t and the v2 values from `t=<ts>,v2=<hex>[,v2=<hex>]`, parsed as the SDK does; null when malformed. */
function parseV2Header(header) {
    let t = null;
    const values = [];
    for (const part of header.split(',')) {
        const i = part.indexOf('=');
        if (i < 0) return null;
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k === 't') {
            if (t !== null || !/^\d{1,12}$/.test(v)) return null;
            t = Number(v);
        } else if (k === 'v2') values.push(v);
    }
    return t === null || !values.length ? null : { t, values };
}

function checkV2(body, given, stated, secret, now) {
    const out = { present: !!given, valid: false, signatureValid: false, reason: null, expected: null, given, timestamp: null, statedTimestamp: stated || null, ageSec: null, windowSec: V2_WINDOW_SEC, withinWindow: null, timestampsAgree: null };
    if (!given) {
        out.reason = 'no X-OpenVibe-Signature-V2 value given. Events sends it on every delivery, and a receiver that requires v2 refuses a delivery without it';
        return out;
    }
    const parsed = parseV2Header(given);
    if (!parsed) {
        out.reason = 'the header value must look like t=<unix seconds>,v2=<64 lowercase hex characters>';
        return out;
    }
    out.timestamp = parsed.t;
    out.expected = signDeliveryV2(body, secret, parsed.t);
    out.ageSec = Math.floor(now / 1000) - parsed.t;
    out.withinWindow = Math.abs(now / 1000 - parsed.t) <= V2_WINDOW_SEC;
    out.timestampsAgree = stated ? stated === String(parsed.t) : null;
    // The HMAC alone (any time, X-OpenVibe-Timestamp left out), then the check a receiver makes.
    out.signatureValid = verifyDeliveryV2(body, { 'x-openvibe-signature-v2': given }, secret, { toleranceSec: ANY_TIME, now });
    const headers = { 'x-openvibe-signature-v2': given };
    if (stated) headers['x-openvibe-timestamp'] = stated;
    out.valid = verifyDeliveryV2(body, headers, secret, { toleranceSec: V2_WINDOW_SEC, now });
    if (!out.valid) {
        if (!out.signatureValid) {
            out.reason = parsed.values.every((v) => v.length !== 64)
                ? 'wrong length: v2= followed by 64 lowercase hex characters'
                : 'the v2 signature does not match: it is the HMAC of "<t>.<raw body>" (the timestamp, a dot, then the body byte for byte)';
        } else if (out.timestampsAgree === false) {
            out.reason = `X-OpenVibe-Timestamp (${stated}) is not the t= in X-OpenVibe-Signature-V2 (${parsed.t})`;
        } else {
            out.reason = `the signature matches, but t is ${Math.abs(out.ageSec)} s ${out.ageSec >= 0 ? 'in the past' : 'in the future'}, outside the ±${V2_WINDOW_SEC} s window: a receiver refuses it now. Events signs every attempt afresh, so only a replayed or long-held delivery is this old (or a clock is wrong: keep NTP on)`;
        }
    }
    return out;
}

/**
 * → { accepted, v1, v2, bodyBytes, parsed } or { accepted: false, reason } for unusable input.
 *   accepted is what a receiver requiring v2 decides (parseDelivery(..., { requireV2: true })):
 *   v2 must verify and be within the window; v1 is shown but never decides.
 *   Each check carries `expected`, the signature the secret produces for this body (showing it
 *   does not reveal the secret, and it is what a developer needs to see why a comparison failed).
 */
function inspect({ rawBody, signature, signatureV2, timestamp, secret, now = Date.now() }) {
    const body = typeof rawBody === 'string' ? rawBody : '';
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    if (!body) return { accepted: false, reason: 'paste the raw request body exactly as received (byte for byte)' };
    if (Buffer.byteLength(body) > MAX_BODY) return { accepted: false, reason: 'body is larger than 256 KB' };
    if (!secret) return { accepted: false, reason: 'enter the subscription secret' };
    const v1 = checkV1(body, str(signature), secret);
    const v2 = checkV2(body, str(signatureV2), str(timestamp), secret, now);
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
    return { accepted: v2.valid, v1, v2, bodyBytes: Buffer.byteLength(body), parsed };
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
        ...signDeliveryHeaders(body, secret, { now }),
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

module.exports = { inspect, sample, curlFor, parseV2Header, MAX_BODY, V2_WINDOW_SEC };
