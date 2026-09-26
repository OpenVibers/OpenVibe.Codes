'use strict';

/**
 * Page shell. Every page is server-rendered through this and is complete without JavaScript:
 *   - <head>: title, description, canonical, robots (portal pages are noindex), the shared app icon
 *   - the OpenVibe Frame: navbar.js and theme-loader.js from the Network (progressive), a <noscript>
 *     navigation bar and the server-rendered shared footer (openvibe-shared)
 *   - Codes' own script only where a page offers an optional in-browser convenience (webhook
 *     signature computed locally, copy buttons); every form works without it
 */
const crypto = require('crypto');
const ovServe = require('openvibe-shared/serve');
const fs = require('fs');
const path = require('path');
const appIcon = require('openvibe-shared/app-icon');
const frame = require('openvibe-shared/frame');
const { html, raw, esc } = require('./html');

const NETWORK_URL = 'https://openvibe.network';
const SITE_NAME = 'OpenVibe.Codes';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const NAV = [
    { label: 'Projects', href: '/projects' },
    { label: 'Docs', href: '/docs' },
    { label: 'OAuth', href: '/oauth' },
    { label: 'Webhooks', href: '/tools/webhooks' },
    { label: 'Manifests', href: '/manifests/validate' },
    { label: 'Policy', href: '/policy' },
];

const hashes = new Map();
function assetVersion(rel) {
    if (hashes.has(rel)) return hashes.get(rel);
    let v = 'dev';
    try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing asset */ }
    hashes.set(rel, v);
    return v;
}
const asset = (rel) => `/${rel}?v=${assetVersion(rel)}`;

/**
 * o: title, description, body (html), viewer, config, path, index (default false), scripts [rel],
 *    crumbs [{ label, href }]
 */
function renderPage(o) {
    const viewer = o.viewer || { kind: 'anonymous' };
    const signedIn = viewer.kind === 'user';
    const pathNow = o.path || '/';
    const loginNext = encodeURIComponent(pathNow);
    const canonical = `${o.config.baseUrl}${pathNow.split('?')[0]}`;
    const nav = {
        service: 'codes',
        apiBase: NETWORK_URL,
        links: NAV.map((l) => ({ label: l.label, href: l.href, active: pathNow === l.href || pathNow.startsWith(`${l.href}/`) })),
        history: { type: 'page', title: o.title || SITE_NAME },
        silentLogin: `${o.config.baseUrl}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: `/auth/login?next=${loginNext}`,
        logoutUrl: '/auth/logout?next={path}',   // Sign out in the shared navbar ends this site's session too
        notificationsRealtime: true,             // the bell hears new notifications over OpenVibe.Events (Shared 1.22.0)
    };
    // This site's own account links live in the shared navbar's account menu (the page's account
    // bar below is only for visitors without JavaScript).
    if (signedIn) nav.menu = { before: [...(viewer.staff ? [{ label: 'Staff', href: '/staff', icon: 'fa-shield' }] : []), { label: 'Your projects', href: '/projects', icon: 'fa-folder' }] };
    const footer = { service: 'codes', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' };
    const account = signedIn
        ? html`Signed in as <strong>${viewer.displayName || viewer.username || 'you'}</strong>${viewer.staff ? html` · <a href="/staff">Staff</a>` : ''} · <a href="/projects">Your projects</a> · <a href="/auth/logout?next=${loginNext}">Sign out</a>`
        : html`<a href="/auth/login?next=${loginNext}">Sign in with OpenVibe</a> to manage projects and apps`;
    const crumbs = (o.crumbs || []).length
        ? html`<nav class="crumbs" aria-label="Breadcrumbs">${o.crumbs.map((c, i) => html`${i ? ' / ' : ''}${c.href ? html`<a href="${c.href}">${c.label}</a>` : c.label}`)}</nav>`
        : '';
    const title = o.title ? `${o.title} · ${SITE_NAME}` : `${SITE_NAME}: the OpenVibe developer portal`;
    const scripts = (o.scripts || []).map((rel) => html`<script src="${asset(rel)}" defer></script>`);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(o.description || 'Build on OpenVibe: projects, apps and scoped credentials, generated contract and SDK docs, webhook and OAuth tools, and manifest validation.')}">
<meta name="robots" content="${o.index ? 'index, follow' : 'noindex, nofollow'}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="referrer" content="${o.noReferrer ? 'no-referrer' : 'strict-origin-when-cross-origin'}">
${appIcon.headTags({ site: 'codes' })}
<link rel="stylesheet" href="${asset('css/codes.css')}">
<script src="${ovServe.url('theme-loader.js')}" defer></script>
<script src="${ovServe.url('navbar.js')}" defer></script>
<script src="${ovServe.url('footer.js')}" defer></script>
${render(scripts)}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div id="navbar-mount"></div>
${frame.noscriptNav({ name: SITE_NAME, home: '/', links: NAV })}
<noscript><div class="account-bar" role="navigation" aria-label="Account">${render(account)}</div></noscript>
<main id="main" class="page">
${render(crumbs)}
${render(o.body)}
${o.path === '/' ? frame.shipped({ service: 'codes', title: `Recently shipped on ${SITE_NAME}` }) : ''}
</main>
${frame.footer(footer)}
<script>
window.__OV_PAGE = ${JSON.stringify({ navbar: nav, footer }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () {
  try { if (window.OpenVibeNavbar) OpenVibeNavbar.init(window.__OV_PAGE.navbar); } catch (e) { /* the Frame is optional */ }
  try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* */ }
});
</script>
</body>
</html>`;
}

function render(v) { return require('./html').render(v); }

/** Send a page; portal pages are private and never cached. */
function send(res, status, o) {
    // A page rendered for a signed-in person names them in the account bar: never shared caches.
    const personal = o.viewer && o.viewer.kind === 'user';
    if (!res.get('Cache-Control')) res.set('Cache-Control', !personal && o.cache ? o.cache : 'private, no-store');
    res.set('Vary', 'Cookie');
    res.status(status).type('html').send(renderPage(o));
}

module.exports = { renderPage, send, asset, assetVersion, SITE_NAME, NETWORK_URL, NAV, raw, html };
