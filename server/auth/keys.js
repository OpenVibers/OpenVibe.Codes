'use strict';

/**
 * The Network's RS256 signing key, fetched from GET /api/.well-known/jwks (internal URL first, then
 * the public one) and cached. Tokens are verified offline against it: the person's access token
 * (sign-in) and, in playgrounds, the app token a developer brings.
 */
const crypto = require('crypto');

function createKeyStore({ config, fetchImpl = globalThis.fetch, log = console }) {
    let publicKey = null;
    let lastFetch = 0;
    let inflight = null;

    async function fetchKey() {
        for (const base of [config.networkInternalUrl, config.networkUrl]) {
            if (!base) continue;
            try {
                const res = await fetchImpl(`${base}/api/.well-known/jwks`, { signal: AbortSignal.timeout(5000) });
                if (!res.ok) continue;
                const jwks = await res.json();
                if (jwks && typeof jwks.public_key === 'string') { publicKey = jwks.public_key; return publicKey; }
                const jwk = jwks && Array.isArray(jwks.keys) ? jwks.keys.find((k) => k.kty === 'RSA') : null;
                if (jwk) { publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' }); return publicKey; }
            } catch (err) {
                log.warn(`[Codes] JWKS fetch failed from ${base}: ${err && err.name === 'TimeoutError' ? 'timeout' : (err && err.message)}`);
            }
        }
        return null;
    }

    async function ensure() {
        if (publicKey) return publicKey;
        if (inflight) return inflight;
        if (Date.now() - lastFetch < 30_000) return null;   // don't hammer a Network that is down
        lastFetch = Date.now();
        inflight = fetchKey().finally(() => { inflight = null; });
        return inflight;
    }

    return { ensure, get: () => publicKey, loaded: () => Boolean(publicKey) };
}

const b64json = (s) => JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));

/**
 * Verify an RS256 JWT signed by the Network. Returns { ok, claims } or { ok: false, reason, expired }.
 * `audience` is optional (Network user tokens are checked by issuer, like every OpenVibe site).
 */
function verifyJwt(token, { publicKey, issuer, audience, now = Date.now(), skewSec = 30 }) {
    const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
    if (!publicKey) return fail('signing key not loaded');
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3) return fail('not a JWT');
    let header, claims;
    try { header = b64json(parts[0]); claims = b64json(parts[1]); } catch { return fail('undecodable token'); }
    if (!header || header.alg !== 'RS256') return fail('only RS256 tokens are accepted');
    let good = false;
    try { good = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url')); } catch { good = false; }
    if (!good) return fail('signature does not verify');
    if (!claims || typeof claims !== 'object') return fail('no claims');
    if (issuer && claims.iss !== issuer) return fail('wrong issuer');
    if (audience) {
        const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (!aud.includes(audience)) return fail(`token is not for ${audience}`);
    }
    const t = Math.floor(now / 1000);
    if (typeof claims.iat === 'number' && claims.iat - skewSec > t) return fail('issued in the future');
    if (typeof claims.exp !== 'number') return fail('no expiry');
    if (claims.exp + skewSec < t) return fail('expired', { expired: true, claims });
    return { ok: true, claims };
}

module.exports = { createKeyStore, verifyJwt };
