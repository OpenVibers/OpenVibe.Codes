'use strict';

/**
 * Cross-site reads and writes for the person's own token (the Dock's Code tab, on any OpenVibe site): the exact
 * https origins the service manifests declare (`domains` of every manifest in the pinned openvibe-contracts), the
 * same list OpenVibe.Network's own CORS allow-list is built from. Only an origin on the list is reflected, never `*`,
 * and credentials stay out of it: the person's Network bearer token rides the Authorization header, never a cookie.
 *
 *   openVibeOrigins()            → the cached Set of allowed origins
 *   corsOpenVibe({ methods })     → Express middleware: reflect an allowed Origin, answer preflights
 */
const contracts = require('openvibe-contracts');

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
let cached = null;

function openVibeOrigins() {
    if (cached) return cached;
    const out = new Set();
    for (const m of (contracts.services && contracts.services.manifests) || []) {
        for (const d of m.domains || []) {
            const host = String(d || '').trim().toLowerCase();
            if (HOST_RE.test(host)) out.add(`https://${host}`);
        }
    }
    cached = out;
    return out;
}

/** Reflect an allowed cross-site Origin so its page may read the answer; answer preflights outright. */
function corsOpenVibe({ methods = 'GET, POST, OPTIONS', headers = 'authorization, content-type' } = {}) {
    return (req, res, next) => {
        const origin = String(req.get('origin') || '');
        if (origin && openVibeOrigins().has(origin)) {
            res.set('Access-Control-Allow-Origin', origin);
            res.set('Vary', 'Origin');
        }
        if (req.method === 'OPTIONS') {
            res.set('Access-Control-Allow-Methods', methods);
            res.set('Access-Control-Allow-Headers', headers);
            res.set('Access-Control-Max-Age', '600');
            return res.status(204).end();
        }
        return next();
    };
}

module.exports = { openVibeOrigins, corsOpenVibe };
