'use strict';
/**
 * The Share sheet's API for a memory store (Memory M5), proxied to OpenVibe.AI.
 *
 * The store lives in AI and so does its share row (service `ai`, kind `memory-store`, id `usr_…`). The sheet on
 * Codes talks same-origin to `/api/v1/memory-store/:id/share...`; this proxy reads the person's session token with
 * sso.asViewer and forwards the exact method, path, query and JSON body to the store's uniform share routes. AI
 * authenticates the same person token again and decides; Codes never mints, reads or widens an ACL.
 *
 * The response keeps AI's Cache-Control (`private, no-store` on every share body) and its ETag, so the sheet's
 * conditional saves keep working. A mutation without a same-site marker is refused here as well as in AI.
 */
const MAX_BODY = 8 * 1024 * 1024;                 // a re-sealed envelope may be up to 8 MiB
const PATH_RE = /^\/api\/v1\/memory-store\/[^/]+\/share(?:\/|$)/;

function rawBody(req, limit = MAX_BODY) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                const err = new Error('That save is too large');
                err.status = 413;
                err.code = 'share.too_large';
                reject(err);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

/** The CSRF marker the shared sheet already sends; a cookie-authenticated write without one is refused. */
function sameSite(req) {
    if (req.get('x-requested-with') !== undefined) return true;
    const site = String(req.get('sec-fetch-site') || '').toLowerCase();
    return site === 'same-origin' || site === 'same-site';
}

function createMemoryShareProxy({ config, sso, fetchImpl = globalThis.fetch, log = console } = {}) {
    const base = String((config.ai && (config.ai.internalUrl || config.ai.url)) || 'https://ai.openvibe.services').replace(/\/+$/, '');

    return async function memoryShareProxy(req, res, next) {
        if (!PATH_RE.test(String(req.path || ''))) return next();
        if (!['GET', 'PUT', 'POST'].includes(req.method)) return res.status(405).json({ code: 'share.method', error: 'Method not allowed' });
        if (req.method !== 'GET' && !sameSite(req)) return res.status(403).json({ code: 'share.csrf', error: 'Cross-site request refused' });
        let token;
        try {
            token = await sso.asViewer(req, res, async (t) => t);
        } catch {
            return res.status(401).json({ code: 'token.invalid', error: 'Sign in again to share your memory' });
        }
        let body;
        if (req.method !== 'GET') {
            try { body = await rawBody(req); } catch (err) {
                return res.status(err.status || 400).json({ code: err.code || 'input.invalid', error: err.message || 'That save could not be read' });
            }
            if (!body.length) body = undefined;
        }
        const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
        if (body !== undefined) headers['Content-Type'] = req.get('content-type') || 'application/json';
        if (req.get('if-match')) headers['If-Match'] = req.get('if-match');
        let upstream;
        try {
            upstream = await fetchImpl(`${base}${req.originalUrl}`, { method: req.method, headers, body, signal: AbortSignal.timeout(15000) });
        } catch (err) {
            log.warn(`[Codes] the memory share route did not answer: ${String(err && err.message).slice(0, 120)}`);
            return res.status(502).json({ code: 'memory.unavailable', error: 'The memory store did not answer' });
        }
        const text = await upstream.text().catch(() => '');
        res.status(upstream.status);
        res.set('Cache-Control', upstream.headers.get('cache-control') || 'private, no-store');
        const etag = upstream.headers.get('etag');
        if (etag) res.set('ETag', etag);
        res.type(upstream.headers.get('content-type') || 'application/json');
        return res.send(text);
    };
}

module.exports = { createMemoryShareProxy, PATH_RE, MAX_BODY };
