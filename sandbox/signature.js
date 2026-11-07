'use strict';
/**
 * The sandbox worker's heartbeat signature to Codes (POST /internal/sandbox-workers/heartbeat): HMAC-SHA256 over
 * `<t>.<raw body>` with a secret only the worker and Codes hold (CODES_SANDBOX_WORKER_SECRET; a comma list on Codes'
 * side for a rotation). The secret never travels; t is the worker's clock in ms, so a stale or replayed heartbeat is
 * refused (Codes keeps the last t per worker and wants a newer one).
 *
 *   sign(secret, body, t) → 'X-OV-Sandbox-Signature' header value: `t=<ms>,v1=<hex>`
 *   verify({ secrets, header, body, now, toleranceMs }) → { ok: true, t } | { ok: false, code }
 */
const crypto = require('crypto');

const HEADER = 'x-ov-sandbox-signature';
const TOLERANCE_MS = 60_000;

const mac = (secret, t, body) => crypto.createHmac('sha256', String(secret)).update(`${t}.`).update(Buffer.isBuffer(body) ? body : Buffer.from(String(body))).digest('hex');

function sign(secret, body, t = Date.now()) {
    if (!secret) throw new Error('no worker secret');
    return `t=${t},v1=${mac(secret, t, body)}`;
}

function verify({ secrets = [], header, body, now = Date.now(), toleranceMs = TOLERANCE_MS }) {
    const list = [].concat(secrets).filter(Boolean);
    if (!list.length) return { ok: false, code: 'sandbox.not_configured' };
    const m = /^t=(\d{10,16}),v1=([0-9a-f]{64})$/.exec(String(header || '').trim());
    if (!m) return { ok: false, code: 'signature.missing' };
    const t = Number(m[1]);
    if (Math.abs(now - t) > toleranceMs) return { ok: false, code: 'signature.stale' };
    const given = Buffer.from(m[2], 'hex');
    const good = list.some((s) => {
        const want = Buffer.from(mac(s, t, body), 'hex');
        return want.length === given.length && crypto.timingSafeEqual(want, given);
    });
    return good ? { ok: true, t } : { ok: false, code: 'signature.invalid' };
}

module.exports = { sign, verify, HEADER, TOLERANCE_MS };
