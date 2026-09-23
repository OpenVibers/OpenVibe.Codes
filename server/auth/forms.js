'use strict';

/**
 * Form tokens (CSRF) for every state-changing form. The session cookies are SameSite=Lax and
 * httpOnly; the token is the second lock: an HMAC of the signed-in subject under CODES_FORM_SECRET
 * (a random per-process key when unset, so forms opened before a restart must be reloaded).
 * A POST whose Origin header names another site is refused before the token is even looked at.
 */
const crypto = require('crypto');

const fallback = crypto.randomBytes(32).toString('hex');

function csrfToken(config, viewer) {
    if (!viewer || !viewer.subject) return '';
    return crypto.createHmac('sha256', config.formSecret || fallback).update(`codes-form:${viewer.subject}`).digest('base64url').slice(0, 32);
}

function checkCsrf(config, viewer, token) {
    const expected = csrfToken(config, viewer);
    if (!expected || typeof token !== 'string' || token.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

/** True when the request's Origin (if any) is this site. */
function sameOrigin(config, req) {
    const origin = req.headers.origin;
    if (!origin || origin === 'null') return !origin;
    try { return new URL(origin).origin === new URL(config.baseUrl).origin; } catch { return false; }
}

module.exports = { csrfToken, checkCsrf, sameOrigin };
