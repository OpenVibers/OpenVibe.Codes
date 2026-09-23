'use strict';

/**
 * JSON API (/api/v1). Errors are RFC 9457 problems (openvibe-contracts http.sendProblem).
 *
 *   GET  /docs/versions                   the pinned versions the docs were generated from
 *   POST /manifests/validate              { kind: app|mod, manifest } → { valid, errors, warnings }
 *
 *   codes.release.read (public; no token needed — a token that IS presented must hold it):
 *   GET  /apps/:app/releases              public releases of an app (never drafts) + trust tier
 *   GET  /apps/:app/trust                 the app's trust tier (metadata only, ADR-013)
 *   GET  /releases/:id                    one public release with its manifest
 *
 *   codes.release.manage — an app managing its OWN releases with its own token:
 *   POST /apps/:app/releases              { kind, manifest, notes, publish } → draft (or published)
 *   POST /releases/:id/publish | /deprecate { reason, replacement } | /revoke { reason }
 *
 * Guards are openvibe-contracts requireCapability() (audience openvibe.codes, issuer, expiry, claim
 * shape, the capability; sandbox app tokens accepted, release records carry the environment), then
 * sub = app:<the app in the path>. No route accepts a shared loopback key of any kind.
 */
const express = require('express');
const { asyncRouter } = require('./router');
const rateLimit = require('express-rate-limit');
const { http, serviceAuth } = require('openvibe-contracts');
const manifests = require('../domain/manifests');
const { ReleaseError } = require('../domain/releases');

const APP_RE = /^app_[0-9A-HJKMNP-TV-Z]{26}$/;
const REL_RE = /^rel_[0-9A-HJKMNP-TV-Z]{26}$/;
const MANAGE = 'codes.release.manage';
const READ = 'codes.release.read';

