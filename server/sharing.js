'use strict';

/**
 * Sharing on OpenVibe.Codes (design 2026-11-06, visibility step 2), through openvibe-sdk/share.
 *
 * A run task is Only me until its owner says otherwise. The Share sheet changes just that task; the person's default
 * for new tasks lives on /run ("New tasks: Only me"). Nothing else moves: the task's row, its attempts and its
 * session are read through the one check, canView, on the page, the live stream, session.json and the task API.
 *
 * Why a task and not a project: Codes holds tasks, not projects. A run belongs to a Network project (prj_…), and the
 * /projects page is a permanent redirect to OpenVibe.Services; a shared project is Network's to model. A task's page
 * is the run page, so sharing the task shares what a teammate can help with.
 *
 * The SDK owns the model and the rules (the shares row, members, requests, transfers, the log and the delivery
 * queue). This file is the wiring: Network's name lookups and notifications, Events for share.* envelopes, and the
 * person's default.
 */
const { createShares, ShareError } = require('openvibe-sdk/share');
const { serviceAuth } = require('openvibe-contracts');

const SERVICE = 'codes';
const KIND = 'task';
const AUDIENCES = ['public', 'link', 'people', 'private'];
const DEFAULT_AUDIENCE = 'private';

const refOf = (id) => ({ service: SERVICE, kind: KIND, id: String(id) });

/** Codes' viewer as the SDK wants it: a subject object, and the staff bit. */
function shareViewer(v) {
    if (!v || !v.subject) return null;
    if (String(v.subject).startsWith('usr_')) return { subject: { type: 'user', id: v.subject }, staff: !!v.staff };
    return null;
}

