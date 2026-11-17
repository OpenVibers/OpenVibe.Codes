'use strict';
/**
 * Desktop and browser work, handed from Codes to the person's Actor (plan §AD.22, the owner 11-17: Codes "can leverage
 * actor for desktop or browser use", all on one shared core). A coding conductor that needs a page looked at, a site
 * clicked through or a desktop app driven asks Actor, which runs it on the person's own machine or an OpenVibe shared
 * node, at the person's own level. Codes acts as that person (X-OV-Subject) with its service token for openvibe.actor
 * (Network grants Codes actor.task.create and actor.task.read only); Actor shows Codes only the tasks Codes started.
 *
 *   createActorTasks({ config, fetchImpl, log })
 *     enabled                          Codes has its Network client
 *     start(subject, { task, mode })   → the Actor task (id, state, …)
 *     get(subject, id)                 → the Actor task, or null
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const TASK_ID = /^[a-z]{2,8}_[0-9A-HJKMNP-TV-Z]{26}$/;
const MODES = new Set(['cheapest', 'balanced', 'best', 'fastest', 'private']);

function createActorTasks({ config, fetchImpl = globalThis.fetch, log = console }) {
    const actor = config.actor || {};
    const internalUrl = String(actor.internalUrl || 'http://127.0.0.1:4950').replace(/\/+$/, '');
    const tokens = (config.oauth && config.oauth.clientId && config.oauth.clientSecret)
        ? createServiceTokenClient({
            tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId,
            clientSecret: config.oauth.clientSecret, audience: 'openvibe.actor', scope: 'actor.task.create actor.task.read', fetch: fetchImpl,
        })
        : null;
    const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

    async function call(method, pathname, subject, json = null) {
        if (!tokens) throw fail(503, 'actor.off', 'Actor is not open from Codes here');
        if (!USER.test(String(subject || ''))) throw fail(400, 'subject.required', 'a person signs in first');
        const headers = { Accept: 'application/json', Authorization: `Bearer ${await tokens.getToken()}`, 'X-OV-Subject': subject };
        if (json) headers['Content-Type'] = 'application/json';
        let res;
        try {
            res = await fetchImpl(`${internalUrl}${pathname}`, { method, headers, ...(json ? { body: JSON.stringify(json) } : {}), signal: AbortSignal.timeout(15_000) });
        } catch (e) {
            throw fail(503, 'actor.unreachable', `Actor did not answer: ${String(e && e.message).slice(0, 120)}`);
        }
        const text = await res.text().catch(() => '');
        let doc = null;
        try { doc = text ? JSON.parse(text) : null; } catch { doc = null; }
        return { status: res.status, doc };
    }

    async function start(subject, { task, mode = 'balanced' } = {}) {
        const t = String(task || '').trim();
        if (!t || t.length > 8000) throw fail(422, 'actor.task_invalid', 'say what Actor should do (up to 8,000 characters)');
        if (!MODES.has(mode)) throw fail(422, 'actor.mode_invalid', 'mode is cheapest, balanced, best, fastest or private');
        const r = await call('POST', '/api/v1/tasks', subject, { task: t, mode });
        if (r.status === 200 || r.status === 201) return r.doc;
        const d = r.doc || {};
        log.warn(`[Codes] Actor refused a task for ${subject}: ${r.status} ${d.code || ''}`);
        throw fail(r.status >= 400 && r.status < 500 ? r.status : 502, d.code || 'actor.refused', d.detail || `Actor answered ${r.status}`);
    }

    async function get(subject, id) {
        if (!TASK_ID.test(String(id || ''))) return null;
        const r = await call('GET', `/api/v1/tasks/${encodeURIComponent(id)}`, subject);
        if (r.status === 404 || r.status === 403) return null;
        if (r.status !== 200) throw fail(502, (r.doc && r.doc.code) || 'actor.read_failed', `Actor answered ${r.status}`);
        return r.doc;
    }

    return { get enabled() { return !!tokens; }, start, get };
}

/** What a conductor needs of an Actor task: where it is, what it found, what went wrong, what it cost. */
function summary(t) {
    if (!t) return null;
    return {
        id: t.id, state: t.state, task: String(t.task || '').slice(0, 300),
        result: t.result == null ? null : t.result, error: t.error || null,
        cost_usd: t.cost && typeof t.cost.usd === 'number' ? t.cost.usd : null,
        finished_at: t.finished_at || null, page: `https://openvibe.actor/chat/${t.id}`,
    };
}

module.exports = { createActorTasks, summary, MODES };