function createApi(ctx) {
    const { config, docs, releases, trust, keys } = ctx;
    const r = asyncRouter();
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    const json = express.json({ limit: '96kb' });
    const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
    const problem = (req, res, status, code, detail, extra) => http.sendProblem(res, status, code, { detail, ctx: req.ov, extra });

    r.get('/docs/versions', (req, res) => {
        res.json({ contracts: docs.contractsVersion, contracts_tag: docs.contractsTag, sdk: docs.sdkVersion, sdk_tag: docs.sdkTag, generated_at: docs.generatedAt, contracts_count: docs.contracts.length, capabilities_count: docs.capabilities.length });
    });

    r.post('/manifests/validate', limiter, json, (req, res) => {
        const b = req.body || {};
        const kind = b.kind === 'mod' ? 'mod' : (b.kind === 'app' ? 'app' : null);
        if (!kind) return problem(req, res, 422, 'manifest.kind', 'kind is app or mod');
        const v = manifests.validate(kind, b.manifest, { eventTypes: docs.eventTypes });
        res.status(v.valid ? 200 : 422).json({ ...v, contracts_version: docs.contractsVersion });
    });

    // Guards (the Network key is fetched before the synchronous guard runs).
    const guardOpts = { getPublicKey: () => keys.get(), issuer: config.networkIssuer, audience: 'openvibe.codes', acceptSandbox: true };
    const loadKey = (req, res, next) => { keys.ensure().then(() => next(), () => next()); };
    const manageGuard = serviceAuth.requireCapability('codes.release.manage', guardOpts);
    const readGuard = serviceAuth.requireCapability('codes.release.read', guardOpts);
    const bearer = (req) => String(req.headers.authorization || '').startsWith('Bearer ');
    // Public reads: anonymous callers pass; a presented token must be valid and hold codes.release.read.
    const readAccess = [loadKey, (req, res, next) => (bearer(req) ? readGuard(req, res, next) : next())];
    const manageAccess = [loadKey, (req, res, next) => (bearer(req) ? manageGuard(req, res, next)
        : problem(req, res, 401, 'auth.required', 'send Authorization: Bearer <app token for audience openvibe.codes>'))];

    r.get('/apps/:app/releases', ...readAccess, (req, res) => {
        if (!APP_RE.test(req.params.app)) return problem(req, res, 404, 'app.not_found', 'not an app id');
        res.set('Cache-Control', 'public, max-age=60');
        res.json({ app_id: req.params.app, trust: trust.get(req.params.app), releases: releases.listForApp(req.params.app) });
    });
    r.get('/apps/:app/trust', ...readAccess, (req, res) => {
        if (!APP_RE.test(req.params.app)) return problem(req, res, 404, 'app.not_found', 'not an app id');
        res.set('Cache-Control', 'public, max-age=60');
        res.json({ app_id: req.params.app, ...trust.get(req.params.app), note_on_authority: 'metadata only; grants in OpenVibe.Network are the authority' });
    });
    r.get('/releases/:id', ...readAccess, (req, res) => {
        const rel = REL_RE.test(req.params.id) ? releases.get(req.params.id) : null;
        if (!rel || rel.status === 'draft') return problem(req, res, 404, 'release.not_found', 'no such release');
        res.set('Cache-Control', 'public, max-age=60');
        const m = releases.manifestOf(rel.manifest_id);
        res.json({ release: rel, manifest: m ? m.body : null });
    });

    // ── App token: an app manages its own releases ──────────
    /** After manageGuard: the verified token's app, project and environment. */
    function appPrincipal(req, res, appId) {
        const c = claimsOf(req);
        if (!c || typeof c.sub !== 'string' || !c.sub.startsWith('app:')) { problem(req, res, 403, 'capability.denied', 'only app tokens manage releases here; people use the portal'); return null; }
        const self = c.sub.slice(4);
        if (appId && self !== appId) { problem(req, res, 403, 'release.forbidden', 'an app manages only its own releases'); return null; }
        return {
            actor: { kind: 'app', label: c.sub, subject: self, traceparent: req.ov.traceparent },
            app: { id: self, project_id: typeof c.project_id === 'string' ? c.project_id : (Array.isArray(c.ns) ? c.ns[0] : null), environment: c.env === 'production' ? 'production' : 'sandbox', revoked_at: null },
        };
    }
    // requireCapability already verified this token (signature, issuer, audience, expiry, claims);
    // read the claims it does not copy onto req.principal (project_id, env).
    function claimsOf(req) {
        if (!req.principal || !req.principal.sub) return null;
        try { return JSON.parse(Buffer.from(String(req.headers.authorization).slice(7).trim().split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
    }
    const fail = (req, res, err) => {
        if (err instanceof ReleaseError) return problem(req, res, err.status, err.code, err.detail, err.validation ? { validation: err.validation } : undefined);
        ctx.log.error('[Codes] api error:', err && err.message ? err.message.slice(0, 200) : err);
        return problem(req, res, 500, 'internal.error', 'Internal error');
    };

    r.post('/apps/:app/releases', limiter, ...manageAccess, json, (req, res) => {
        if (!APP_RE.test(req.params.app)) return problem(req, res, 404, 'app.not_found', 'not an app id');
        const p = appPrincipal(req, res, req.params.app);
        if (!p) return;
        if (!p.app.project_id) return problem(req, res, 403, 'token.invalid_claims', 'the token names no project');
        const b = req.body || {};
        try {
            const kind = b.kind === 'mod' ? 'mod' : 'app';
            const out = releases.createDraft({ actor: p.actor, app: p.app, kind, manifest: b.manifest, notes: b.notes, eventTypes: docs.eventTypes });
            let release = out.release;
            if (b.publish === true) release = releases.publish({ actor: p.actor, releaseId: release.id, app: p.app }).release;
            res.status(201).json({ release, warnings: out.validation.warnings });
        } catch (err) { fail(req, res, err); }
    });

    for (const action of ['publish', 'deprecate', 'revoke']) {
        r.post(`/releases/:id/${action}`, limiter, ...manageAccess, json, (req, res) => {
            const rel = REL_RE.test(req.params.id) ? releases.get(req.params.id) : null;
            if (!rel) return problem(req, res, 404, 'release.not_found', 'no such release');
            const p = appPrincipal(req, res, rel.app_id);
            if (!p) return;
            const b = req.body || {};
            try {
                const out = action === 'publish' ? releases.publish({ actor: p.actor, releaseId: rel.id, app: p.app })
                    : action === 'deprecate' ? releases.deprecate({ actor: p.actor, releaseId: rel.id, app: p.app, reason: b.reason, replacement: b.replacement })
                        : releases.revoke({ actor: p.actor, releaseId: rel.id, app: p.app, reason: b.reason });
                res.json(out);
            } catch (err) { fail(req, res, err); }
        });
    }

    // eslint-disable-next-line no-unused-vars
    r.use((err, req, res, _next) => {
        if (err && err.type === 'entity.parse.failed') return problem(req, res, 400, 'request.malformed_json', 'body is not valid JSON');
        if (err && err.type === 'entity.too.large') return problem(req, res, 413, 'request.too_large', 'body too large');
        ctx.log.error('[Codes] api error:', err && err.message ? err.message.slice(0, 200) : err);
        return problem(req, res, 500, 'internal.error', 'Internal error');
    });
    return r;
}

module.exports = { createApi, MANAGE, READ };
