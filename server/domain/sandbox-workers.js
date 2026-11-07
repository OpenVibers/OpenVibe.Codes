'use strict';
/**
 * The chat plays sandbox workers Codes knows (Agent Streams S6, design 2026-11-06 §1, §6): each worker
 * (sandbox/worker.js) checks in every 30 s with what its self-test found, and Codes answers whether a healthy one exists.
 *
 * Codes does not take a worker's word for "ready": a worker is healthy only when it said ready, every required check
 * passed, its limits are enforced, and it checked in within staleMs. Anything else is not there.
 *
 *   createSandboxWorkers({ store, config })
 *     heartbeat(report, signedAt) → { ok, worker } | { ok: false, code }    (the route verified the signature)
 *     health() → { ready, workers: [{ id, healthy, version, last_seen_at, capacity, active, failing }], stale_after_ms }
 */
const REQUIRED = ['network_namespace', 'no_direct_egress', 'egress_refuses_private', 'clean_env', 'no_host_files', 'no_capabilities', 'seccomp', 'limits', 'wipe'];
const ID = /^[A-Za-z0-9_.-]{1,64}$/;

const bool = (v) => v === true;
const small = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));

/** Only the facts, in their own shape: a worker cannot store anything else here. */
function cleanReport(r) {
    const checks = {};
    for (const c of REQUIRED) checks[c] = bool(r && r.checks && r.checks[c]);
    const iso = (r && r.isolation && typeof r.isolation === 'object') ? r.isolation : {};
    const limits = iso.limits && typeof iso.limits === 'object' ? iso.limits : {};
    const isolation = {
        sandbox: String(iso.sandbox || '').slice(0, 32), user_namespace: bool(iso.user_namespace), network_namespace: bool(iso.network_namespace),
        egress: { public_only: bool(iso.egress && iso.egress.public_only), ports: Array.isArray(iso.egress && iso.egress.ports) ? iso.egress.ports.map(Number).filter((p) => p > 0 && p < 65536).slice(0, 4) : [] },
        host_credentials: String(iso.host_credentials || 'unknown').slice(0, 16), host_files: String(iso.host_files || 'unknown').slice(0, 16),
        seccomp: bool(iso.seccomp),
        limits: {
            kind: String(limits.kind || 'none').slice(0, 16), enforced: bool(limits.enforced), memory_mb: small(limits.memory_mb, 1 << 20),
            disk_mb: small(limits.disk_mb, 1 << 20), pids: small(limits.pids, 1 << 20), cpu_percent: small(limits.cpu_percent, 1 << 16),
        },
    };
    return {
        id: String(r && r.worker_id || ''), version: String(r && r.version || '').slice(0, 32), ready: bool(r && r.ready), checks, isolation,
        capacity: small(r && r.capacity, 1000), active: small(r && r.active, 1000),
    };
}

/** Why a reported worker is not healthy (empty when it is). */
function failing(row, { now, staleMs }) {
    const out = [];
    if (!row.ready) out.push('not_ready');
    for (const c of REQUIRED) if (!(row.checks && row.checks[c] === true)) out.push(c);
    if (!(row.isolation && row.isolation.limits && row.isolation.limits.enforced === true)) out.push('limits_not_enforced');
    if (!(row.isolation && row.isolation.network_namespace === true)) out.push('no_network_namespace');
    if (now - new Date(row.last_seen_at).getTime() > staleMs) out.push('stale');
    return [...new Set(out)];
}

function createSandboxWorkers({ store, config }) {
    const db = store.db;
    const staleMs = (config.sandbox && config.sandbox.staleMs) || 90_000;

    async function heartbeat(report, signedAt) {
        const r = cleanReport(report);
        if (!ID.test(r.id)) return { ok: false, code: 'sandbox.bad_worker' };
        // The signed time must move forward: the same heartbeat sent twice is refused.
        const row = await db.maybe(
            `INSERT INTO codes_sandbox_workers (id, version, ready, checks, isolation, capacity, active, last_signed_at, last_seen_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, ready = EXCLUDED.ready, checks = EXCLUDED.checks,
                 isolation = EXCLUDED.isolation, capacity = EXCLUDED.capacity, active = EXCLUDED.active,
                 last_signed_at = EXCLUDED.last_signed_at, last_seen_at = EXCLUDED.last_seen_at
             WHERE codes_sandbox_workers.last_signed_at < EXCLUDED.last_signed_at
             RETURNING id`,
            [r.id, r.version, r.ready, JSON.stringify(r.checks), JSON.stringify(r.isolation), r.capacity, r.active, signedAt, new Date(store.now()).toISOString()]);
        if (!row) return { ok: false, code: 'signature.replayed' };
        return { ok: true, worker: r.id };
    }

    async function health() {
        const now = store.now();
        const rows = await db.many('SELECT * FROM codes_sandbox_workers ORDER BY id');
        const workers = rows.map((row) => {
            const f = failing(row, { now, staleMs });
            return {
                id: row.id, healthy: f.length === 0, version: row.version, last_seen_at: new Date(row.last_seen_at).toISOString(),
                capacity: Number(row.capacity), active: Number(row.active), room: Math.max(0, Number(row.capacity) - Number(row.active)),
                limits: row.isolation && row.isolation.limits ? row.isolation.limits.kind : 'none', failing: f,
            };
        });
        return { ready: workers.some((w) => w.healthy), workers, stale_after_ms: staleMs, checked_at: new Date(now).toISOString() };
    }

    return { heartbeat, health };
}

module.exports = { createSandboxWorkers, cleanReport, failing, REQUIRED };
