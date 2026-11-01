'use strict';
/**
 * A person's OpenVibe Git (git.openvibe.codes, Forgejo), through their own account. The owner, 2026-11-01: "you should
 * be able to make a repository… link the repositories to OpenVibe OAuth… through your OpenVibe account on our actual
 * Git." The forge's sign-in is OpenVibe's, so linking is one consent: Codes is an OAuth2 application on the forge, the
 * person allows it once, and Codes keeps the tokens sealed (seal.js). Codes holds no admin key: everything it does on
 * the forge, it does as that person, and the person can unlink here or revoke it in the forge's settings.
 *
 *   createForge({ config, store, log })
 *     enabled                                   linking is configured (the application and the seal key)
 *     publicUrl, host                           where the forge is
 *     authorizeUrl({ state, challenge })        the forge's consent page (PKCE S256)
 *     connect(subject, { code, verifier })      the code exchanged, the forge login read, the tokens sealed → { forge_user }
 *     link(subject)                             → { forge_user, created_at } or null
 *     unlink(subject)
 *     createRepo(subject, { name, description, isPrivate }) → { full_name, html_url, clone_url, private }
 *     repos(subject)                            → their repositories, last changed first (up to 50)
 *     jobEnv(subject, repoUrl)                  → { OPENVIBE_GIT_CREDENTIALS } for a repository on the forge, or null
 *
 * The forge listens on 127.0.0.1:5060, a port fetch refuses (SIP), so the calls go through node:http (as home.js does).
 * No token is ever logged, returned by a route or written anywhere but codes_forge_links, sealed.
 */
const { createSeal } = require('./seal');

const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

function call(base, method, pathname, { headers = {}, json = null, form = null, timeoutMs = 8000 } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(pathname, `${String(base).replace(/\/+$/, '')}/`);
        const lib = u.protocol === 'https:' ? require('https') : require('http');
        const body = json != null ? JSON.stringify(json) : form != null ? new URLSearchParams(form).toString() : null;
        const req = lib.request(u, {
            method,
            timeout: timeoutMs,
            headers: {
                Accept: 'application/json',
                ...(json != null ? { 'Content-Type': 'application/json' } : form != null ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
                ...(body != null ? { 'Content-Length': Buffer.byteLength(body) } : {}),
                ...headers,
            },
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; if (text.length > 2_000_000) req.destroy(new Error('the forge answered too much')); });
            res.on('end', () => { let doc = null; try { doc = JSON.parse(text); } catch { doc = null; } resolve({ status: res.statusCode, doc }); });
        });
        req.on('timeout', () => req.destroy(new Error('the forge did not answer in time')));
        req.on('error', reject);
        if (body != null) req.write(body);
        req.end();
    });
}

