'use strict';

/**
 * The owner's repository sources (ask 348): where the repository field looks, in what order, how many rows each source
 * may add and how long Codes waits for it. The owner alone sees and changes them.
 *
 *   GET  /admin/repo-sources      the plain form (owner rank only; a non-owner gets 403)
 *   POST /admin/repo-sources      save it (same-origin, owner only), then back to the form
 *   GET  /api/v1/admin/repo-sources   { sources: [...] }
 *   PUT  /api/v1/admin/repo-sources   { sources: [...] } → { sources: [...] }
 *
 * The rows live in repo_picker_sources (migration 0034). The three built-ins may be switched off and moved, never
 * removed; custom sources (a name and an https URL with {q}) are added and removed here. A custom URL is fetched through
 * openvibe-shared/egress, never directly (server/domain/repo-picker.js).
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { esc } = require('../render/html');
const { asyncRouter } = require('./router');

const OWNER_ONLY = 'Repository sources are the owner\'s. Your OpenVibe account does not have the owner rank.';

function createAdminRepos(ctx) {
    const { config, repoPicker } = ctx;
    const page = asyncRouter();
    const api = asyncRouter();
    const json = express.json({ limit: '64kb' });
    const form = express.urlencoded({ extended: false, limit: '64kb' });
    const problem = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const isOwner = (req) => signedIn(req) && req.viewer.role === 'owner';
    const sameOrigin = (req) => {
        const origin = req.get('origin');
        if (!origin) return true;
        try { return new URL(origin).origin === new URL(config.baseUrl).origin; } catch { return false; }
    };
    const say = (req) => {
        const saved = String(req.query.saved || '') === '1';
        const error = String(req.query.error || '').slice(0, 300);
        return `${saved ? '<p class="notice c4-notice" role="status">Saved. The next search uses the new order.</p>' : ''}${error ? `<p class="notice c4-notice c4-notice-bad" role="alert">${esc(error)}</p>` : ''}`;
    };

    /** One row: on, its name, its place, the most rows it may add, and how long Codes may wait. */
    const rowOf = (s) => `<fieldset class="c4-card">
<input type="hidden" name="source.${esc(s.id)}.kind" value="${esc(s.kind)}">
<legend><b>${esc(s.label)}</b> <small class="c4-muted">${esc(s.kind === 'url' ? 'custom URL' : s.kind)}</small></legend>
<p><label class="c4-check"><input type="checkbox" name="source.${esc(s.id)}.enabled" value="1"${s.enabled ? ' checked' : ''}> On</label></p>
<p><label for="src-${esc(s.id)}-label">Name</label><br><input id="src-${esc(s.id)}-label" name="source.${esc(s.id)}.label" value="${esc(s.label)}" required maxlength="60"></p>
<p><label for="src-${esc(s.id)}-pos">Order <small class="c4-muted">(lowest first)</small></label><br><input id="src-${esc(s.id)}-pos" type="number" name="source.${esc(s.id)}.position" value="${esc(s.position)}" step="1"></p>
<p><label for="src-${esc(s.id)}-limit">Most rows</label><br><input id="src-${esc(s.id)}-limit" type="number" name="source.${esc(s.id)}.limit_n" value="${esc(s.limit_n)}" min="1" max="20"></p>
<p><label for="src-${esc(s.id)}-timeout">Wait, milliseconds</label><br><input id="src-${esc(s.id)}-timeout" type="number" name="source.${esc(s.id)}.timeout_ms" value="${esc(s.timeout_ms)}" min="100" max="5000" step="100"></p>
${s.kind === 'url' ? `<p><label for="src-${esc(s.id)}-url">URL with {q}</label><br><input id="src-${esc(s.id)}-url" type="url" name="source.${esc(s.id)}.url_template" value="${esc(s.url_template || '')}" required maxlength="500" placeholder="https://example.com/repos?q={q}"></p>` : ''}
</fieldset>`;

    const body = (sources, notice = '') => `<div class="c4"><main class="c4-main">
<div class="c4-title"><div><h1>Repository sources</h1><p>Where the repository field looks, in this order. A source that fails or takes longer than its wait is left out quietly.</p></div><a class="c4-opill" href="/git">OpenVibe Git</a></div>
${notice || ''}
<form method="post" action="/admin/repo-sources" class="c4-form">
<p><button class="c4-button" type="submit">Save sources</button></p>
${sources.map(rowOf).join('')}
<fieldset class="c4-card"><legend><b>Add a custom source</b></legend>
<p><label for="new-label">Name</label><br><input id="new-label" name="new.label" maxlength="60" placeholder="My code host"></p>
<p><label for="new-url">URL with {q} <small class="c4-muted">(https; {q} is the search)</small></label><br><input id="new-url" type="url" name="new.url_template" maxlength="500" placeholder="https://git.example.com/api/repos?q={q}"></p>
<p><label class="c4-check"><input type="checkbox" name="new.enabled" value="1" checked> On</label></p>
<p><label for="new-limit">Most rows</label><br><input id="new-limit" type="number" name="new.limit_n" value="8" min="1" max="20"></p>
<p><label for="new-timeout">Wait, milliseconds</label><br><input id="new-timeout" type="number" name="new.timeout_ms" value="1500" min="100" max="5000" step="100"></p>
</fieldset>
<p><button class="c4-button" type="submit">Save sources</button></p>
</form>
</main></div>`;

    function render(req, res, status, error) {
        if (status && status !== 200) res.status(status);
        const notice = error ? `<p class="notice c4-notice c4-notice-bad" role="alert">${esc(error)}</p>` : say(req);
        return ctx.chatShell(req, res, { title: 'Repository sources', body: body(req._sources || [], notice), css: ['css/c4.css'], here: '/admin/repo-sources' });
    }

    page.get('/admin/repo-sources', async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        if (!isOwner(req)) return res.status(403).type('text/plain').send(`${OWNER_ONLY}\n`);
        req._sources = await repoPicker.sources();
        return render(req, res, 200);
    });

    page.post('/admin/repo-sources', form, async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        if (!isOwner(req)) return res.status(403).type('text/plain').send(`${OWNER_ONLY}\n`);
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        const b = req.body || {};
        const ids = [...new Set(Object.keys(b).map((k) => /^source\.([A-Za-z0-9_-]+)\.kind$/.exec(k)).filter(Boolean).map((m) => m[1]))];
        const sources = ids.map((id) => ({
            id,
            kind: b[`source.${id}.kind`],
            label: b[`source.${id}.label`],
            enabled: b[`source.${id}.enabled`] === '1',
            position: Number(b[`source.${id}.position`]),
            limit_n: Number(b[`source.${id}.limit_n`]),
            timeout_ms: Number(b[`source.${id}.timeout_ms`]),
            url_template: b[`source.${id}.url_template`] || null,
        }));
        if (String(b['new.label'] || '').trim() || String(b['new.url_template'] || '').trim()) {
            sources.push({
                kind: 'url', label: b['new.label'], url_template: b['new.url_template'],
                enabled: b['new.enabled'] === '1', position: 100,
                limit_n: Number(b['new.limit_n']) || 8, timeout_ms: Number(b['new.timeout_ms']) || 1500,
            });
        }
        try {
            await repoPicker.saveSources(sources, { subject: req.viewer.subject });
            return res.redirect(303, '/admin/repo-sources?saved=1');
        } catch (e) {
            req._sources = await repoPicker.sources();
            return render(req, res, e.status || 422, String(e.message || 'That could not be saved.'));
        }
    });

    api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

    api.get('/admin/repo-sources', async (req, res) => {
        if (!signedIn(req)) return problem(req, res, 401, 'auth.required', 'sign in to see where repositories are searched');
        if (!isOwner(req)) return problem(req, res, 403, 'repo_sources.owner_only', OWNER_ONLY);
        return res.json({ sources: await repoPicker.sources() });
    });

    api.put('/admin/repo-sources', json, async (req, res) => {
        if (!signedIn(req)) return problem(req, res, 401, 'auth.required', 'sign in to choose where repositories are searched');
        if (!isOwner(req)) return problem(req, res, 403, 'repo_sources.owner_only', OWNER_ONLY);
        if (!sameOrigin(req)) return problem(req, res, 403, 'cross_site', 'cross-site posts are refused');
        try {
            const saved = await repoPicker.saveSources((req.body || {}).sources, { subject: req.viewer.subject });
            return res.json({ sources: saved });
        } catch (e) {
            return problem(req, res, Number(e && e.status) || 422, 'repo_sources.invalid', String((e && e.message) || 'that list cannot be saved'));
        }
    });

    return { page, api };
}

module.exports = { createAdminRepos, OWNER_ONLY };