function createSharing({ db, config, fetchImpl = globalThis.fetch, log = console } = {}) {
    const base = String(config.networkInternalUrl || '').replace(/\/+$/, '');
    const tokens = config.oauth && config.oauth.clientSecret ? serviceAuth.createTokenClient({
        tokenUrl: base + '/oauth/token',
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network',
        scope: 'identity.subject.resolve network.notifications.push',
        fetch: fetchImpl,
    }) : null;

    async function networkJson({ path, method = 'GET', json, query } = {}) {
        if (!tokens) throw new Error('Network is not configured for this service');
        const url = new URL(base + path);
        for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
        const headers = { Accept: 'application/json', ...(await tokens.authHeaders()) };
        if (json !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetchImpl(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json), signal: AbortSignal.timeout(8000) });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error('Network ' + method + ' ' + path + ' ' + res.status + ': ' + ((body && (body.detail || body.error)) || 'failed'));
            err.status = res.status;
            throw err;
        }
        return body;
    }

    /** One notification. It never carries the task's text. */
    async function notify(n) {
        const to = n && n.to;
        if (!to || to.type !== 'user') return;
        const words = {
            'share.added': ['A task was shared with you', 'Open it on OpenVibe.Codes.'],
            'share.access_requested': ['Someone asked for access to your task', 'Review the request on OpenVibe.Codes.'],
            'share.transfer.requested': ['Someone wants to give you a task', 'Accept or decline it on OpenVibe.Codes.'],
            'share.transfer.answered': ['A task transfer was answered', 'See what happened on OpenVibe.Codes.'],
        }[n.kind] || ['Sharing on OpenVibe.Codes', 'There is something new for you.'];
        try {
            await networkJson({
                path: '/internal/notifications/push', method: 'POST',
                json: {
                    subject: to.id, type: 'GENERIC', title: words[0], message: words[1],
                    service: 'codes', url: n.ref && n.ref.id ? `${config.baseUrl}/run/tasks/${encodeURIComponent(n.ref.id)}` : `${config.baseUrl}/run`,
                    category: 'social',
                },
            });
        } catch (err) {
            log.warn('[Sharing] notification not sent:', err.message);
        }
    }

    /**
     * OpenVibe.Events. Codes' own outbox carries codes.task.* envelopes; a share envelope is written straight out,
     * and a refusal only loses the notification's event copy (the setting is the owner's, decided by canView).
     */
    async function publish(envelope) {
        if (!config.events || !config.events.url) { log.warn('[Sharing] no events URL configured; share envelope not sent'); return; }
        const res = await fetchImpl(String(config.events.url).replace(/\/+$/, ''), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(envelope),
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error('Events answered ' + res.status);
    }

    const shares = createShares({
        db,
        network: { json: networkJson },
        events: { publish },
        notify,
    });

    const sv = (viewer) => shareViewer(viewer);

    return {
        shares,
        SERVICE,
        KIND,
        AUDIENCES,
        DEFAULT_AUDIENCE,
        refOf,
        shareViewer,
        networkJson,
        /** Register a task, Only me until its owner says otherwise. */
        register: async (viewer, id, audience = DEFAULT_AUDIENCE) => await shares.register(refOf(id), {
            owner_subject: { type: 'user', id: String(viewer.subject) },
            audience: AUDIENCES.includes(audience) ? audience : DEFAULT_AUDIENCE,
        }),
        canView: async (viewer, id) => await shares.canView(sv(viewer), refOf(id)),
        canEdit: async (viewer, id) => await shares.canEdit(sv(viewer), refOf(id)),
        /** Just the audience, for deciding between "Only me" (no hint) and "Specific people" (the gate). */
        audienceOf: async (id) => {
            const row = await db.maybe('SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', [SERVICE, KIND, String(id)]);
            return row ? row.audience : null;
        },
        defaultOf: async (subject) => {
            if (!subject) return DEFAULT_AUDIENCE;
            const row = await db.maybe('SELECT audience FROM codes_share_defaults WHERE subject = $1', [String(subject)]);
            return row && AUDIENCES.includes(row.audience) ? row.audience : DEFAULT_AUDIENCE;
        },
        /** Set the default, and with `applyAll` move the person's existing tasks too (rule 2). */
        setDefault: async (subject, audience, { applyAll = false } = {}) => {
            if (!subject) return false;
            const want = AUDIENCES.includes(audience) ? audience : DEFAULT_AUDIENCE;
            await db.exec(`INSERT INTO codes_share_defaults (subject, audience, updated_at) VALUES ($1, $2, now())
                ON CONFLICT (subject) DO UPDATE SET audience = excluded.audience, updated_at = now()`, [String(subject), want]);
            if (applyAll) {
                await db.exec(`UPDATE shares SET audience = $1, revision = revision + 1
                    WHERE service = $2 AND kind = $3 AND owner_subject->>'id' = $4 AND owner_subject->>'type' = 'user'`,
                    [want, SERVICE, KIND, String(subject)]);
            }
            return true;
        },
        /** The uniform API's describe(ref): the item's title and its page. */
        describe: async (ref) => {
            if (ref.service !== SERVICE) return {};
            if (ref.kind === KIND) {
                const row = await db.maybe('SELECT prompt FROM run_tasks WHERE id = $1', [String(ref.id)]);
                if (!row) return {};
                return {
                    title: String(row.prompt || 'A task').split('\n')[0].slice(0, 90),
                    link: `${config.baseUrl}/run/tasks/${encodeURIComponent(ref.id)}`,
                    roles: ['viewer'],
                    transferable: false,
                };
            }
            // A skill in the hub: the same four audiences and members, its own page, never transferable.
            if (ref.kind === 'skill') {
                const row = await db.maybe('SELECT title FROM codes_skills WHERE id = $1', [String(ref.id)]);
                if (!row) return {};
                return {
                    title: String(row.title || 'A skill').slice(0, 90),
                    link: `${config.baseUrl}/skills/${encodeURIComponent(ref.id)}`,
                    roles: ['viewer'],
                    transferable: false,
                };
            }
            return {};
        },
        /** Expire members and transfers, then send the queued events and notifications. */
        work: async ({ flush = true } = {}) => {
            let expired = 0;
            try { expired = await shares.expireMembers(); } catch (err) { log.warn('[Sharing] expiry sweep:', err.message); }
            let sent = 0;
            if (flush) { try { sent = await shares.flush(); } catch (err) { log.warn('[Sharing] deliveries:', err.message); } }
            return { expired, sent };
        },
    };
}

module.exports = { createSharing, shareViewer, refOf, AUDIENCES, SERVICE, KIND, DEFAULT_AUDIENCE };
