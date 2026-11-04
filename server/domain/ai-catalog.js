'use strict';

/**
 * OpenVibe.AI's catalog, read by Codes itself (AI Exchange P9), behind CODES_AI_CATALOG (off by default).
 *
 * Codes already holds a Network app token for OpenVibe.AI (the client-credentials token its harnesses use). This
 * reads GET /v1/models with that same service token, caches the parsed answer for about five minutes, and returns
 * null — never an error — when the flag is off, OpenVibe.AI does not answer, or the answer is the legacy single
 * `openvibe` model. A caller then keeps today's one entry, so a catalog problem cannot change how a task runs.
 *
 *   createAiCatalog({ config, fetchImpl, now })
 *     read()       → { aliases, models, entries } or null (cached)
 *     choices()    → the entries a picker offers, aliases first; [] when there is no catalog
 */

const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { parseCatalog, catalogChoices } = require('../data/ai-catalog');

const DEFAULT_TTL_MS = 5 * 60_000;

/** The one URL for the model list, whether CODES_AI_URL names the root or already ends in /v1. */
function modelsUrl(base) {
    const root = String(base || 'https://ai.openvibe.services').replace(/\/+$/, '');
    return /\/v1$/.test(root) ? `${root}/models` : `${root}/v1/models`;
}

function createAiCatalog({ config = {}, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    const setting = config.aiCatalog || {};
    const enabled = setting.enabled === true;
    const base = String((config.ai && config.ai.url) || 'https://ai.openvibe.services').replace(/\/+$/, '');
    const url = modelsUrl(base);
    const ttlMs = setting.ttlMs == null ? DEFAULT_TTL_MS : Math.max(0, Number(setting.ttlMs) || 0);
    // Codes' own Network token for OpenVibe.AI: the same kind the harness fetches, from the service's client
    // credentials. Without a client secret there is no catalog, and nothing else changes.
    const tokens = enabled && config.oauth && config.oauth.clientSecret
        ? createServiceTokenClient({
            tokenUrl: `${config.networkInternalUrl || 'http://127.0.0.1:4000'}/oauth/token`,
            clientId: config.oauth.clientId,
            clientSecret: config.oauth.clientSecret,
            audience: (config.ai && config.ai.audience) || 'openvibe.ai',
            scope: 'ai.run.create',
            fetch: fetchImpl,
        })
        : null;
    let cached = null;        // { catalog, until }
    let inflight = null;

    async function load() {
        try {
            const res = await fetchImpl(url, {
                headers: { ...(await tokens.authHeaders()), Accept: 'application/json' },
                signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) return null;
            const body = await res.json().catch(() => null);
            return parseCatalog(body);
        } catch {
            // A catalog is an improvement, never a requirement: AI down, a token refused, a slow answer — today's.
            return null;
        }
    }

    /** The parsed catalog, cached about five minutes; null while the flag is off or AI does not answer with one. */
    async function read() {
        if (!enabled || !tokens) return null;
        if (cached && cached.until > now()) return cached.catalog;
        if (!inflight) {
            inflight = load().then((catalog) => {
                if (catalog) cached = { catalog, until: now() + ttlMs };
                return catalog;
            }).finally(() => { inflight = null; });
        }
        return await inflight;
    }

    /** The entries for a picker: aliases before exact ids, each with its price and availability; [] without a catalog. */
    async function choices() {
        return catalogChoices(await read());
    }

    return { enabled, url, read, choices };
}

module.exports = { createAiCatalog, modelsUrl, DEFAULT_TTL_MS };
