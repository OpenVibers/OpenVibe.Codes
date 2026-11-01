'use strict';
/**
 * OpenVibe Git in Codes (/git): link your account on git.openvibe.codes, make a repository there in your own name, and
 * start working on it in one press. The owner, 2026-11-01: "make a repository… through your OpenVibe account on our
 * actual Git… ours is the official." The forge's sign-in is OpenVibe's, so linking is one consent (server/domain/forge.js).
 *
 *   GET  /git            what is linked, a new-repository form and your repositories (each one: "Work on it")
 *   GET  /git/connect    to the forge's consent page (state and the PKCE verifier in a short cookie on /git)
 *   GET  /git/callback   back from the forge: the code exchanged, the account linked
 *   POST /git/repos      a new repository in your name, then a new chat on it
 *   POST /git/unlink     forget the link (the forge's own settings revoke the app's access too)
 *
 * Every page is the person's own (signed in), every form a same-origin post; no token ever reaches a page.
 */
const crypto = require('crypto');
const express = require('express');
const { esc } = require('../render/html');
const { asyncRouter } = require('./router');

const STATE_COOKIE = 'codes_forge_oauth';

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
    const cookieOpts = () => ({ httpOnly: true, sameSite: 'lax', secure: config.cookies && config.cookies.secure !== false, path: '/git', maxAge: 10 * 60 * 1000 });

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
            return page(req, res, `${head}${flash(req)}<section class="c4-card"><div class="c4-card-head"><h2>Linking opens soon</h2></div>
<p class="c4-sub">You can already browse and clone every public repository at <a href="${esc(forge ? forge.publicUrl : 'https://git.openvibe.codes')}/">git.openvibe.codes</a>, and sign in there with OpenVibe. Making repositories from Codes opens when OpenVibe Git trusts Codes as an app.</p></section>`);
        }
        const link = await forge.link(req.viewer.subject);
        if (!link) {
            return page(req, res, `${head}${flash(req)}<section class="c4-card"><div class="c4-card-head"><h2>Link your OpenVibe Git account</h2></div>
<p class="c4-sub">One press: OpenVibe Git asks you to allow Codes, and you come straight back. Codes can then make repositories in your name, and your own computer can clone and push them, private ones too. You can unlink here, or revoke Codes in OpenVibe Git’s settings, at any time.</p>
<p><a class="c4-button" href="/git/connect">Link OpenVibe Git</a></p></section>`);
        }
        const mine = await forge.repos(req.viewer.subject);
        const list = mine.length
            ? `<ul class="c4-rows">${mine.map((x) => `<li class="c4-row c4-row-flat"><span class="c4-row-label"><a href="${esc(x.html_url)}" rel="noopener">${esc(x.full_name)}</a></span><span class="c4-row-note">${x.private ? 'Private' : 'Public'}${x.description ? ` · ${esc(x.description.slice(0, 120))}` : ''}</span><a class="c4-opill" href="/?mode=code&amp;repo=${encodeURIComponent(x.html_url)}">Work on it</a></li>`).join('')}</ul>`
            : '<p class="c4-emptyline">No repositories yet. Make your first one above.</p>';
        return page(req, res, `${head}${flash(req)}
<section class="c4-card"><div class="c4-card-head"><h2>A new repository</h2></div>
<p class="c4-sub">It starts with a README on <code class="c4-code-inline">main</code>, in your name (${esc(link.forge_user)}), and opens straight in a new chat.</p>
<form class="c4-form" method="post" action="/git/repos">
<p><label for="git-name">Name</label><br><input id="git-name" name="name" required maxlength="100" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,99}" autocomplete="off" spellcheck="false" placeholder="my-first-site"></p>
<p><label for="git-desc">What it is <small class="c4-muted">(optional)</small></label><br><input id="git-desc" name="description" maxlength="255" placeholder="A site for my bakery"></p>
<p><label class="c4-check"><input type="checkbox" name="private" value="1"> Private: only you can see it</label></p>
<p><button class="c4-button" type="submit">Make it and start</button></p>
</form></section>
<section class="c4-card"><div class="c4-card-head"><h2>Your repositories</h2><a href="${esc(forge.publicUrl)}/${encodeURIComponent(link.forge_user)}" rel="noopener">On OpenVibe Git</a></div>${list}</section>
<section class="c4-card"><div class="c4-card-head"><h2>The link</h2></div><p class="c4-sub">Linked as <b>${esc(link.forge_user)}</b>.</p>
<form method="post" action="/git/unlink"><button class="c4-button c4-button-light" type="submit">Unlink</button></form></section>`);
    });

    r.get('/git/connect', (req, res, next) => {
        if (!viewer(req)) return signIn(req, res);
        if (!forge || !forge.enabled) return next();
        const state = crypto.randomBytes(18).toString('base64url');
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        res.cookie(STATE_COOKIE, `${state}.${verifier}`, cookieOpts());
        return res.redirect(303, forge.authorizeUrl({ state, challenge }));
    });

    r.get('/git/callback', async (req, res, next) => {
        if (!viewer(req)) return signIn(req, res);
        if (!forge || !forge.enabled) return next();
        const kept = String((req.cookies && req.cookies[STATE_COOKIE]) || '');
        res.clearCookie(STATE_COOKIE, { path: '/git' });
        const [state, verifier] = kept.split('.');
        if (req.query.error) return back(res, 'error', 'OpenVibe Git was not linked: you said no there, or it refused.');
        if (!state || !verifier || String(req.query.state || '') !== state) return back(res, 'error', 'That link attempt expired or did not start here. Press Link again.');
        try {
            const out = await forge.connect(req.viewer.subject, { code: String(req.query.code || ''), verifier });
            return back(res, 'ok', `Linked as ${out.forge_user}.`);
        } catch (e) {
            return back(res, 'error', e && e.status && e.status < 500 ? e.message : 'OpenVibe Git did not finish linking. Try again in a minute.');
        }
    });

    r.post('/git/repos', form, async (req, res) => {
        if (!viewer(req)) return signIn(req, res);
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        if (!forge || !forge.enabled) return back(res, 'error', 'Linking OpenVibe Git is not open yet.');
        const b = req.body || {};
        try {
            const made = await forge.createRepo(req.viewer.subject, { name: b.name, description: b.description, isPrivate: b.private === '1' });
            return res.redirect(303, `/?mode=code&repo=${encodeURIComponent(made.html_url)}`);
        } catch (e) {
            return back(res, 'error', e && e.status && e.status < 500 ? e.message : 'OpenVibe Git did not make the repository. Try again in a minute.');
        }
    });

    r.post('/git/unlink', form, async (req, res) => {
        if (!viewer(req)) return signIn(req, res);
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        if (forge) await forge.unlink(req.viewer.subject);
        return back(res, 'ok', 'Unlinked. To take back Codes’ access on OpenVibe Git too, remove it under Settings → Applications there.');
    });

    return r;
}

module.exports = { createGitRoutes, STATE_COOKIE };
