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
 *   providers(token)                    the cloud walkthroughs and the extraction prompt (M3)
 *   preview(token, { body, contentType }) parse an export into redacted candidates; nothing is kept
 *   commit(token, id, keep)             keep the ticked candidates, and drop the draft
 *   discard(token, id)                  throw the draft away
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

    /** A raw body (an export zip or one multipart form) straight to the store; it parses it, never Codes. */
    async function upload(token, path, body, contentType) {
        if (!token) throw Object.assign(new Error('Not signed in'), { status: 401, code: 'memory.signed_out' });
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`, Accept: 'application/json',
                    'Content-Type': contentType || 'application/octet-stream',
                },
                body,
                // Parsing a large export is slower than one item; still bounded, so a stuck store frees the page.
                signal: AbortSignal.timeout(60000),
            });
        } catch (e) {
            log.warn(`[Codes] the memory store did not answer the import: ${String(e && e.message).slice(0, 120)}`);
            throw Object.assign(new Error('The memory store did not answer'), { status: 503, code: 'memory.unavailable' });
        }
        const doc = await res.json().catch(() => null);
        if (!res.ok) {
            const code = String((doc && doc.code) || 'memory.unavailable');
            const detail = String((doc && (doc.detail || doc.title || doc.error_description)) || 'the memory store refused the import').slice(0, 200);
            log.warn(`[Codes] the memory store refused an import: ${res.status} ${code}`);
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

    /* ── Memory M3: the guided cloud import ──────────────────────────────────────────────────────────────── */

    /** The walkthroughs and the extraction prompt. No note ever comes back from this call. */
    async function providers(token) {
        const doc = await call(token, 'GET', `${MEMORY_PATH}/import/providers`);
        return { providers: Array.isArray(doc.providers) ? doc.providers : [], prompt: String(doc.prompt || '') };
    }

    /**
     * Parse one export without keeping it. The body goes to the store untouched (a zip or one multipart form);
     * the answer is the sealed draft's id and its redacted candidates, which the page shows for a choice.
     */
    async function preview(token, { body, contentType } = {}) {
        if (body == null) throw Object.assign(new Error('Choose an export file or paste an answer'), { status: 422, code: 'import.invalid' });
        const doc = await upload(token, `${MEMORY_PATH}/import/preview`, body, contentType);
        return { import: doc.import || null };
    }

    /** Keep the ticked candidates, and let the rest go with the draft. */
    async function commit(token, id, keep) {
        const doc = await call(token, 'POST', `${MEMORY_PATH}/import/${encodeURIComponent(id)}/commit`, { keep: Array.isArray(keep) ? keep : [] });
        return { kept: Number(doc.kept) || 0, created: Number(doc.created) || 0, deduped: Number(doc.deduped) || 0, left_out: Number(doc.left_out) || 0 };
    }

    /** Throw a preview away without keeping anything. */
    async function discard(token, id) {
        const doc = await call(token, 'DELETE', `${MEMORY_PATH}/import/${encodeURIComponent(id)}`);
        return { discarded: Number(doc.discarded) || 0 };
    }

    /* ── Memory M5: the memory services, the portable file and team sharing ─────────────────────────────── */

    /** The three memory services, each with its health and its four-character hint, never a key. */
    async function services(token) {
        const doc = await call(token, 'GET', `${MEMORY_PATH}/services`);
        return { providers: Array.isArray(doc.providers) ? doc.providers : [] };
    }

    /** Store or replace one service's key. The store seals it before it answers. */
    async function connect(token, provider, body) {
        const doc = await call(token, 'PUT', `${MEMORY_PATH}/services/${encodeURIComponent(provider)}`, body || {});
        return { service: doc.service || null };
    }

    async function disconnect(token, provider) {
        const doc = await call(token, 'DELETE', `${MEMORY_PATH}/services/${encodeURIComponent(provider)}`);
        return { removed: Number(doc.removed) || 0 };
    }

    /** Read the service and put what it has into the store; the answer is counts only. */
    async function syncService(token, provider) {
        const doc = await call(token, 'POST', `${MEMORY_PATH}/services/${encodeURIComponent(provider)}/sync`, {});
        return {
            provider: doc.provider || provider, found: Number(doc.found) || 0, imported: Number(doc.imported) || 0,
            deduped: Number(doc.deduped) || 0, skipped: Number(doc.skipped) || 0,
        };
    }

    /** The one portable file, decrypted for the person's own export. */
    async function exportFile(token, scope) {
        const query = scope ? `?scope=${encodeURIComponent(scope)}` : '';
        return await call(token, 'GET', `${MEMORY_PATH}/export${query}`);
    }

    /** Import the same document, under the person's own token. */
    async function importFile(token, document) {
        const doc = await call(token, 'POST', `${MEMORY_PATH}/import`, document);
        return {
            imported: Number(doc.imported) || 0, created: Number(doc.created) || 0,
            deduped: Number(doc.deduped) || 0, skipped: Number(doc.skipped) || 0,
        };
    }

    /** The stores other people shared with this person: owner ids and access only, never a note. */
    async function shared(token) {
        const doc = await call(token, 'GET', `${MEMORY_PATH}/shared`);
        return { stores: Array.isArray(doc.stores) ? doc.stores : [] };
    }

    /** One shared store's active notes. A non-member gets memory.not_found from the store, never the notes. */
    async function sharedStore(token, owner, scope) {
        const query = scope ? `?scope=${encodeURIComponent(scope)}` : '';
        const doc = await call(token, 'GET', `${MEMORY_PATH}/stores/${encodeURIComponent(owner)}${query}`);
        return { owner: doc.owner || owner, items: Array.isArray(doc.items) ? doc.items : [], count: Number(doc.count) || 0 };
    }

    return { items, patch, remove, removeBySource, profile, reads, split, settle, providers, preview, commit, discard,
        services, connect, disconnect, syncService, exportFile, importFile, shared, sharedStore };
}

module.exports = { createMemory, MEMORY_PATH };
