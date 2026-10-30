'use strict';

/**
 * Secrets never reach an event stream, a log or a page.
 *
 * The portal learned this the hard way: an agent that quotes a key it read in a config file puts it in its own output,
 * and the feed is what the phone portal, the session log and the result all show. The patterns are the ones the portal
 * uses (ds-claude.js): provider keys, GitHub tokens, JWTs, private-key blocks and the `key=…` / `"token": "…"` pairs.
 *
 *   scrub(text)          a string, with every secret replaced
 *   scrubDeep(value)     any JSON value, with every string in it scrubbed
 */

const SECRET_PATTERNS = [
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\b((?:api[_-]?key|access[_-]?token|secret|password|client[_-]?secret)["']?\s*[:=]\s*["']?)[^\s"']{8,}/gi,
];

/** A string with every secret it holds replaced. */
function scrub(s) {
    let out = String(s == null ? '' : s);
    for (const re of SECRET_PATTERNS) out = out.replace(re, (m, keep) => (typeof keep === 'string' && m.startsWith(keep) ? `${keep}[redacted]` : '[redacted]'));
    return out;
}

/** Any JSON value with every string in it scrubbed (the shape of the feed is kept). */
function scrubDeep(value) {
    if (typeof value === 'string') return scrub(value);
    if (Array.isArray(value)) return value.map(scrubDeep);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v);
        return out;
    }
    return value;
}

module.exports = { SECRET_PATTERNS, scrub, scrubDeep };
