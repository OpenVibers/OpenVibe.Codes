'use strict';

/**
 * OpenVibe.Network through openvibe-sdk.
 *
 *   projects   /api/v1/projects… with the SIGNED-IN PERSON's access token (Bearer, server-side).
 *              Network owns projects, members, apps, credentials, grants and quotas (ADR-014); Codes
 *              renders what it answers and forwards what the person asks. It never stores any of it.
 *   registry   /api/v1/registry/* and /.well-known/openvibe (public, cached briefly).
 *              POST /:project/export-tokens mints the project export's read-only tokens (never kept).
 *   appToken   /oauth/token client_credentials for an app — only in playgrounds, with the secret the
 *              developer typed for that one request (never stored, never logged, never echoed).
 *
 * Mutations are never retried (the projects API does not dedupe), and a failure is returned as the
 * Network's own problem (status, code, detail, request id) so pages can show it honestly.
 */
const { createClient, isOpenVibeError } = require('openvibe-sdk/core');
const { createRegistryClient } = require('openvibe-sdk/registry');

const enc = encodeURIComponent;

/** A failure as pages show it. Never contains a request body. */
function problemOf(err) {
    if (isOpenVibeError(err)) {
        const unreachable = !err.status || err.code.startsWith('sdk.');
        return {
            status: unreachable ? 502 : err.status,
            code: unreachable ? `network.unreachable` : err.code,
            detail: unreachable ? `OpenVibe.Network did not answer (${err.code.replace(/^sdk\./, '')}).` : (err.detail || err.title || ''),
            requestId: err.requestId || null,
            unreachable,
        };
    }
    return { status: 500, code: 'codes.internal', detail: 'unexpected error', requestId: null, unreachable: false };
}

function createNetworkClient({ config, fetchImpl, log = console }) {
    const base = config.networkInternalUrl;
    const client = createClient({
        network: base, autoDiscover: false, baseUrls: { network: base }, retries: 1, timeoutMs: 8000, deadlineMs: 15000,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        onWarning: (m) => log.warn('[Codes] sdk:', m),
    });

    const call = (token, method, path, json) => client.json({
        baseUrl: base, path: `/api/v1/projects${path}`, method, token,
        ...(json !== undefined ? { json } : {}),
        ...(method === 'GET' ? {} : { idempotencyKey: false, retries: 0 }),
    });

    const P = (p) => `/${enc(p)}`;
    const A = (p, a) => `/${enc(p)}/apps/${enc(a)}`;
    const projects = {
        catalog: (t) => call(t, 'GET', '/catalog'),
        list: (t, { all } = {}) => call(t, 'GET', all ? '?all=1' : ''),
        create: (t, body) => call(t, 'POST', '', body),
        get: (t, p) => call(t, 'GET', P(p)),
        rename: (t, p, body) => call(t, 'PATCH', P(p), body),
        archive: (t, p) => call(t, 'POST', `${P(p)}/archive`, {}),
        members: (t, p) => call(t, 'GET', `${P(p)}/members`),
        addMember: (t, p, body) => call(t, 'POST', `${P(p)}/members`, body),
        updateMember: (t, p, s, body) => call(t, 'PATCH', `${P(p)}/members/${enc(s)}`, body),
        removeMember: (t, p, s) => call(t, 'DELETE', `${P(p)}/members/${enc(s)}`),
        apps: (t, p) => call(t, 'GET', `${P(p)}/apps`),
        createApp: (t, p, body) => call(t, 'POST', `${P(p)}/apps`, body),
        app: (t, p, a) => call(t, 'GET', A(p, a)),
        updateApp: (t, p, a, body) => call(t, 'PATCH', A(p, a), body),
        revokeApp: (t, p, a) => call(t, 'DELETE', A(p, a)),
        credentials: (t, p, a) => call(t, 'GET', `${A(p, a)}/credentials`),
        rotate: (t, p, a, body) => call(t, 'POST', `${A(p, a)}/credentials/rotate`, body),
        revokeCredential: (t, p, a, c) => call(t, 'POST', `${A(p, a)}/credentials/${enc(c)}/revoke`, {}),
        grants: (t, p, a) => call(t, 'GET', `${A(p, a)}/grants`),
        requestGrant: (t, p, a, capability) => call(t, 'POST', `${A(p, a)}/grants`, { capability }),
        decideGrant: (t, p, a, cap, decision) => (decision === 'revoked'
            ? call(t, 'DELETE', `${A(p, a)}/grants/${enc(cap)}`)
            : call(t, 'POST', `${A(p, a)}/grants/${enc(cap)}/${decision === 'approved' ? 'approve' : 'deny'}`, {})),
        quotas: (t, p) => call(t, 'GET', `${P(p)}/quotas`),
        // Usage per day, quotas with their use and recent errors (network.project-usage-result@1; owner/admin).
        usage: (t, p, { days, env } = {}) => call(t, 'GET', `${P(p)}/usage?${new URLSearchParams({ days: String(days || 30), env: env || 'all' })}`),
        audit: (t, p, { before, limit } = {}) => call(t, 'GET', `${P(p)}/audit${before || limit ? `?${new URLSearchParams({ ...(before ? { before: String(before) } : {}), ...(limit ? { limit: String(limit) } : {}) })}` : ''}`),
        // A 5-minute read-only token for the project export (owner/admin; Network checks and audits).
        exportToken: (t, p, body) => call(t, 'POST', `${P(p)}/export-tokens`, body),
    };

    // Registry: public, cached for registryTtlMs so a page view never waits on Network twice.
    const registryClient = createRegistryClient(client, { baseUrl: base });
    const cache = new Map();
    async function cached(key, fn) {
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < config.registryTtlMs) return hit.value;
        const value = await fn();
        cache.set(key, { at: Date.now(), value });
        return value;
    }
    const registry = {
        services: () => cached('services', () => registryClient.services()),
        descriptor: () => cached('descriptor', () => client.json({ baseUrl: base, path: '/.well-known/openvibe', auth: false })),
    };

    /**
     * Client-credentials token for an APP (playgrounds). The secret is used for this one request
     * and dropped; failures come back as the Network's OAuth error, never with the secret.
     */
    async function appToken({ appId, clientSecret, audience, scope }) {
        const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: appId, client_secret: clientSecret, audience, scope });
        const doFetch = fetchImpl || globalThis.fetch;
        let res;
        try {
            res = await doFetch(`${base}/oauth/token`, {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
                body, signal: AbortSignal.timeout(8000),
            });
        } catch (err) {
            return { ok: false, status: 502, code: 'network.unreachable', detail: `OpenVibe.Network did not answer (${err && err.name === 'TimeoutError' ? 'timeout' : 'unreachable'}).` };
        }
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || typeof data.access_token !== 'string') {
            return { ok: false, status: res.status, code: (data && data.error) || `http.${res.status}`, detail: (data && data.error_description) || '' };
        }
        return { ok: true, token: data.access_token, scope: data.scope || '' };
    }

    return { projects, registry, appToken, problemOf };
}

module.exports = { createNetworkClient, problemOf };
