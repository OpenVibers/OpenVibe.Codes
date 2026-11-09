'use strict';
/**
 * A person's OpenVibe Git (git.openvibe.codes) through Codes' service token. Codes holds a typed Network token
 * for audience openvibe.git (client credentials, git.repo.read and git.repo.write) and names the person it works for in
 * X-OV-Subject; OpenVibe.Git makes the repository in their name and mints their clone token. Codes never holds a
 * person's password and never asks them to link an account: the OpenVibe sign-in in Codes is the only one.
 *
 *   createForge({ config, fetchImpl, log })
 *     enabled                                   Codes has its Network client (a service token can be had)
 *     publicUrl, host                           where OpenVibe Git is
 *     repo(owner, name)                         → one repository (default_branch, …) or null
 *     createRepo({ subject, username }, { name, description, isPrivate }) → { full_name, html_url, clone_url, private }
 *     repos({ subject, username })              → their repositories, last changed first (up to 50)
 *     jobEnv(subject, repoUrl)                  → { OPENVIBE_GIT_CREDENTIALS, OPENVIBE_GIT_LOCAL_ROOT? } or null
 *
 * The loopback address is config.git.internalUrl (the default port is OpenVibe.Git's 5270), so no call leaves the
 * host. The service token is cached by the SDK's client until a minute before it ends; no token is ever logged or
 * returned by a route.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

function createForge({ config, fetchImpl = globalThis.fetch, log = console }) {
    const git = config.git || {};
    const publicUrl = String(git.publicUrl || 'https://git.openvibe.codes').replace(/\/+$/, '');
    const internalUrl = String(git.internalUrl || publicUrl).replace(/\/+$/, '');
    const dataDir = String(git.dataDir || '').replace(/\/+$/, '');
    const host = (() => { try { return new URL(publicUrl).host.toLowerCase(); } catch { return ''; } })();
    // At use time: Codes' Network client may be set in the admin panel after boot (codes.accounts forge.* is gone;
    // the service's own OAuth client, codes, is what a service token is minted with).
    const tokens = (config.oauth && config.oauth.clientId && config.oauth.clientSecret)
        ? createServiceTokenClient({
            tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId,
            clientSecret: config.oauth.clientSecret, audience: 'openvibe.git', scope: 'git.repo.read git.repo.write', fetch: fetchImpl,
        })
        : null;
    const isEnabled = () => !!tokens;
    const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

    /** One call to OpenVibe.Git's API, as Codes; `subject` is the person it acts for. */
    async function call(method, pathname, { subject = null, json = null, auth = true, timeoutMs = 8000 } = {}) {
        const headers = { Accept: 'application/json' };
        if (auth) headers.Authorization = `Bearer ${await tokens.getToken()}`;
        if (subject) headers['X-OV-Subject'] = subject;
        if (json != null) headers['Content-Type'] = 'application/json';
        let res;
        try {
            res = await fetchImpl(`${internalUrl}${pathname}`, {
                method, headers, ...(json != null ? { body: JSON.stringify(json) } : {}),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (e) {
            throw fail(503, 'git.unreachable', `OpenVibe Git did not answer: ${e.message}`);
        }
        const text = await res.text().catch(() => '');
        let doc = null;
        try { doc = text ? JSON.parse(text) : null; } catch { doc = null; }
        return { status: res.status, doc };
    }

    async function repo(owner, name) {
        if (!isEnabled()) return null;
        const r = await call('GET', `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, { auth: false }).catch(() => null);
        return r && r.status === 200 ? r.doc : null;
    }

    async function createRepo(actor, { name, description = '', isPrivate = false } = {}) {
        const n = String(name || '').trim().toLowerCase();
        if (!REPO_NAME.test(n) || /\.git$/i.test(n)) throw fail(422, 'git.name_invalid', 'A name is letters, digits, dots, dashes or underscores (up to 100), and not ending in .git');
        if (!isEnabled()) throw fail(503, 'git.off', 'OpenVibe Git is not open from Codes yet');
        if (!USER.test(String(actor && actor.subject || ''))) throw fail(400, 'subject.required', 'a person signs in first');
        if (!LOGIN.test(String(actor.username || ''))) throw fail(409, 'git.unlinked', 'Your OpenVibe account has no username Codes can make a repository under yet');
        const r = await call('POST', '/api/v1/repos', {
            subject: actor.subject,
            json: {
                name: n, owner_username: actor.username, description: String(description || '').slice(0, 500),
                visibility: isPrivate ? 'private' : 'public', starter: 'empty',
            },
        });
        if (r.status === 409) throw fail(409, 'git.name_taken', r.doc && r.doc.detail && /username/.test(r.doc.detail) ? r.doc.detail : `You already have a repository called ${n}`);
        if (r.status !== 201 || !r.doc) throw fail(502, 'git.create_failed', `OpenVibe Git did not make the repository (${r.status})`);
        return { full_name: r.doc.full_name, html_url: r.doc.html_url, clone_url: r.doc.clone_url, private: r.doc.visibility === 'private' };
    }

    async function repos(actor) {
        if (!isEnabled() || !USER.test(String(actor && actor.subject || ''))) return [];
        if (!LOGIN.test(String(actor.username || ''))) return [];
        const r = await call('GET', `/api/v1/profile/${encodeURIComponent(actor.username.toLowerCase())}`, { subject: actor.subject }).catch(() => null);
        if (!r || r.status !== 200 || !r.doc || !Array.isArray(r.doc.repositories)) return [];
        return r.doc.repositories.map((x) => ({
            full_name: x.full_name, html_url: x.html_url, private: x.visibility === 'private',
            updated_at: x.pushed_at || x.updated_at || null, description: x.description || '',
        })).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    }

    /** A Git token for the person's session, minted by the service and good for two hours. */
    async function mintToken(subject) {
        if (!USER.test(String(subject || ''))) throw fail(400, 'subject.required', 'a person signs in first');
        const r = await call('POST', '/api/v1/tokens', { subject, json: { scopes: ['git.repo.read', 'git.repo.write'], hours: 2, label: 'Codes session' } });
        if (r.status !== 201 || !r.doc || !r.doc.token) throw fail(502, 'git.token_refused', `OpenVibe Git did not hand over a token (${r.status})`);
        return r.doc.token;
    }

    /** The bare repository on this host, when Codes and OpenVibe Git share the disk (G3: no network clone). */
    function localRoot(repoUrl) {
        if (!dataDir) return null;
        let u;
        try { u = new URL(String(repoUrl || '')); } catch { return null; }
        if (u.protocol !== 'https:' || u.host.toLowerCase() !== host) return null;
        const parts = u.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
        if (parts.length !== 2 || !LOGIN.test(parts[0]) || !REPO_NAME.test(parts[1])) return null;
        const bare = path.join(dataDir, 'repos', parts[0], `${parts[1]}.git`);
        try { return fs.statSync(bare).isDirectory() ? dataDir : null; } catch { return null; }
    }

    /**
     * What a job on the person's machine needs for a repository on OpenVibe Git: one credential line for its host
     * (harness/job.js gitAuthFor), so a private repository clones and the branch pushes. The token lives two hours.
     * When Codes and OpenVibe Git share their disk, the job also learns where the bare repositories are: it clones
     * from the local disk and pushes over HTTPS as usual.
     */
    async function jobEnv(subject, repoUrl) {
        let u;
        try { u = new URL(String(repoUrl || '')); } catch { return null; }
        if (u.protocol !== 'https:' || u.host.toLowerCase() !== host) return null;
        let token;
        try { token = await mintToken(subject); } catch (e) {
            log.warn(`[Codes] no OpenVibe Git token for a session: ${String(e && e.message).slice(0, 120)}`);
            return null;
        }
        const root = localRoot(repoUrl);
        return {
            OPENVIBE_GIT_CREDENTIALS: `https://x-access-token:${encodeURIComponent(token)}@${host}`,
            ...(root ? { OPENVIBE_GIT_LOCAL_ROOT: root } : {}),
        };
    }

    return { get enabled() { return isEnabled(); }, publicUrl, host, repo, createRepo, repos, mintToken, jobEnv };
}

module.exports = { createForge, REPO_NAME };
