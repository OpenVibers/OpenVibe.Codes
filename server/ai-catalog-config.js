'use strict';
/**
 * The `codes.ai` namespace (D11 owner settings): the switch that lets Codes' model pickers read OpenVibe.AI's
 * catalog. CODES_AI_CATALOG stays the pin: while it is set it wins, is read-only in the summary and a write
 * answers 409 config.pinned_in_env.
 *
 * /internal/config is openvibe-shared/config's adminRoutes, guarded by codes.config.manage (Network's service
 * token only). actor is the owner Network names in X-OV-Subject; X-OV-Fresh: 1 gates a secret or x-danger write
 * (this namespace has neither). Every activation writes one audit line with the actor and the keys, never a value.
 *
 * The same routes serve the stores passed as `also` (codes.accounts and codes.publishing, server/owner-inputs-config.js),
 * and POST /internal/config/:namespace/test/:key, the admin panel's Setup tab Test button, answers for the keys a
 * `test` hook knows (the owner-setup design of 2026-11-07); it is mounted before the config routes.
 */
const express = require('express');
const shared = require('openvibe-shared/config');
const { serviceAuth, capabilities, http, ids } = require('openvibe-contracts');

const SERVICE = 'codes';
const NAMESPACE = 'codes.ai';
const CAPABILITY = 'codes.config.manage';

const SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'OpenVibe.AI in Codes',
    description: 'Whether Codes\' model pickers offer every model OpenVibe.AI can run. Change it when you want people to pick an exact model instead of the one default entry.',
    type: 'object',
    additionalProperties: false,
    required: ['catalog'],
    properties: {
        agentRuns: { type: 'boolean', title: 'Agent run streams', 'x-group': 'Agent activity', 'x-env': 'CODES_AGENT_UI', description: 'Serve authorized AG-UI run snapshots and resumable events. Enable after the production check.' },
        catalog: {
            type: 'boolean', title: 'Offer every AI model in the pickers', 'x-group': 'AI Exchange', 'x-env': 'CODES_AI_CATALOG',
            description: 'When on, Codes reads OpenVibe.AI\'s model list (refreshed about every five minutes) and its pickers offer every model by name. Off (the default) keeps the single default entry.',
        },
    },
};
const DEFAULTS = Object.freeze({ catalog: false, agentRuns: false });

function bearer(req) {
    const h = String((req.headers && req.headers.authorization) || '');
    return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

function capabilityGuard({ keys, config, log }) {
    return async function guard(req, res, next) {
        try {
            const token = bearer(req);
            if (!token) return http.sendProblem(res, 401, 'token.missing', { detail: 'a Network service token is required', ctx: req.ov });
            const publicKey = typeof keys.pemForToken === 'function' ? await keys.pemForToken(token) : keys.get();
            if (!publicKey) return http.sendProblem(res, 503, 'identity.unavailable', { detail: 'the Network signing key is not loaded yet', ctx: req.ov });
            const r = serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.networkIssuer, audience: config.serviceAudience });
            if (!r.ok) return http.sendProblem(res, 401, r.code || 'token.invalid', { detail: r.reason || 'the token does not verify', ctx: req.ov });
            const sub = String((r.claims && r.claims.sub) || '');
            if (!sub.startsWith('svc:')) return http.sendProblem(res, 403, 'capability.denied', { detail: `${CAPABILITY} is first-party; an app may not change Codes configuration`, ctx: req.ov });
            const decision = capabilities.check(r.claims, CAPABILITY);
            if (!decision.allowed) return http.sendProblem(res, 403, decision.code || 'capability.denied', { detail: decision.reason || `${CAPABILITY} not granted`, ctx: req.ov });
            req.configClaims = r.claims;
            return next();
        } catch (err) {
            log.error(`[config] codes.ai guard failed: ${(err && err.message) || err}`);
            return http.sendProblem(res, 500, 'internal.error', { detail: 'the configuration request failed', ctx: req.ov });
        }
    };
}

