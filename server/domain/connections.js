'use strict';

/**
 * A person's connections: the API keys they keep for their own providers, and the plans on their own machines.
 *
 * The key never comes to Codes. It is forwarded straight to OpenVibe.AI, which seals it (AES-256-GCM, bound to
 * Codes as the storing service, to the person and to the provider) and never returns it: Codes' database never
 * sees it, its logs never see it, and its answers carry only the provider, the four-character hint, today's spend,
 * the budget and when the key was last used. The owner of a key is the signed-in person; Codes is the service that
 * holds it for them.
 *
 * The plans (a CLI's own login on the person's machine: Claude Pro/Max, ChatGPT, Command Code, OpenCode Go, …) are
 * reported by the person's Node through OpenVibe.Bot and read from here; there are none yet, so the list is empty
 * until a machine reports one (stage C5).
 *
 *   createConnections({ config, fetchImpl, log })
 *     list(subject)                     → { keys: [...], plans: [...] }
 *     put(subject, provider, body)      → the connection as AI stored it (the hint, never the key)
 *     remove(subject, provider)         → true when there was one
 *     test(subject, provider)           → { ok, detail }: one tiny request through AI, or why not
 */

const { createServiceTokenClient } = require('openvibe-sdk/auth');

/** The providers a person may keep a key for (the same list as OpenVibe.AI's own credential-put@2). */
const PROVIDERS = ['anthropic', 'openai', 'deepseek', 'minimax', 'openrouter', 'custom'];
/** The providers whose key speaks Anthropic's Messages API (the rest speak OpenAI's Chat Completions). */
const ANTHROPIC_FORMAT = ['anthropic', 'deepseek', 'minimax', 'custom'];
const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

/** A provider id, or null when it is not one Codes keeps keys for. */
function providerOf(value) {
    const p = String(value || '').trim().toLowerCase();
    return PROVIDERS.includes(p) ? p : null;
}

/** The connection as Codes shows it: never the key, only what the person may know about it. */
function present(row) {
    if (!row) return null;
    return {
        provider: row.provider,
        hint: row.key_hint || null,
        base_url: row.base_url || null,
        budget_usd_per_day: row.budget_usd_per_day == null ? null : Number(row.budget_usd_per_day),
        spent_usd_today: row.spent_usd_today == null ? 0 : Number(row.spent_usd_today),
        last_used_at: row.last_used_at || null,
        created_at: row.created_at || null,
    };
}

