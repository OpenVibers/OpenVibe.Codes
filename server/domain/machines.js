'use strict';

/**
 * A person's machines, as OpenVibe.Network knows them (Codes C4b).
 *
 * A machine is paired by redeeming a one-time code on OpenVibe.Network (docs: OpenVibe.Node README and
 * internal/link/network.go): openvibe.bot/machines mints `pair_…` with a code that lasts ten minutes, and the machine
 * redeems it -> `openvibe-node pair --network <URL> --pairing pair_… --code ABCD-1234`. The result is a node principal
 * (`nod_…`) owned by the person; that principal, its status and when it was last seen are what this module reads.
 *
 * Codes never mints a pairing: that is Bot's, holding network.node.manage. Codes reads the person's own machines with
 * their own session token (GET /api/v1/me/nodes accepts it as a Bearer) and can revoke one (the person's own route).
 *
 *   createMachines({ config, fetchImpl, log })
 *     list(token)            → { ok, machines } or { ok: false, problem }
 *     revoke(token, id)      → { ok, machine } or { ok: false, problem }
 *
 * A Network that answers 401 throws (with a 401 status), so the caller may refresh the person's session and try
 * again; every other failure is a problem beside an empty list, never a silent blank.
 *
 * Nothing here holds a credential: the answers carry ids, names, timestamps and a status, never a secret.
 */

const ONLINE_MS = 5 * 60_000;
const NODE = /^(?:nod_)?[0-9A-HJKMNP-TV-Z]{26}$/;

const iso = (v) => {
    if (!v) return null;
    const t = Date.parse(String(v));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** One principal, as the page shows it: the state a person reads, never a secret. */
function present(node, now = Date.now()) {
    const lastSeen = iso(node && node.last_seen_at);
    const seenAt = lastSeen ? Date.parse(lastSeen) : null;
    const revoked = !!(node && (node.status === 'revoked' || node.revoked_at));
    const state = revoked ? 'revoked' : (seenAt && now - seenAt < ONLINE_MS ? 'online' : 'away');
    return {
        id: String((node && node.principal) || '').slice(0, 64),
        node_id: node && node.node_id ? String(node.node_id).slice(0, 128) : null,
        name: node && node.name ? String(node.name).slice(0, 120) : null,
        status: revoked ? 'revoked' : 'active',
        state,
        last_seen_at: lastSeen,
        created_at: iso(node && node.created_at),
        revoked_at: iso(node && node.revoked_at),
        paired_for: node && node.paired_for && typeof node.paired_for === 'object'
            ? { service: node.paired_for.service || null, ref: node.paired_for.ref || null } : null,
    };
}

const STATE_WORD = { online: 'Online', away: 'Seen before', revoked: 'Revoked' };

function createMachines({ config, fetchImpl = globalThis.fetch, log = console } = {}) {
    const base = String(config.networkInternalUrl || '').replace(/\/+$/, '');

    async function call(token, method, path, body) {
        const res = await fetchImpl(`${base}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${token}`, Accept: 'application/json',
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(8000),
        });
        const doc = await res.json().catch(() => null);
        return { status: res.status, ok: res.ok, doc };
    }

    /** The person's machines, newest first. A Network that does not answer says so instead of an empty list. */
    async function list(token) {
        if (!token) return { ok: false, problem: { status: 401, code: 'machines.signed_out', detail: 'sign in again to see your machines' } };
        let out;
        try { out = await call(token, 'GET', '/api/v1/me/nodes'); } catch (e) {
            log.warn(`[Codes] the machines could not be read: ${String(e && e.message).slice(0, 200)}`);
            return { ok: false, problem: { status: 503, code: 'machines.unavailable', detail: 'OpenVibe.Network did not answer, so your machines could not be read' } };
        }
        if (!out.ok) {
            const doc = out.doc || {};
            // An expired session is the caller's to refresh: throwing with a 401 lets it try a fresh token first.
            if (out.status === 401) throw Object.assign(new Error('the session expired'), { status: 401, code: 'machines.expired' });
            return { ok: false, problem: { status: out.status, code: doc.code || 'machines.unavailable', detail: doc.detail || doc.error || `Network answered ${out.status}` } };
        }
        const nodes = Array.isArray(out.doc && out.doc.nodes) ? out.doc.nodes : [];
        const now = Date.now();
        return { ok: true, machines: nodes.filter((n) => n && NODE.test(String(n.principal || ''))).map((n) => present(n, now)) };
    }

    /** Revoke one of the person's machines (the owner's own route). */
    async function revoke(token, id) {
        if (!NODE.test(String(id || ''))) return { ok: false, problem: { status: 422, code: 'machines.invalid', detail: 'that is not one of your machines' } };
        let out;
        try { out = await call(token, 'POST', `/api/v1/me/nodes/${encodeURIComponent(id)}/revoke`, {}); } catch (e) {
            return { ok: false, problem: { status: 503, code: 'machines.unavailable', detail: `OpenVibe.Network did not answer: ${String(e && e.message).slice(0, 120)}` } };
        }
        if (!out.ok) {
            const doc = out.doc || {};
            if (out.status === 401) throw Object.assign(new Error('the session expired'), { status: 401, code: 'machines.expired' });
            return { ok: false, problem: { status: out.status, code: doc.code || 'machines.unavailable', detail: doc.detail || doc.error || `Network answered ${out.status}` } };
        }
        return { ok: true, machine: present(out.doc) };
    }

    return { list, revoke, present, STATE_WORD };
}

module.exports = { createMachines, present, STATE_WORD, ONLINE_MS };