function actor(req) {
    const named = String((req.headers && req.headers['x-ov-subject']) || '').trim();
    return ids.isSubjectId('user', named) ? { type: 'user', id: named } : null;
}

const requireFresh = (req) => String((req.headers && req.headers['x-ov-fresh']) || '') === '1';

async function create({ db, keys, config, env = process.env, log = console, onActivate = null, also = [], test = null }) {
    // CODES_AI_CATALOG has always accepted 1/true/yes/on; the shared store's boolean pin reads true/1.
    const storeEnv = { ...env };
    if (['1', 'true', 'yes', 'on'].includes(String(storeEnv.CODES_AI_CATALOG || '').trim().toLowerCase())) storeEnv.CODES_AI_CATALOG = '1';
    const store = await shared.createConfigStore({
        db, service: SERVICE, namespace: NAMESPACE, schema: SCHEMA, defaults: DEFAULTS, env: storeEnv, log,
        onActivate: async (values) => { if (onActivate) await onActivate(values); },
        onChange: ({ namespace, keys: changed, actor: who, revision }) => {
            log.info(`[config] ${SERVICE} ${namespace} revision ${revision} by ${who && who.id ? `${who.type}:${who.id}` : 'unknown'}: ${changed.join(', ')}`);
        },
    });
    if (env.OV_CONFIG_KEKS) {
        try { await store.reseal(); } catch (err) { log.warn(`[config] ${NAMESPACE}: reseal failed: ${(err && err.message) || err}`); }
    }
    const guard = capabilityGuard({ keys, config, log });
    const router = shared.adminRoutes([store, ...also], {
        basePath: '/internal/config', requireAdmin: guard, actor, requireFresh, log,
    });
    return {
        store, router,
        get: (key) => store.get(key),
        mount(app) {
            app.use('/internal/config', express.json({ limit: '128kb' }));
            if (test) app.post('/internal/config/:namespace/test/:key', guard, testRoute({ test, log }));
            router.mount(app);
        },
    };
}

/** One line, at most 200 characters, with the secret replaced. */
function oneLine(text, secret) {
    let s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (typeof secret === 'string' && secret.length >= 4) {
        s = s.split(secret).join('[hidden]');
        if (secret.length >= 12) s = s.split(secret.slice(0, 12)).join('[hidden]');
    }
    return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

/**
 * The Setup tab's Test button: test(namespace, key) answers { value, source, env, run(value) } or null (no test).
 * 200 { ok, message, state, source, namespace, key, tested_at } (openvibe-shared 4.125.0's { ok, message } with more
 * beside it), 409 config.not_set when neither the panel nor the settings file has a value. Never the value itself.
 */
function testRoute({ test, log }) {
    return async function configTest(req, res) {
        const namespace = String(req.params.namespace || '');
        const key = String(req.params.key || '');
        let found = null;
        try { found = await test(namespace, key); } catch { found = null; }
        if (!found) return http.sendProblem(res, 404, 'config.test_not_found', { detail: `${namespace} has no test for ${key}`, ctx: req.ov });
        if (!found.value) return http.sendProblem(res, 409, 'config.not_set', { detail: `${key} is not set, so there is nothing to test`, ctx: req.ov });
        let out;
        try { out = await found.run(found.value); } catch (err) { out = { ok: false, message: `The test could not run: ${(err && err.message) || 'unknown error'}` }; }
        const ok = Boolean(out && out.ok);
        const from = found.source === 'env' && found.env ? ` (the value from the server's settings file, ${found.env})` : '';
        const message = oneLine(`${(out && out.message) || (ok ? 'It works.' : 'It did not work.')}${from}`, found.value);
        (log.info || log.log).call(log, `[config] test ${namespace} ${key}: ${ok ? 'connected' : 'not working'}`);
        return res.json({ ok, message, state: ok ? 'connected' : 'not_working', source: found.source || null, namespace, key, tested_at: new Date().toISOString() });
    };
}

module.exports = { create, SCHEMA, NAMESPACE, CAPABILITY, oneLine };