function createConnections({ config, fetchImpl = globalThis.fetch, log = console } = {}) {
    // Codes' own address for AI: the vault (a person's keys) is a host-local API, so Codes reaches it over the
    // loopback. The public address answers 403 there (nginx: /api/ is host-local only).
    const base = String((config.ai && (config.ai.internalUrl || config.ai.url)) || 'https://ai.openvibe.services').replace(/\/+$/, '');
    const scope = (config.ai && config.ai.scope) || 'ai.credential.manage ai.run.create';
    // Codes' own Network token for OpenVibe.AI: the consent grant (ai.credential.manage) lets it store a person's
    // key; ai.run.create lets it make the test request. Five minutes, cached by the SDK client.
    const tokens = config.oauth && config.oauth.clientSecret
        ? createServiceTokenClient({ tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, audience: 'openvibe.ai', scope, fetch: fetchImpl })
        : null;

    /** One call to AI. → { status, body }; the body is AI's own answer, never a key. */
    async function call(method, path, { body = null, headers = {} } = {}) {
        if (!tokens) throw Object.assign(new Error('Codes has no Network client secret, so it cannot reach OpenVibe.AI'), { status: 503, code: 'connections.unavailable' });
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, {
                method,
                headers: { ...(await tokens.authHeaders()), Accept: 'application/json', ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(20_000),
            });
        } catch (e) {
            throw Object.assign(new Error(`OpenVibe.AI did not answer: ${e.message}`), { status: 503, code: 'connections.unavailable' });
        }
        const doc = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error((doc && (doc.detail || doc.title)) || `OpenVibe.AI answered ${res.status}`);
            err.status = res.status; err.code = (doc && doc.code) || 'ai.error';
            throw err;
        }
        return doc;
    }

    /**
     * The person's keys: one row per provider, read from AI. A provider with no key is left out (AI answers 404).
     * The plans are empty until a machine reports one.
     */
    async function list(subject) {
        if (!USER.test(String(subject || ''))) throw Object.assign(new Error('subject must be a usr_ subject'), { status: 400, code: 'subject.required' });
        const keys = [];
        for (const provider of PROVIDERS) {
            let row = null;
            try {
                row = await call('GET', `/api/v1/credentials/${encodeURIComponent(subject)}/${provider}`);
            } catch (e) {
                if (e.status === 404) continue;      // no key for this provider
                throw e;
            }
            if (row) keys.push(present(row));
        }
        return { keys, plans: [] };
    }

    /**
     * Store or replace the person's key for a provider. The key is forwarded to AI and never kept here: it is not
     * written to the database, not logged and not answered. The answer is the hint.
     */
    async function put(subject, provider, body = {}) {
        const p = providerOf(provider);
        if (!p) throw Object.assign(new Error(`provider is one of ${PROVIDERS.join(', ')}`), { status: 422, code: 'connections.provider_unknown' });
        const key = body.key != null ? String(body.key) : (body.api_key != null ? String(body.api_key) : null);
        if (!key || key.length < 8 || key.length > 400) {
            throw Object.assign(new Error('the key is 8-400 characters'), { status: 422, code: 'connections.key_invalid' });
        }
        const out = { provider: p, key };
        if (body.base_url != null && body.base_url !== '') out.base_url = String(body.base_url);
        if (body.budget_usd_per_day != null && body.budget_usd_per_day !== '') {
            const budget = Number(body.budget_usd_per_day);
            if (!Number.isFinite(budget) || budget < 0) throw Object.assign(new Error('the budget is a number of dollars a day'), { status: 422, code: 'connections.budget_invalid' });
            out.budget_usd_per_day = budget;
        }
        // The key is in `out` from here on: it goes straight to AI and is never logged, stored or answered.
        const row = await call('PUT', `/api/v1/credentials/${encodeURIComponent(subject)}/${p}`, { body: out });
        return present(row) || { provider: p, hint: null };
    }

    /** Forget the person's key for a provider. → true when there was one. */
    async function remove(subject, provider) {
        const p = providerOf(provider);
        if (!p) throw Object.assign(new Error(`provider is one of ${PROVIDERS.join(', ')}`), { status: 422, code: 'connections.provider_unknown' });
        try {
            await call('DELETE', `/api/v1/credentials/${encodeURIComponent(subject)}/${p}`);
            return true;
        } catch (e) {
            if (e.status === 404) return false;
            throw e;
        }
    }

    /**
     * One tiny request through AI with the person's own key: does it work? The answer is OK, or the reason it did
     * not (the provider's own words, without a key in it).
     */
    async function test(subject, provider) {
        const p = providerOf(provider);
        if (!p) throw Object.assign(new Error(`provider is one of ${PROVIDERS.join(', ')}`), { status: 422, code: 'connections.provider_unknown' });
        const header = { 'x-openvibe-credential': `${p}:${subject}` };
        try {
            if (ANTHROPIC_FORMAT.includes(p)) {
                await call('POST', '/v1/messages', { body: { model: 'openvibe', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }, headers: header });
            } else {
                await call('POST', '/v1/chat/completions', { body: { model: 'openvibe', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }, headers: header });
            }
            return { ok: true, detail: 'the key works' };
        } catch (e) {
            if (e.status === 404) return { ok: false, detail: 'there is no key for this provider' };
            return { ok: false, detail: String((e && e.message) || 'the provider did not answer').slice(0, 300) };
        }
    }

    /** The providers a person has a key for: the router's word for "connected". */
    async function providers(subject) {
        const { keys } = await list(subject);
        return keys.map((k) => k.provider);
    }

    return { list, put, remove, test, providers, present, PROVIDERS };
}

module.exports = { createConnections, PROVIDERS, ANTHROPIC_FORMAT, providerOf, present };
