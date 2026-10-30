'use strict';

/**
 * The person's own memory store, as OpenVibe.AI holds it (OpenVibe Memory M2b).
 *
 * The store lives in OpenVibe.AI (server/memory): a note belongs to one person, it is sealed there with
 * AI_MEMORY_KEY and only that person's own token opens it. Codes never holds a note: it forwards the person's
 * token to AI and renders what comes back. The token stays in this process — it is never written into a page,
 * a log line or an error message, and no note text is ever logged.
 *
 *   items(token, { scope, status, q })  the person's own items
 *   patch(token, id, body)              text, kind, scope or status
 *   remove(token, id)                   one note, gone
 *   removeBySource(token, source)       everything from one source, gone
 *   profile(token, scope)               the summary of one scope
 *   reads(token, limit)                 who read the person's memory (never the text)
 *   split(token, id)                    undo a merge
 *   settle(token, id, keep)             settle a conflict: one stays, the other goes
 *
 * Every call carries the person's own Bearer token. A refusal from AI arrives as an error with its problem
 * code (memory.not_found, input.invalid, …) and its detail — never a note's text.
 */

const MEMORY_PATH = '/api/v1/memory';

function createMemory({ config, fetchImpl = globalThis.fetch, log = console } = {}) {
    // The store is reached on the loopback when Codes and AI share a host (the vault does the same).
    const base = String((config.ai && (config.ai.internalUrl || config.ai.url)) || 'https://ai.openvibe.services').replace(/\/+$/, '');

    async function call(token, method, path, body) {
        if (!token) throw Object.assign(new Error('Not signed in'), { status: 401, code: 'memory.signed_out' });
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, {
                method,
                headers: {
                    Authorization: `Bearer ${token}`, Accept: 'application/json',
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(8000),
            });
        } catch (e) {
            log.warn(`[Codes] the memory store did not answer: ${String(e && e.message).slice(0, 120)}`);
            throw Object.assign(new Error('The memory store did not answer'), { status: 503, code: 'memory.unavailable' });
        }
        const doc = await res.json().catch(() => null);
        if (!res.ok) {
            const code = String((doc && doc.code) || 'memory.unavailable');
            const detail = String((doc && (doc.detail || doc.title || doc.error_description)) || 'the memory store refused the change').slice(0, 200);
            log.warn(`[Codes] the memory store refused a request: ${res.status} ${code}`);
            throw Object.assign(new Error(detail), { status: res.status, code });
        }
        return doc || {};
    }

    /** The person's own items. `q` is a search over the text; the store answers with at most 200 items. */
    async function items(token, { scope, status, q } = {}) {
        const query = new URLSearchParams();
        if (scope) query.set('scope', String(scope));
        if (status) query.set('status', String(status));
        if (q) query.set('q', String(q));
        const suffix = query.toString() ? `?${query}` : '';
        const doc = await call(token, 'GET', `${MEMORY_PATH}/items${suffix}`);
        return { items: Array.isArray(doc.items) ? doc.items : [], count: Number(doc.count) || 0 };
    }

    /** One note, changed: its text, kind, scope or status. */
    async function patch(token, id, body) {
        const doc = await call(token, 'PATCH', `${MEMORY_PATH}/items/${encodeURIComponent(id)}`, body || {});
        return { item: doc.item || null };
    }

    /** One note, gone. */
    async function remove(token, id) {
        const doc = await call(token, 'DELETE', `${MEMORY_PATH}/items/${encodeURIComponent(id)}`);
        return { deleted: Number(doc.deleted) || 0 };
    }

    /** Everything from one source, gone: the store's own "delete means gone". */
    async function removeBySource(token, source) {
        const doc = await call(token, 'DELETE', `${MEMORY_PATH}/items?source=${encodeURIComponent(source)}`);
        return { deleted: Number(doc.deleted) || 0 };
    }

    /** The summary of one scope: the profile the store builds from the person's own notes. */
    async function profile(token, scope) {
        const query = scope ? `?scope=${encodeURIComponent(scope)}` : '';
        const doc = await call(token, 'GET', `${MEMORY_PATH}/profile${query}`);
        return { profile: doc.profile || null };
    }

    /** Who read the person's memory: the agent's name, the purpose, the scopes and how many notes. Never text. */
    async function reads(token, limit = 50) {
        const doc = await call(token, 'GET', `${MEMORY_PATH}/reads?limit=${encodeURIComponent(String(limit || 50))}`);
        return { reads: Array.isArray(doc.reads) ? doc.reads : [], count: Number(doc.count) || 0 };
    }

    /** Undo a merge: the note and the one it swallowed go apart again. */
    async function split(token, id) {
        const doc = await call(token, 'POST', `${MEMORY_PATH}/items/${encodeURIComponent(id)}/split`, {});
        return { items: Array.isArray(doc.items) ? doc.items : [], count: Number(doc.count) || 0, split: Number(doc.split) || 0 };
    }

    /** Settle a conflict: the note that stays, and the one that goes. */
    async function settle(token, id, keep) {
        const doc = await call(token, 'POST', `${MEMORY_PATH}/items/${encodeURIComponent(id)}/settle`, { keep: String(keep || '') });
        return { kept: doc.kept || null, archived: doc.archived || null };
    }

    return { items, patch, remove, removeBySource, profile, reads, split, settle };
}

module.exports = { createMemory, MEMORY_PATH };
