'use strict';

/**
 * The secrets Codes must never show again: the run tokens it minted for the harnesses.
 *
 * A run token is a Network token (a JWT) that says whose key and whose budget a run is. It lives in the harness's
 * environment for the length of an attempt and nowhere else — Codes keeps no copy, so the only place it can be
 * remembered is here, in memory, for as long as the service runs. Every line a session keeps is scrubbed with it, so
 * a token that an agent printed (or a harness echoed) never reaches the transcript, the page or the log.
 */

const MIN_LENGTH = 12;
const secrets = new Set();

/** Remember a secret so that it is redacted everywhere a line is written. */
function remember(secret) {
    const s = String(secret || '');
    if (s.length >= MIN_LENGTH) secrets.add(s);
    return s;
}

/** The secrets remembered (their count, never their values). */
function count() { return secrets.size; }

/** A text with every remembered secret replaced. */
function scrub(text) {
    let out = String(text == null ? '' : text);
    for (const s of secrets) {
        if (s && out.includes(s)) out = out.split(s).join('[redacted]');
    }
    return out;
}

/** A JSON value with every remembered secret replaced, in the strings inside it. */
function scrubValue(value) {
    if (typeof value === 'string') return scrub(value);
    if (Array.isArray(value)) return value.map(scrubValue);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v);
        return out;
    }
    return value;
}

module.exports = { remember, scrub, scrubValue, count };
