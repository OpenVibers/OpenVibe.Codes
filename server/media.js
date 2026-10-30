'use strict';
/**
 * OpenVibe.Media: the private objects a task's images live in.
 *
 * A proof screenshot can show anything on the person's screen, so it never becomes a public file. The bytes go to
 * Media as a private object owned by the person, and the session shows a short-lived signed URL that only that
 * person (through Codes) can use. Media takes no app keys (C-71): Codes reaches its own tenant with its Network service
 * token (audience openvibe.media; media.object.upload and media.object.read, granted on the codes tenant only), the
 * person named in X-OV-Subject. Without a client secret there are no attachments, and the session simply shows the text.
 *
 *   createMedia({ config, fetchImpl })
 *     configured()                 is Media set up?
 *     put({ bytes, mime, name, kind, subject })   → { id }     a private object
 *     signed(id, subject)                         → { url }    a short-lived download URL
 *     uploadAttachments(list, subject)            → the list with the bytes swapped for object ids
 *     signAttachments(list, subject)              → the list with the object ids swapped for URLs
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const DEFAULT_TTL = 900;      // a signed URL lives fifteen minutes
const MAX_BYTES = 12 * 1024 * 1024;
const SCOPE = 'media.object.upload media.object.read';

function createMedia({ config, fetchImpl = globalThis.fetch, log = null, tokens = null } = {}) {
    const media = (config && config.media) || {};
    const oauth = (config && config.oauth) || {};
    const url = String(media.url || '').replace(/\/+$/, '');
    const app = String(media.app || 'codes').trim() || 'codes';
    const ttl = Math.min(3600, Math.max(60, Number(media.ttl) || DEFAULT_TTL));
    const base = () => `${url}/api/v2/${encodeURIComponent(app)}/objects`;
    const auth = tokens || (oauth.clientSecret && config.networkInternalUrl
        ? createServiceTokenClient({ tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: oauth.clientId, clientSecret: oauth.clientSecret, audience: 'openvibe.media', scope: SCOPE, fetch: fetchImpl })
        : null);
    const configured = () => !!(url && auth);

    const warn = (msg) => { if (log && typeof log.warn === 'function') log.warn(msg); };

    async function call(method, apiUrl, subject, body, raw) {
        const headers = { ...(await auth.authHeaders()), accept: 'application/json' };
        if (subject) headers['x-ov-subject'] = String(subject);
        if (body != null) headers['content-type'] = 'application/json';
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        let res;
        try {
            res = await fetchImpl(apiUrl, { method, headers, body: body == null ? undefined : JSON.stringify(body), signal: ctrl.signal });
        } finally {
            clearTimeout(timer);
        }
        if (res.status === 401 && auth.invalidate) auth.invalidate();
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        if (!res.ok) {
            const err = new Error(`Media answered HTTP ${res.status}`);
            err.status = res.status;
            err.body = json || text.slice(0, 200);
            throw err;
        }
        return raw ? json : (json || {});
    }

    /** The bytes into a private object of the person: { id }. */
    async function put({ bytes, mime, name, kind = 'screenshot', subject } = {}) {
        if (!configured()) throw new Error('Media is not set up');
        const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes || ''), 'base64');
        if (!buf.length) throw new Error('no bytes');
        if (buf.length > MAX_BYTES) throw new Error('too big for Media');
        const init = await call('POST', base(), subject, {
            kind, visibility: 'private', mime_type: String(mime || 'image/png'),
            size_bytes: buf.length, filename: String(name || 'image'),
        });
        const up = init.upload || {};
        const res = await fetchImpl(up.url, { method: up.method || 'PUT', body: buf, headers: { 'content-type': String(mime || 'image/png') } });
        if (!res.ok) throw new Error(`Media refused the bytes: HTTP ${res.status}`);
        await call('POST', up.complete_url || `${base()}/${encodeURIComponent(init.id)}/complete`, subject, {});
        return { id: String(init.id || '') };
    }

    /** A short-lived signed URL for a private object: { url, expires_at }. */
    async function signed(id, subject) {
        if (!configured()) return null;
        const r = await call('GET', `${base()}/${encodeURIComponent(id)}/download?ttl=${ttl}`, subject, null, true);
        return r && r.url ? r : null;
    }

    /** A list of attachments whose bytes become private objects: the bytes are gone from the list. */
    async function uploadAttachments(list, subject) {
        const arr = Array.isArray(list) ? list : [];
        if (!arr.length || !configured()) return arr;
        const out = [];
        for (const a of arr) {
            if (!a || typeof a !== 'object') continue;
            const data = a.data ? String(a.data) : '';
            if (!data) { out.push(a); continue; }
            try {
                const put_ = await put({ bytes: data, mime: a.mime, name: a.name, kind: a.kind === 'image' ? 'screenshot' : 'file', subject });
                out.push({ url: '', media: put_.id, name: a.name || '', mime: a.mime || '', kind: a.kind || '', role: a.role || 'output' });
            } catch (e) {
                warn(`[Codes] a picture did not reach Media: ${String(e && e.message).slice(0, 160)}`);
            }
        }
        return out;
    }

    /** A list of attachments whose objects become signed URLs: { url, … }. */
    async function signAttachments(list, subject) {
        const arr = Array.isArray(list) ? list : [];
        if (!arr.length || !configured()) return arr;
        const out = [];
        for (const a of arr) {
            if (!a || typeof a !== 'object') continue;
            if (!a.media || a.url) { out.push(a); continue; }
            try {
                const s = await signed(a.media, subject);
                if (s && s.url) out.push(Object.assign({}, a, { url: s.url }));
            } catch (e) {
                warn(`[Codes] a picture could not be signed: ${String(e && e.message).slice(0, 160)}`);
            }
        }
        return out;
    }

    return { configured, put, signed, uploadAttachments, signAttachments, apiBase: base };
}

module.exports = { createMedia, DEFAULT_TTL, MAX_BYTES };
