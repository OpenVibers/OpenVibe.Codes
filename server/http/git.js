'use strict';
/**
 * OpenVibe Git in Codes (/git): your repositories on git.openvibe.codes, and a repository made there in your name
 * and opened in a new chat. There is nothing to link: Codes signs in with OpenVibe, holds a service token for
 * OpenVibe Git, and acts for the person already signed in (server/domain/forge.js).
 *
 *   GET  /git        your repositories and a new-repository form
 *   POST /git/repos  a new repository in your name, then a new chat on it
 *
 * Every page is the person's own (signed in), every form a same-origin post; no token ever reaches a page.
 */
const express = require('express');
const { esc } = require('../render/html');
const { asyncRouter } = require('./router');

function createGitRoutes(ctx) {
    const r = asyncRouter();
    const { config, forge } = ctx;
    const form = express.urlencoded({ extended: false, limit: '8kb' });
    const viewer = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const sameOrigin = (req) => {
        const origin = req.get('origin');
        if (!origin) return true;
        try { return new URL(origin).origin === new URL(config.baseUrl).origin; } catch { return false; }
    };
    const signIn = (req, res) => res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
    const back = (res, key, msg) => res.redirect(303, `/git?${key}=${encodeURIComponent(msg)}`);

    const wrap = (content) => `<div class="c4"><main class="c4-main">${content}</main></div>`;
    const header = (title, desc) => `<div class="c4-title"><div><h1>${esc(title)}</h1><p>${esc(desc)}</p></div></div>`;
    const flash = (req) => {
        const ok = String(req.query.ok || '').slice(0, 160);
        const error = String(req.query.error || '').slice(0, 240);
        return `${ok ? `<div class="notice c4-notice" role="status">${esc(ok)}</div>` : ''}${error ? `<div class="notice c4-notice c4-notice-bad" role="alert">${esc(error)}</div>` : ''}`;
    };
    const page = (req, res, body) => ctx.chatShell(req, res, { title: 'OpenVibe Git', body: wrap(body), css: ['css/c4.css'], here: '/git' });

    r.get('/git', async (req, res, next) => {
        if (!viewer(req)) return next();
        const head = header('OpenVibe Git', 'Your repositories on git.openvibe.codes, OpenVibe’s own code home. You sign in there with your OpenVibe account.');
        if (!forge || !forge.enabled) {
            return page(req, res, `${head}${flash(req)}<section class="c4-card"><div class="c4-card-head"><h2>OpenVibe Git is not connected yet</h2></div>
<p class="c4-sub">You can already browse and clone every public repository at <a href="${esc(forge ? forge.publicUrl : 'https://git.openvibe.codes')}/">git.openvibe.codes</a>, and sign in there with OpenVibe. Making repositories from Codes opens when Codes can reach OpenVibe Git with its service token.</p></section>`);
        }
        const who = { subject: req.viewer.subject, username: req.viewer.username || '' };
        if (!who.username) {
            return page(req, res, `${head}${flash(req)}<section class="c4-card"><div class="c4-card-head"><h2>One more step on your account</h2></div>
<p class="c4-sub">Your OpenVibe account has no username yet, so a repository has no address to live at. Choose one at <a href="https://openvibe.network/my" rel="noopener">openvibe.network/my</a>, then come back.</p></section>`);
        }
        const mine = await forge.repos(who);
        const list = mine.length
            ? `<ul class="c4-rows">${mine.map((x) => `<li class="c4-row c4-row-flat"><span class="c4-row-label"><a href="${esc(x.html_url)}" rel="noopener">${esc(x.full_name)}</a></span><span class="c4-row-note">${x.private ? 'Private' : 'Public'}${x.description ? ` · ${esc(x.description.slice(0, 120))}` : ''}</span><a class="c4-opill" href="/?mode=code&amp;repo=${encodeURIComponent(x.html_url)}">Work on it</a></li>`).join('')}</ul>`
            : '<p class="c4-emptyline">No repositories yet. Make your first one above.</p>';
        return page(req, res, `${head}${flash(req)}
<section class="c4-card"><div class="c4-card-head"><h2>A new repository</h2></div>
<p class="c4-sub">It starts with a README on <code class="c4-code-inline">main</code>, in your name (${esc(who.username)}), and opens straight in a new chat.</p>
<form class="c4-form" method="post" action="/git/repos">
<p><label for="git-name">Name</label><br><input id="git-name" name="name" required maxlength="100" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,99}" autocomplete="off" spellcheck="false" placeholder="my-first-site"></p>
<p><label for="git-desc">What it is <small class="c4-muted">(optional)</small></label><br><input id="git-desc" name="description" maxlength="500" placeholder="A site for my bakery"></p>
<p><label class="c4-check"><input type="checkbox" name="private" value="1"> Private: only you can see it</label></p>
<p><button class="c4-button" type="submit">Make it and start</button></p>
</form></section>
<section class="c4-card"><div class="c4-card-head"><h2>Your repositories</h2><a href="${esc(forge.publicUrl)}/${encodeURIComponent(who.username)}" rel="noopener">On OpenVibe Git</a></div>${list}</section>`);
    });

    r.post('/git/repos', form, async (req, res) => {
        if (!viewer(req)) return signIn(req, res);
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        if (!forge || !forge.enabled) return back(res, 'error', 'OpenVibe Git is not connected from Codes yet.');
        const b = req.body || {};
        try {
            const made = await forge.createRepo({ subject: req.viewer.subject, username: req.viewer.username || '' }, { name: b.name, description: b.description, isPrivate: b.private === '1' });
            return res.redirect(303, `/?mode=code&repo=${encodeURIComponent(made.html_url)}`);
        } catch (e) {
            return back(res, 'error', e && e.status && e.status < 500 ? e.message : 'OpenVibe Git did not make the repository. Try again in a minute.');
        }
    });

    return r;
}

module.exports = { createGitRoutes };
