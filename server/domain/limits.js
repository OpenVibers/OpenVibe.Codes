'use strict';

/**
 * The limits a developer project meets, as each enforcing service reports them in its /limits.json
 * (read from its running configuration, WS-N task 7). Shared by /docs/limits and a project's usage
 * page (WS-N task 4). A service that does not answer gives a problem, never remembered numbers; a
 * good answer is kept for ttlMs so a page view never waits on a service twice in a row.
 */

/** The services that publish /limits.json, with where Codes reads them and where people can. */
function limitSources(env = process.env) {
    return [
        // public: null until openvibe.host serves Host itself (WS-N task 10, Stage B step 2); read internally meanwhile.
        { service: 'host', name: 'OpenVibe Host', internal: env.OV_HOST_INTERNAL_URL || 'http://127.0.0.1:4910', public: null },
        { service: 'events', name: 'OpenVibe Events', internal: env.OV_EVENTS_INTERNAL_URL || 'http://127.0.0.1:4300', public: 'https://events.openvibe.network/limits.json' },
        { service: 'media', name: 'OpenVibe Media', internal: env.OV_MEDIA_INTERNAL_URL || 'http://127.0.0.1:4100', public: 'https://openvibe.media/limits.json' },
    ];
}

function createLimitsReader({ sources = limitSources(), ttlMs = 300_000, fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
    const cache = new Map();
    /** → { body } | { problem } for one source. */
    async function read(src) {
        const hit = cache.get(src.service);
        if (hit && Date.now() - hit.at < ttlMs) return { body: hit.body };
        try {
            const out = await fetchImpl(`${src.internal.replace(/\/$/, '')}/limits.json`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
            if (!out.ok) throw new Error(`${src.name} answered ${out.status}`);
            const body = await out.json();
            if (!body || !Array.isArray(body.limits)) throw new Error(`${src.name} answered without a limits list`);
            cache.set(src.service, { at: Date.now(), body });
            return { body };
        } catch (err) {
            return { problem: { code: 'codes.limits_unavailable', detail: err.message } };
        }
    }
    const bySource = (service) => sources.find((s) => s.service === service) || null;
    return { sources, read, bySource };
}

const MB = 1024 * 1024;
const bytes = (n) => (n >= 1024 * MB ? `${+(n / 1024 / MB).toFixed(2)} GB` : n >= MB ? `${+(n / MB).toFixed(2)} MB` : n >= 1024 ? `${+(n / 1024).toFixed(1)} KB` : `${n} bytes`);

/** A limit's value as people read it (null: no limit, 0: none allowed). */
function amount(v, unit) {
    if (v === null || v === undefined) return 'no limit';
    if (v === 0) return 'none';
    const n = Number(v).toLocaleString('en-US');
    if (unit === 'bytes') return bytes(Number(v));
    if (unit === 'per_minute') return `${n} a minute`;
    if (unit === 'per_day') return `${n} in 24 hours`;
    if (unit === 'hours') return `${n} hours`;
    if (unit === 'days') return `${n} days`;
    return n;
}

module.exports = { limitSources, createLimitsReader, amount, bytes };
