'use strict';

/**
 * The Dock's agent view (Dock plan 2026-10-30, K-D3; Agent Streams S1): the signed-in person's own agent desk stream,
 * for the Dock that Shared draws on every OpenVibe site.
 *
 *   GET  /api/v1/me/agent-view          → { agent }   the live stream, with a view ticket, or the last one as a still
 *   GET  /api/v1/me/agent-view/frame    → the last frame (JPEG or WebP), the picture when nothing is live
 *   POST /api/v1/me/agent-view/pause    → { agent }   { paused } → Live's pause (S5)
 *   POST /api/v1/me/agent-view/curtain  → { agent }   { up } → Live's curtain, raised as the owner's own button
 *   POST /api/v1/me/agent-view/mute     → { agent }   { muted } → Live's voice mute (S5)
 *   POST /api/v1/me/agent-view/end      → { agent }   Live's end
 *
 * The person's own token does all of it, passed through to OpenVibe.Live: Codes mints the view ticket server-side
 * (Agent Streams S1: an iframe on another site has no Live cookie), and Live decides — the stream is theirs, so the
 * owner's rules apply and nobody else's stream is ever in an answer. Codes holds no token of its own here and keeps
 * nothing.
 *
 * These four routes are the only ones in this API that answer another site's page: the Dock loads from whichever
 * OpenVibe site the person is on. So they carry `Access-Control-Allow-Origin: *` — no credentials, no cookie, the
 * person's bearer is the key, and a page that does not hold it reads nothing.
 *
 * The step (S2's `live.agent-stream-step@1`) is not in S1: there is no `step` field here, and the Dock shows none
 * until Live serves them.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');

const AGENT = /^ags_[0-9A-HJKMNP-TV-Z]{26}$/;
const CORS_HEADERS = 'authorization, content-type';

function createAgentView({ config, sso, actorLimits, fetchImpl = (...a) => fetch(...a), log = console }) {
    const r = asyncRouter();
    const json = express.json({ limit: '4kb' });
    const problem = (req, res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const signedIn = (req) => !!(req.viewer && req.viewer.kind === 'user' && req.viewer.subject);
    const liveBase = () => String((config.live && config.live.url) || 'https://openvibe.live').replace(/\/+$/, '');

    /** One call to Live with the person's own token. Its own deadline: the Dock must not hang on a slow Live. */
    async function live(token, path, init = {}) {
        const res = await fetchImpl(`${liveBase()}${path}`, {
            ...init,
            headers: {
                accept: 'application/json',
                authorization: `Bearer ${token}`,
                ...(init.body ? { 'content-type': 'application/json' } : {}),
                ...(init.headers || {}),
            },
            signal: AbortSignal.timeout(8000),
        });
        return res;
    }

    /** The live stream if one is up, else the newest one; null when the person has never published one. */
    async function streamOf(token) {
        let res;
        try {
            res = await live(token, '/api/streams/agent/mine');
        } catch (e) {
            throw Object.assign(new Error(`OpenVibe.Live did not answer: ${e.message}`), { status: 502, code: 'agent_view.unavailable' });
        }
        if (!res.ok) throw Object.assign(new Error(`OpenVibe.Live answered ${res.status}`), { status: res.status === 401 ? 401 : 502, code: 'agent_view.unavailable' });
        const body = await res.json().catch(() => null);
        const rows = body && Array.isArray(body.streams) ? body.streams : [];
        if (!rows.length) return null;
        return rows.find((s) => s && s.state === 'live') || rows[0];
    }

    /** A view ticket while the stream is not ended; the embed needs one for a private or unlisted stream. */
    async function ticketOf(token, row) {
        if (!row || row.state === 'ended') return { ticket: null, expiresAt: null };
        try {
            const res = await live(token, `/api/streams/agent/${encodeURIComponent(row.id)}/view-ticket`, { method: 'POST', body: '{}' });
            if (!res.ok) return { ticket: null, expiresAt: null };
            const body = await res.json().catch(() => null);
            return { ticket: body && typeof body.ticket === 'string' ? body.ticket : null, expiresAt: (body && body.expires_at) || null };
        } catch { return { ticket: null, expiresAt: null }; }
    }

    /**
     * What the Dock reads. The embed's address is built here from the stream's id and the ticket, never from a URL in
     * Live's answer, so a foreign address can never end up in the Dock's frame.
     */
    function present(row, { ticket, expiresAt }) {
        if (!row || !AGENT.test(String(row.id || ''))) return null;
        return {
            // S5: the pause and the voice's mute, shown by the Dock's four controls.
            paused: !!row.paused,
            paused_by: row.paused_by || null,
            paused_by_role: row.paused_by_role || null,
            mode: row.mode || 'watch',
            id: row.id,
            state: row.state,
            title: row.title,
            task: row.task && typeof row.task === 'object' ? row.task : null,
            curtain: { up: !!(row.curtain && row.curtain.up) },
            viewers: Number(row.viewers) || 0,
            worked_seconds: Number(row.worked_seconds) || 0,
            visibility: row.visibility,
            started_at: row.started_at || null,
            ended_at: row.ended_at || null,
            page_url: typeof row.page_url === 'string' && row.page_url.startsWith('https://openvibe.live/') ? row.page_url : `https://openvibe.live/@${encodeURIComponent(row.channel || 'you')}/agents/${row.id}`,
            // The player, with the view ticket Codes just minted. It is in the address and nowhere else in the answer.
            embed_url: ticket ? `https://openvibe.live/embed/agent/${row.id}?vt=${encodeURIComponent(ticket)}` : null,
            // The picture when nothing is live: Codes serves it, because an <img> cannot carry the person's token.
            last_frame_url: row.last_frame_url ? `${String(config.baseUrl).replace(/\/+$/, '')}/api/v1/me/agent-view/frame` : null,
        };
    }

    /** Live's voice state: the mute and the mode, for the Dock's Mute control. Null when Live does not answer. */
    async function voiceOf(token, row) {
        try {
            const res = await live(token, `/api/streams/agent/${encodeURIComponent(row.id)}/voice`);
            if (!res.ok) return null;
            const body = await res.json().catch(() => null);
            return body && body.voice ? body.voice : null;
        } catch { return null; }
    }

    async function viewOf(token) {
        const row = await streamOf(token);
        if (!row) return null;
        const [ticket, voice] = await Promise.all([ticketOf(token, row), voiceOf(token, row)]);
        const out = present(row, ticket);
        if (out) {
            out.voice_muted = !!(voice && voice.muted);
            out.mode = (voice && voice.mode) || out.mode;
        }
        return out;
    }

    // ── CORS: this one part of the API answers every site's Dock ──
    r.use('/me/agent-view', (req, res, next) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'no-store');
        if (req.method === 'OPTIONS') {
            res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.set('Access-Control-Allow-Headers', CORS_HEADERS);
            res.set('Access-Control-Max-Age', '600');
            return res.status(204).end();
        }
        return next();
    });

    r.get('/me/agent-view', actorLimits.reads('codes.read'), async (req, res) => {
        if (!signedIn(req)) return problem(req, res, 401, 'auth.required', 'sign in to see your agent');
        try {
            const agent = await sso.asViewer(req, res, (token) => viewOf(token));
            return res.json({ agent });
        } catch (e) {
            if (e && e.status === 401) return problem(req, res, 401, 'auth.required', 'sign in to see your agent');
            log.warn(`[Codes] agent view: ${String(e && e.message).slice(0, 200)}`);
            return problem(req, res, 502, 'agent_view.unavailable', 'OpenVibe.Live did not answer. Try again in a moment.');
        }
    });

    // The last frame: Live serves it to the owner only, so Codes asks with their token and passes the picture on.
    r.get('/me/agent-view/frame', actorLimits.reads('codes.read'), async (req, res) => {
        if (!signedIn(req)) return problem(req, res, 401, 'auth.required', 'sign in to see your agent');
        let frame = null;
        try {
            frame = await sso.asViewer(req, res, async (token) => {
                const row = await streamOf(token);
                if (!row || !row.last_frame_url) return null;
                // Built here from the stream's id and our own Live base: Codes never fetches an address Live names.
                const out = await fetchImpl(`${liveBase()}/api/streams/agent/${encodeURIComponent(row.id)}/frame`, {
                    headers: { authorization: `Bearer ${token}`, accept: 'image/jpeg, image/webp' }, signal: AbortSignal.timeout(8000),
                });
                if (!out.ok) return null;
                const type = String(out.headers.get('content-type') || '');
                if (!/^image\/(jpeg|webp)$/.test(type)) return null;
                return { type, bytes: Buffer.from(await out.arrayBuffer()) };
            });
        } catch (e) {
            if (e && e.status === 401) return problem(req, res, 401, 'auth.required', 'sign in to see your agent');
            frame = null;
        }
        if (!frame) return problem(req, res, 404, 'agent_view.no_frame', 'There is no still of your agent yet');
        res.set('Content-Type', frame.type).set('Cache-Control', 'private, max-age=10').send(frame.bytes);
        return undefined;
    });

    // Curtain now (the owner's own button: Live lifts it only from the desk, or from here while it is up) and End.
    const control = (name, run) => async (req, res) => {
        if (!signedIn(req)) return problem(req, res, 401, 'auth.required', `sign in to ${name} your agent stream`);
        try {
            const agent = await sso.asViewer(req, res, (token) => run(token));
            return res.json({ agent });
        } catch (e) {
            if (e && e.status === 401) return problem(req, res, 401, 'auth.required', `sign in to ${name} your agent stream`);
            log.warn(`[Codes] agent view ${name}: ${String(e && e.message).slice(0, 200)}`);
            return problem(req, res, 502, 'agent_view.unavailable', 'OpenVibe.Live did not answer. Try again in a moment.');
        }
    };

    // The answer is the view read again, so the Dock paints the curtain Live now reports and, after End, the still.
    const act = (path, body) => async (token) => {
        const row = await streamOf(token);
        if (!row) return null;
        const res = await live(token, `/api/streams/agent/${encodeURIComponent(row.id)}${path}`, { method: 'POST', body: JSON.stringify(body) });
        if (!res.ok) throw Object.assign(new Error(`OpenVibe.Live answered ${res.status} for ${path}`), { status: 502, code: 'agent_view.unavailable' });
        return viewOf(token);
    };

    // S5: pause/resume and mute/unmute. The Dock says which way, so two quick presses cannot race the state.
    const actControl = (name, bodyOf) => async (req) => {
        const token = req.ov && req.ov.token;
        const row = await streamOf(token);
        if (!row) return null;
        const out = await live(token, `/api/streams/agent/${encodeURIComponent(row.id)}/control`, { method: 'POST', body: JSON.stringify(bodyOf(req)) });
        if (!out.ok) throw Object.assign(new Error(`OpenVibe.Live answered ${out.status} for ${name}`), { status: 502, code: 'agent_view.unavailable' });
        return viewOf(token);
    };
    const controlWithBody = (name, run) => async (req, res) => {
        if (!signedIn(req)) return problem(req, res, 401, 'auth.required', `sign in to ${name} your agent stream`);
        try {
            const agent = await sso.asViewer(req, res, (token) => { req.ov = { token }; return run(req); });
            return res.json({ agent });
        } catch (e) {
            if (e && e.status === 401) return problem(req, res, 401, 'auth.required', `sign in to ${name} your agent stream`);
            log.warn(`[Codes] agent view ${name}: ${String(e && e.message).slice(0, 200)}`);
            return problem(req, res, 502, 'agent_view.unavailable', 'OpenVibe.Live did not answer. Try again in a moment.');
        }
    };

    r.post('/me/agent-view/pause', actorLimits.budget('codes.agent_view.control'), json, controlWithBody('pause', actControl('pause', (req) => ({ control: 'pause', paused: !!(req.body && req.body.paused) }))));
    r.post('/me/agent-view/curtain', actorLimits.budget('codes.agent_view.control'), json, control('curtain', act('/curtain', { up: true, reason: 'manual' })));
    r.post('/me/agent-view/mute', actorLimits.budget('codes.agent_view.control'), json, controlWithBody('mute', actControl('mute', (req) => ({ control: 'mute', muted: !!(req.body && req.body.muted) }))));
    r.post('/me/agent-view/end', actorLimits.budget('codes.agent_view.control'), json, control('end', act('/end', {})));

    return r;
}

module.exports = { createAgentView };
