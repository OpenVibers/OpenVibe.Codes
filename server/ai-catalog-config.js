'use strict';
/**
 * The `codes.ai` namespace (D11 owner settings): the switch that lets Codes' model pickers read OpenVibe.AI's
 * catalog. CODES_AI_CATALOG stays the pin: while it is set it wins, is read-only in the summary and a write
 * answers 409 config.pinned_in_env.
 *
 * /internal/config is openvibe-shared/config's adminRoutes, guarded by codes.config.manage (Network's service
 * token only). actor is the owner Network names in X-OV-Subject; X-OV-Fresh: 1 gates a secret or x-danger write
 * (this namespace has neither). Every activation writes one audit line with the actor and the keys, never a value.
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
    description: 'Read OpenVibe.AI\'s model catalog so the pickers offer its aliases and exact ids.',
    type: 'object',
    additionalProperties: false,
    required: ['catalog'],
    properties: {
        catalog: {
            type: 'boolean', title: 'AI model catalog', 'x-group': 'AI Exchange', 'x-env': 'CODES_AI_CATALOG',
            description: 'Read GET /v1/models with Codes\' own service token and cache the answer about five minutes. Off, the pickers keep today\'s one entry.',
        },
    },
};
const DEFAULTS = Object.freeze({ catalog: false });

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

async function create({ db, keys, config, env = process.env, log = console, onActivate = null }) {
    const store = await shared.createConfigStore({
        db, service: SERVICE, namespace: NAMESPACE, schema: SCHEMA, defaults: DEFAULTS, env, log,
        onActivate: async (values) => { if (onActivate) await onActivate(values); },
        onChange: ({ namespace, keys: changed, actor: who, revision }) => {
            log.info(`[config] ${SERVICE} ${namespace} revision ${revision} by ${who && who.id ? `${who.type}:${who.id}` : 'unknown'}: ${changed.join(', ')}`);
        },
    });
    if (env.OV_CONFIG_KEKS) {
        try { await store.reseal(); } catch (err) { log.warn(`[config] ${NAMESPACE}: reseal failed: ${(err && err.message) || err}`); }
    }
    const router = shared.adminRoutes([store], {
        basePath: '/internal/config', requireAdmin: capabilityGuard({ keys, config, log }), actor, requireFresh, log,
    });
    return {
        store, router,
        get: (key) => store.get(key),
        mount(app) { app.use('/internal/config', express.json({ limit: '128kb' })); router.mount(app); },
    };
}

module.exports = { create, SCHEMA, NAMESPACE, CAPABILITY };
