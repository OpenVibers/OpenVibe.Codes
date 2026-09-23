'use strict';

/**
 * Manifest validation with openvibe-contracts.
 *
 *   mod   mods.mod-manifest@1
 *   app   codes.app-manifest@1
 *
 * Schema errors come first; then checks the schema cannot express, against the pinned catalog:
 * every requested capability must exist and be grantable to apps (active + public/partner), ranges
 * must parse, consumed events should be produced by someone. With an app context (a release), the
 * manifest must also describe THAT app: same id, project and environment.
 */
const contracts = require('openvibe-contracts');
const { satisfiesRange } = require('openvibe-sdk/core');
const { GRANTABLE_VISIBILITIES } = require('../docs/generate');

const contractsVersion = require('openvibe-contracts/package.json').version;
const sdkVersion = require('openvibe-sdk/package.json').version;
const SCHEMAS = { app: 'codes.app-manifest@1', mod: 'mods.mod-manifest@1' };

function rangeError(range) {
    try { satisfiesRange('0.0.0', range); return null; } catch (err) { return err.message; }
}

/** Starter manifests for the editor (valid shapes; the ids are the developer's own). */
function template(kind, { appId, projectId, environment, name, subject } = {}) {
    if (kind === 'mod') {
        return {
            id: 'mod_01JABCDEFGHJKMNPQRSTVWXYZ0',
            name: name || 'My mod',
            version: '0.1.0',
            description: '',
            publisher: appId ? { type: 'app', id: appId } : { type: 'user', id: subject || 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0' },
            target: 'games.browser',
            runtime: 'games-content@1',
            permissions: { capabilities: [] },
            resources: { cpuMs: 1, memoryMb: 0, storageMb: 0 },
            compatibility: { runtime: '>=1.0.0 <2.0.0', contracts: `^${contractsVersion}` },
        };
    }
    return {
        id: appId || 'app_01JABCDEFGHJKMNPQRSTVWXYZ0',
        name: name || 'My app',
        version: '0.1.0',
        publisher: appId ? { type: 'app', id: appId } : { type: 'user', id: subject || 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0' },
        project_id: projectId || 'prj_01JABCDEFGHJKMNPQRSTVWXYZ0',
        environment: environment || 'sandbox',
        capabilities: [],
        compatibility: { contracts: `^${contractsVersion}`, sdk: `^${sdkVersion}` },
    };
}

/**
 * validate(kind, manifest, { app, viewerSubject, eventTypes })
 *   app: the Network app view (id, project_id, environment, grants) when validating for a release
 * → { valid, errors: [{ path, message }], warnings: [{ path, message }], schema: { id, version } }
 */
function validate(kind, manifest, { app = null, viewerSubject = null, eventTypes = null } = {}) {
    const errors = [];
    const warnings = [];
    if (kind !== 'app' && kind !== 'mod') return { valid: false, errors: [{ path: '/', message: 'kind is app or mod' }], warnings, schema: null };
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        return { valid: false, errors: [{ path: '/', message: 'a manifest is a JSON object' }], warnings, schema: null };
    }
    const r = contracts.validate(SCHEMAS[kind], manifest);
    errors.push(...r.errors);
    const entry = contracts.resolve(SCHEMAS[kind]);
    const schema = { id: entry.id, version: entry.version };

    // Requested capabilities: must exist in the pinned catalog and be grantable to apps.
    const requested = kind === 'mod'
        ? (manifest.permissions && Array.isArray(manifest.permissions.capabilities) ? manifest.permissions.capabilities : [])
        : (Array.isArray(manifest.capabilities) ? manifest.capabilities : []);
    const base = kind === 'mod' ? '/permissions/capabilities' : '/capabilities';
    requested.forEach((id, i) => {
        if (typeof id !== 'string') return;
        const cap = contracts.capabilities.get(id);
        if (!cap) { errors.push({ path: `${base}/${i}`, message: `${id} is not in openvibe-contracts ${contractsVersion}` }); return; }
        if (!GRANTABLE_VISIBILITIES.has(cap.visibility)) { errors.push({ path: `${base}/${i}`, message: `${id} is ${cap.visibility}: it is never granted to apps or mods` }); return; }
        if (cap.status !== 'active') warnings.push({ path: `${base}/${i}`, message: `${id} is ${cap.status}: it cannot be granted until it is active` });
        if (cap.visibility === 'partner') warnings.push({ path: `${base}/${i}`, message: `${id} is partner-only: staff must add it to the project's allowance by hand` });
        if (app && Array.isArray(app.grants) && !app.grants.includes(id)) warnings.push({ path: `${base}/${i}`, message: `${id} is not granted to this app yet (request it on the app page; Network decides)` });
    });

    // Ranges.
    const comp = manifest.compatibility && typeof manifest.compatibility === 'object' ? manifest.compatibility : {};
    for (const key of ['contracts', 'sdk', 'runtime']) {
        if (typeof comp[key] !== 'string') continue;
        const bad = rangeError(comp[key]);
        if (bad) { errors.push({ path: `/compatibility/${key}`, message: `not a semver range: ${bad}` }); continue; }
        if (key === 'contracts' && !satisfiesRange(contractsVersion, comp[key])) warnings.push({ path: '/compatibility/contracts', message: `the network's pinned openvibe-contracts ${contractsVersion} is outside ${comp[key]}` });
        if (key === 'sdk' && !satisfiesRange(sdkVersion, comp[key])) warnings.push({ path: '/compatibility/sdk', message: `the current openvibe-sdk ${sdkVersion} is outside ${comp[key]}` });
    }

    // Events the app or mod wants delivered.
    const consumes = kind === 'mod'
        ? (manifest.permissions && Array.isArray(manifest.permissions.events) ? manifest.permissions.events : [])
        : (manifest.events && Array.isArray(manifest.events.consumes) ? manifest.events.consumes : []);
    if (eventTypes) {
        consumes.forEach((t, i) => {
            if (typeof t !== 'string') return;
            const family = t.endsWith('.*') ? t.slice(0, -1) : null;
            const known = family ? [...eventTypes].some((x) => x.startsWith(family)) : eventTypes.has(t);
            if (!known) warnings.push({ path: kind === 'mod' ? `/permissions/events/${i}` : `/events/consumes/${i}`, message: `no service in openvibe-contracts ${contractsVersion} declares it produces ${t}` });
        });
    }

    // For a release: the manifest must describe this very app.
    if (app) {
        if (kind === 'app') {
            if (manifest.id !== app.id) errors.push({ path: '/id', message: `must be this app's id ${app.id}` });
            if (manifest.project_id !== app.project_id) errors.push({ path: '/project_id', message: `must be this app's project ${app.project_id}` });
            if (manifest.environment !== undefined && manifest.environment !== app.environment) errors.push({ path: '/environment', message: `this app is ${app.environment}` });
        }
        const pub = manifest.publisher;
        if (pub && typeof pub === 'object') {
            const ok = (pub.type === 'app' && pub.id === app.id) || (pub.type === 'user' && viewerSubject && pub.id === viewerSubject);
            if (!ok) errors.push({ path: '/publisher', message: `must be this app (app ${app.id})${viewerSubject ? ` or you (user ${viewerSubject})` : ''}` });
        }
    }

    return { valid: errors.length === 0, errors, warnings, schema };
}

/** Parse a manifest from form text. → { manifest } | { error } */
function parse(text) {
    const s = String(text || '').trim();
    if (!s) return { error: 'paste a manifest (JSON)' };
    if (s.length > 64 * 1024) return { error: 'a manifest is at most 64 KB' };
    try { return { manifest: JSON.parse(s) }; } catch (err) { return { error: `not valid JSON: ${err.message.slice(0, 200)}` }; }
}

module.exports = { validate, parse, template, SCHEMAS };
