'use strict';

/**
 * OpenVibe Git (Forgejo) client for the server side (plan 2026-10-28 §6, decision 7):
 * branches, pull requests, reviews and webhooks on the OpenVibe forge. The internal address is read from
 * config.git.internalUrl; Forgejo listens on 127.0.0.1:5060, a port the Fetch standard blocks, so this client uses
 * node:http / node:https. A caller without a token gets `forgejo.unconfigured`; a 4xx/5xx becomes a plain Error with
 * the Forgejo message and a `status` property.
 *
 *   createForgejoClient({ config, fetchImpl?, log? })
 *     getRepo(owner, name)
 *     listBranches(owner, name)
 *     createBranch(owner, name, { base_branch, new_branch_name })
 *     listPullRequests(owner, name, { state })
 *     createPullRequest(owner, name, { base, head, title, body })
 *     getPullRequest(owner, name, index)
 *     listReviews(owner, name, index)
 *     createWebhook(owner, name, { type, config, events })
 *     deleteWebhook(owner, name, id)
 */

const http = require('http');
const https = require('https');

function slug(s) {
    return String(s || '').replace(/^\/+|\/+$/g, '');
}

function requestJson(base, token, method, path, body, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(`${base.replace(/\/+$/, '')}/${slug(path)}`);
        const lib = u.protocol === 'https:' ? https : http;
        const payload = body == null ? null : JSON.stringify(body);
        const req = lib.request(u, {
            method,
            headers: {
                Accept: 'application/json',
                ...(token ? { Authorization: `token ${token}` } : {}),
                ...(payload ? { 'Content-Type': 'application/json' } : {}),
            },
            timeout: timeoutMs,
        }, (res) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { raw += c; if (raw.length > 4_000_000) req.destroy(new Error('response too large')); });
            res.on('end', () => {
                let parsed = null;
                if (raw.trim()) {
                    try { parsed = JSON.parse(raw); } catch (e) { parsed = { message: raw.slice(0, 500) }; }
                }
                if (res.statusCode >= 400) {
                    const err = new Error(parsed && parsed.message ? String(parsed.message) : `Forgejo ${res.statusCode}`);
                    err.status = res.statusCode;
                    err.body = parsed;
                    return reject(err);
                }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function createForgejoClient({ config, log = console }) {
    const base = String((config && config.git && config.git.internalUrl) || 'http://127.0.0.1:5060').replace(/\/+$/, '');
    const publicUrl = String((config && config.git && config.git.publicUrl) || 'https://git.openvibe.codes').replace(/\/+$/, '');
    const token = (process.env.CODES_GIT_TOKEN || process.env.FORGEJO_TOKEN || '').trim();

    function configured() {
        if (!token) return { ok: false, code: 'forgejo.unconfigured', detail: 'CODES_GIT_TOKEN is not set' };
        return { ok: true };
    }

    function call(method, path, body) {
        const check = configured();
        if (!check.ok) {
            const err = new Error(check.detail);
            err.code = check.code;
            err.status = 503;
            return Promise.reject(err);
        }
        return requestJson(base, token, method, `api/v1/${path}`, body);
    }

    const repoPath = (owner, name) => `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

    return {
        baseUrl: base,
        publicUrl,
        configured,
        async getRepo(owner, name) {
            const { body } = await call('GET', `${repoPath(owner, name)}`);
            return body;
        },
        async listBranches(owner, name) {
            const { body } = await call('GET', `${repoPath(owner, name)}/branches`);
            return Array.isArray(body) ? body : [];
        },
        async createBranch(owner, name, { base_branch, new_branch_name }) {
            const { body } = await call('POST', `${repoPath(owner, name)}/branches`, { base_branch, new_branch_name });
            return body;
        },
        async listPullRequests(owner, name, { state = 'open' } = {}) {
            const { body } = await call('GET', `${repoPath(owner, name)}/pulls?state=${encodeURIComponent(state)}`);
            return Array.isArray(body) ? body : [];
        },
        async createPullRequest(owner, name, { base, head, title, body: prBody }) {
            const { body } = await call('POST', `${repoPath(owner, name)}/pulls`, { base, head, title, body: prBody });
            return body;
        },
        async getPullRequest(owner, name, index) {
            const { body } = await call('GET', `${repoPath(owner, name)}/pulls/${encodeURIComponent(index)}`);
            return body;
        },
        async listReviews(owner, name, index) {
            const { body } = await call('GET', `${repoPath(owner, name)}/pulls/${encodeURIComponent(index)}/reviews`);
            return Array.isArray(body) ? body : [];
        },
        async createWebhook(owner, name, { type = 'forgejo', config, events = ['push', 'pull_request'] }) {
            const { body } = await call('POST', `${repoPath(owner, name)}/hooks`, { type, config, events });
            return body;
        },
        async deleteWebhook(owner, name, id) {
            const { body } = await call('DELETE', `${repoPath(owner, name)}/hooks/${encodeURIComponent(id)}`);
            return body;
        },
    };
}

module.exports = { createForgejoClient, requestJson };