function createForge({ config, store, log = console }) {
    const git = config.git || {};
    const publicUrl = String(git.publicUrl || 'https://git.openvibe.codes').replace(/\/+$/, '');
    const internalUrl = String(git.internalUrl || publicUrl).replace(/\/+$/, '');
    const host = (() => { try { return new URL(publicUrl).host.toLowerCase(); } catch { return ''; } })();
    const seal = createSeal(git.sealKey);
    const enabled = !!(git.clientId && git.clientSecret && seal);
    const redirectUri = `${String(config.baseUrl || '').replace(/\/+$/, '')}/git/callback`;
    const db = store.db;
    const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

    function authorizeUrl({ state, challenge }) {
        const q = new URLSearchParams({
            client_id: git.clientId, redirect_uri: redirectUri, response_type: 'code', state,
            code_challenge: challenge, code_challenge_method: 'S256', scope: 'write:repository read:user',
        });
        return `${publicUrl}/login/oauth/authorize?${q}`;
    }

    async function token(form) {
        const r = await call(internalUrl, 'POST', '/login/oauth/access_token', { form: { client_id: git.clientId, client_secret: git.clientSecret, ...form } });
        if (r.status !== 200 || !r.doc || !r.doc.access_token) throw fail(502, 'forge.token_refused', `OpenVibe Git did not hand over a token (${r.status})`);
        return r.doc;
    }
    async function save(subject, login, t) {
        const expires = Number(t.expires_in) > 0 ? new Date(Date.now() + Number(t.expires_in) * 1000) : null;
        await db.exec(
            `INSERT INTO codes_forge_links (subject, forge_user, token_sealed, refresh_sealed, expires_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (subject) DO UPDATE SET forge_user = EXCLUDED.forge_user, token_sealed = EXCLUDED.token_sealed,
                 refresh_sealed = EXCLUDED.refresh_sealed, expires_at = EXCLUDED.expires_at, updated_at = now()`,
            [subject, login, seal.close(t.access_token, subject), t.refresh_token ? seal.close(t.refresh_token, subject) : null, expires],
        );
    }

    async function connect(subject, { code, verifier }) {
        if (!enabled) throw fail(503, 'forge.off', 'Linking OpenVibe Git is not open yet');
        if (!USER.test(String(subject || ''))) throw fail(400, 'subject.required', 'a person signs in first');
        const t = await token({ grant_type: 'authorization_code', code: String(code || ''), code_verifier: String(verifier || ''), redirect_uri: redirectUri });
        const me = await call(internalUrl, 'GET', '/api/v1/user', { headers: { Authorization: `Bearer ${t.access_token}` } });
        const login = me.doc && me.doc.login;
        if (me.status !== 200 || !LOGIN.test(String(login || ''))) throw fail(502, 'forge.user_unknown', 'OpenVibe Git did not say who you are there');
        await save(subject, login, t);
        return { forge_user: login };
    }

    async function link(subject) {
        const row = await db.maybe('SELECT forge_user, created_at FROM codes_forge_links WHERE subject = $1', [subject]);
        return row ? { forge_user: row.forge_user, created_at: row.created_at } : null;
    }
    async function unlink(subject) { await db.exec('DELETE FROM codes_forge_links WHERE subject = $1', [subject]); }

    /** A live access token for the person: refreshed when it ends within `margin` ms. null when unlinked or refused. */
    async function tokenFor(subject, margin = 60_000) {
        if (!enabled) return null;
        const row = await db.maybe('SELECT forge_user, token_sealed, refresh_sealed, expires_at FROM codes_forge_links WHERE subject = $1', [subject]);
        if (!row) return null;
        const ends = row.expires_at ? new Date(row.expires_at).getTime() : Infinity;
        if (ends - Date.now() > margin) { const t = seal.open(row.token_sealed, subject); return t ? { token: t, login: row.forge_user } : null; }
        const refresh = row.refresh_sealed ? seal.open(row.refresh_sealed, subject) : null;
        if (!refresh) return null;
        try {
            const t = await token({ grant_type: 'refresh_token', refresh_token: refresh });
            await save(subject, row.forge_user, t);
            return { token: t.access_token, login: row.forge_user };
        } catch (e) {
            log.warn(`[Codes] OpenVibe Git refused a refresh for a linked account: ${String(e && e.message).slice(0, 120)}`);
            return null;
        }
    }

    async function createRepo(subject, { name, description = '', isPrivate = false }) {
        const n = String(name || '').trim();
        if (!REPO_NAME.test(n) || /\.git$/i.test(n)) throw fail(422, 'forge.name_invalid', 'A name is letters, digits, dots, dashes or underscores (up to 100), and not ending in .git');
        const t = await tokenFor(subject);
        if (!t) throw fail(409, 'forge.unlinked', 'Link your OpenVibe Git account first');
        const r = await call(internalUrl, 'POST', '/api/v1/user/repos', {
            headers: { Authorization: `Bearer ${t.token}` },
            json: { name: n, description: String(description || '').slice(0, 255), private: !!isPrivate, auto_init: true, default_branch: 'main', readme: 'Default' },
        });
        if (r.status === 409) throw fail(409, 'forge.name_taken', `You already have a repository called ${n}`);
        if (r.status !== 201 || !r.doc) throw fail(502, 'forge.create_failed', `OpenVibe Git did not make the repository (${r.status})`);
        return { full_name: r.doc.full_name, html_url: r.doc.html_url, clone_url: r.doc.clone_url, private: !!r.doc.private };
    }

    async function repos(subject) {
        const t = await tokenFor(subject);
        if (!t) return [];
        const r = await call(internalUrl, 'GET', '/api/v1/user/repos?limit=50', { headers: { Authorization: `Bearer ${t.token}` } }).catch(() => null);
        if (!r || r.status !== 200 || !Array.isArray(r.doc)) return [];
        return r.doc.map((x) => ({ full_name: x.full_name, html_url: x.html_url, private: !!x.private, updated_at: x.updated_at || null, description: x.description || '' }))
            .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    }

    /**
     * What a job on the person's machine needs for a repository on the forge: one credential line for the forge's host
     * (harness/job.js gitAuthFor), so a private repository clones and the branch pushes. The token lives at least an
     * hour from now (a job's cap), and it goes to git only: the job keeps it out of the agent's environment.
     */
    async function jobEnv(subject, repoUrl) {
        let u;
        try { u = new URL(String(repoUrl || '')); } catch { return null; }
        if (u.protocol !== 'https:' || u.host.toLowerCase() !== host) return null;
        const t = await tokenFor(subject, 65 * 60_000).catch(() => null);
        if (!t) return null;
        return { OPENVIBE_GIT_CREDENTIALS: `https://${encodeURIComponent(t.login)}:${encodeURIComponent(t.token)}@${host}` };
    }

    return { enabled, publicUrl, host, authorizeUrl, connect, link, unlink, createRepo, repos, jobEnv, tokenFor };
}

module.exports = { createForge, REPO_NAME };
