'use strict';

/**
 * Run tokens (Codes C3): the short-lived Network token an attempt's harness carries.
 *
 * A run token is a Network token (client credentials, audience openvibe.ai, capability ai.run.create) that names
 * the person it acts for (`on_behalf_of`) and lives at most two hours. It is bound to one task: it is minted when the
 * attempt starts and it is written into the job's environment, so OpenVibe.AI knows whose key and whose budget the
 * request is, and nobody else's. The token itself is never written to Codes' database (only its jti and its expiry
 * are, so a run can be traced), never logged and never answered; the transcript normaliser redacts it everywhere a
 * line is written (server/domain/redact.js).
 *
 * The environment the harness gets points it at OpenVibe.AI:
 *   Claude Code          ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_CUSTOM_HEADERS
 *   Codex, OpenAI-like   OPENAI_BASE_URL, OPENAI_API_KEY
 * The credential header (x-openvibe-credential) names the provider whose key the run uses, when the person has one.
 *
 *   createRunTokens({ config, store, fetchImpl, log })
 *     mint({ subject, task, attempt, harness, provider, ownKey }) → { token, expiresAt, jti, env }
 *     record({ subject, task, attempt, provider, jti, expiresAt }) → the row (no token in it)
 */

const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The harnesses that speak Anthropic's Messages API (the rest speak OpenAI's Chat Completions). */
const ANTHROPIC_HARNESSES = ['claude-code'];

/** The claims of a JWT, decoded but not verified (the receiver verifies; this is for the jti and the expiry). */
function claims(token) {
    try {
        const part = String(token || '').split('.')[1];
        if (!part) return null;
        return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    } catch { return null; }
}

/** The base URL of OpenVibe.AI, without a trailing slash. */
function aiBase(config) {
    return String((config.ai && config.ai.url) || 'https://ai.openvibe.services').replace(/\/+$/, '');
}

/**
 * The environment a harness of this kind gets: where to send its requests, the token to send, and (when the person
 * has a key for that provider) the header that says which key.
 */
function envFor({ config, harness, token, provider, ownKey }) {
    const base = aiBase(config);
    const credential = ownKey && provider ? `x-openvibe-credential: ${provider}` : null;
    if (ANTHROPIC_HARNESSES.includes(harness)) {
        return {
            ANTHROPIC_BASE_URL: base,
            ANTHROPIC_AUTH_TOKEN: token,
            ...(credential ? { ANTHROPIC_CUSTOM_HEADERS: credential } : {}),
        };
    }
    // The OpenAI-compatible harnesses: the CLI ones read OPENAI_BASE_URL and OPENAI_API_KEY; Codes' own adapters
    // read their own names, so they are given the same endpoint and token under those names too.
    const env = { OPENAI_BASE_URL: `${base}/v1`, OPENAI_API_KEY: token };
    if (credential) {
        env.OPENAI_CUSTOM_HEADERS = credential;
        env.OPENVIBE_CODES_HEADERS = JSON.stringify({ 'x-openvibe-credential': provider });
    }
    if (harness === 'deepseek') { env.DEEPSEEK_BASE_URL = `${base}/v1`; env.DEEPSEEK_API_KEY = token; }
    if (harness === 'openvibe-ai') { env.OPENVIBE_AI_URL = `${base}/v1`; env.OPENVIBE_AI_TOKEN = token; }
    if (harness === 'openai-compatible') { env.OPENVIBE_CODES_BASE_URL = `${base}/v1`; env.OPENVIBE_CODES_API_KEY = token; }
    return env;
}

function createRunTokens({ config, store = null, fetchImpl = globalThis.fetch, log = console } = {}) {
    const ttl = Math.min(7200, Math.max(60, Number((config.runTokens && config.runTokens.ttlSeconds) || 7200)));

    /**
     * Mint a run token for one attempt of one task of one person.
     * → { token, expiresAt, jti, env }; the token is in the answer and nowhere else.
     */
    async function mint({ subject, task = null, attempt = null, harness = null, provider = null, ownKey = false } = {}) {
        if (!USER.test(String(subject || ''))) throw Object.assign(new Error('subject must be a usr_ subject'), { status: 400, code: 'subject.required' });
        const clientId = config.oauth && config.oauth.clientId;
        const clientSecret = config.oauth && config.oauth.clientSecret;
        if (!clientId || !clientSecret) {
            throw Object.assign(new Error('Codes has no Network client secret, so it cannot mint a run token'), { status: 503, code: 'run_token.unavailable' });
        }
        const tokenUrl = `${config.networkInternalUrl}/oauth/token`;
        const body = new URLSearchParams({
            grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret,
            audience: 'openvibe.ai', scope: 'ai.run.create', on_behalf_of: String(subject), ttl: String(ttl),
        });
        let res;
        try {
            res = await fetchImpl(tokenUrl, {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
                body: body.toString(), signal: AbortSignal.timeout(15_000),
            });
        } catch (e) {
            throw Object.assign(new Error(`OpenVibe.Network did not answer: ${e.message}`), { status: 503, code: 'run_token.unavailable' });
        }
        const doc = await res.json().catch(() => null);
        if (!res.ok || !doc || !doc.access_token) {
            const err = new Error((doc && (doc.error_description || doc.error)) || `OpenVibe.Network answered ${res.status}`);
            err.status = res.status === 403 ? 403 : 503; err.code = 'run_token.refused';
            throw err;
        }
        const token = String(doc.access_token);
        const c = claims(token) || {};
        const out = {
            token,
            jti: c.jti || null,
            expiresAt: c.exp ? new Date(c.exp * 1000).toISOString() : new Date(Date.now() + ttl * 1000).toISOString(),
            env: envFor({ config, harness, token, provider, ownKey }),
        };
        require('./redact').remember(token);
        await record({ subject, task, attempt, provider, jti: out.jti, expiresAt: out.expiresAt });
        return out;
    }

    /** The row that says a run token was minted for a task: its jti and its expiry, never the token. */
    async function record({ subject, task = null, attempt = null, provider = null, jti = null, expiresAt = null } = {}) {
        if (!store || !store.db) return null;
        try {
            return await store.db.one(
                `INSERT INTO codes_run_tokens (id, task_id, attempt_id, subject, provider, jti, expires_at, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz) RETURNING *`,
                [store.newId('rtk'), task || null, attempt || null, subject || null, provider || null, jti || null,
                    expiresAt || null, store.iso()],
            );
        } catch (e) {
            // The row is a trace, not the point: a database that cannot take it must not stop the run.
            log.warn(`[Codes] the run token row could not be written: ${String(e && e.message).slice(0, 200)}`);
            return null;
        }
    }

    /** The tokens minted for a task: their jtis and their expiries, never the tokens. */
    async function forTask(taskId) {
        if (!store || !store.db || !taskId) return [];
        const rows = await store.db.many('SELECT id, task_id, attempt_id, subject, provider, jti, expires_at, created_at FROM codes_run_tokens WHERE task_id = $1 ORDER BY created_at ASC', [taskId]);
        return rows.map((r) => ({ id: r.id, task_id: r.task_id, attempt_id: r.attempt_id, subject: r.subject, provider: r.provider, jti: r.jti, expires_at: r.expires_at, created_at: r.created_at }));
    }

    return { mint, record, forTask, envFor, ttl };
}

module.exports = { createRunTokens, envFor, ANTHROPIC_HARNESSES };
