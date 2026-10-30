'use strict';

/**
 * Page shell. Every page is server-rendered through openvibe-shared/shell and is complete without JavaScript:
 *   - <head>: title, description, canonical, robots (pages are noindex unless they say otherwise), Open Graph/Twitter,
 *     JSON-LD (openvibe-shared/seo), plus Codes' extras: the shared app icon, stylesheets, the boost marker
 *   - the OpenVibe Frame: theme-loader, web-runtime, navbar and footer scripts (the shell boots the
 *     navbar; the footer is initialised below), a <noscript> navigation bar and the server-rendered footer
 *   - Codes' own script only where a page offers an optional in-browser convenience (copy buttons)
 */
const crypto = require('crypto');
const ovServe = require('openvibe-shared/serve');
const fs = require('fs');
const path = require('path');
const appIcon = require('openvibe-shared/app-icon');
const frame = require('openvibe-shared/frame');
const shell = require('openvibe-shared/shell');
const cache = require('openvibe-shared/cache-policy');
const { html, raw, esc } = require('./html');

const NETWORK_URL = 'https://openvibe.network';
const SITE_NAME = 'OpenVibe.Codes';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
// The product's own places: the main ones carry an icon (phones get them as the bottom tab bar), the rest fold into
// the navbar's More (Shared 4.22). Search is the navbar's magnifier and What shipped is the footer's.
const NAV = [
    { label: 'Get started', href: '/start', icon: 'fa-play' },
    { label: 'Run on your machine', href: '/run', icon: 'fa-microchip' },
    { label: 'Agents', href: '/harnesses', icon: 'fa-robot' },
    { label: 'Improve OpenVibe', href: '/improve', icon: 'fa-code', more: true },
    { label: 'Community', href: '/policy', icon: 'fa-people-group', more: true },
];

// The workspace's own sections (Codes C4c). The shared Frame owns the page's navigation (openvibe.design/patterns/
// single-navbar), so on the workspace pages the Frame navbar's links ARE these sections and the page carries no
// sidebar of its own. The product's own places (Get started, Run on your machine) move into More for a signed-in
// person, so a workspace page has one navigation and not two.
const WORKSPACE_NAV = [
    { label: 'Home', href: '/', icon: 'fa-house' },
    { label: 'Tasks', href: '/tasks', icon: 'fa-list' },
    { label: 'Conductor', href: '/conductor', icon: 'fa-diagram-project' },
    { label: 'Agents', href: '/agents', icon: 'fa-robot' },
    { label: 'Machines', href: '/machines', icon: 'fa-display' },
    { label: 'Usage', href: '/usage', icon: 'fa-chart-line' },
    { label: 'Settings', href: '/settings', icon: 'fa-gear' },
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

// The deployed release (app.js sets it from openvibe-shared/release): openvibe-shared/boost swaps a page in place only
// between pages of the same release, and does a normal load across a deploy.
let RELEASE = 'dev';
function setRelease(id) { if (id) RELEASE = String(id); }

/**
 * o: title, description, body (html), viewer, config, path, index (default false), scripts [rel], sharedScripts [openvibe-shared file names],
 *    crumbs [{ label, href }], jsonLd [nodes] (serialised by openvibe-shared/seo), styles [openvibe-shared stylesheet names],
 *    css [this site's own extra stylesheets, rel to public/, for the pages that need them]
 */
function renderPage(o) {
    const viewer = o.viewer || { kind: 'anonymous' };
    const signedIn = viewer.kind === 'user';
    const pathNow = o.path || '/';
    // The workspace pages share the compact Frame: no second app bar under the Frame's own (a query must not change it).
    const pathOnly = pathNow.split('?')[0];
    const c4Workspace = pathOnly === '/' || /^\/(tasks|conductor|approvals|agents|machines|usage|settings)(\/|$)/.test(pathOnly);
    const loginNext = encodeURIComponent(pathNow);
    const canonical = `${o.config.baseUrl}${pathNow.split('?')[0]}`;
    // One navigation per page. On the workspace pages a signed-in person's navbar carries the workspace sections, with
    // the current one active, and the product's own places fold into More; a visitor who is not signed in keeps the
    // product's links, because the sections hold the visitor's own work and a visitor has none yet.
    const here = (href) => pathOnly === href || (href !== '/' && pathOnly.startsWith(`${href}/`));
    const links = (signedIn && c4Workspace)
        ? [
            ...WORKSPACE_NAV.map((l) => ({ ...l, active: here(l.href) })),
            // The catalogue of harnesses is the product's Agents page; the workspace's own Agents page is above, so the
            // product's one is named for what it is.
            ...NAV.map((l) => ({ ...l, more: true, label: l.href === '/harnesses' ? 'Agent catalogue' : l.label })),
        ]
        : NAV.map((l) => ({ ...l, active: pathNow === l.href || pathNow.startsWith(`${l.href}/`) }));
    const nav = {
        service: 'codes',
        brandName: SITE_NAME,
        apiBase: NETWORK_URL,
        links,
        // Phones: one tab bar, the Frame's own (Shared 4.20). On a workspace page a signed-in person gets the workspace's
        // sections there — the first four (Home, Tasks, Conductor, Agents) and More, which opens the navbar's drawer with
        // the rest; the section the person is in is marked. Everyone else keeps the product's four.
        appBar: c4Workspace && signedIn ? true : [{ label: 'Home', href: '/', icon: 'fa-house' }, { label: 'Start', href: '/start', icon: 'fa-play' }, { label: 'Run', href: '/run', icon: 'fa-microchip' }, { label: 'Agents', href: '/harnesses', icon: 'fa-robot' }],
        history: { type: 'page', title: o.title || SITE_NAME },
        silentLogin: `${o.config.baseUrl}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: '/auth/login?next={path}',           // filled from the current page (boost moves between pages)
        logoutUrl: '/auth/logout?next={path}',   // Sign out in the shared navbar ends this site's session too
        notificationsRealtime: true,             // the bell hears new notifications over OpenVibe.Events (Shared 1.22.0)
    };
    // This site's own account links live in the shared navbar's account menu (the page's account
    // bar below is only for visitors without JavaScript).
    // Your projects and apps live on the developer platform (OpenVibe.Services).
    if (signedIn) nav.menu = { before: [{ label: 'Your projects', href: 'https://openvibe.services/projects', icon: 'fa-folder' }] };
    const footer = { service: 'codes', variant: signedIn && c4Workspace ? 'compact' : 'auto', path: o.path, mount: '#ov-footer', brandName: SITE_NAME, ...(signedIn && c4Workspace ? { shipped: false } : { updates: '/updates' }) };   // workspace pages use a compact frame
    const account = signedIn
        ? html`Signed in as <strong>${viewer.displayName || viewer.username || 'you'}</strong> · <a href="/auth/logout?next=${loginNext}">Sign out</a>`
        : html`<a href="/auth/login?next=${loginNext}">Sign in with OpenVibe</a>`;
    const crumbs = (o.crumbs || []).length
        ? html`<nav class="crumbs" aria-label="Breadcrumbs">${o.crumbs.map((c, i) => html`${i ? ' / ' : ''}${c.href ? html`<a href="${c.href}">${c.label}</a>` : c.label}`)}</nav>`
        : '';
    const scripts = (o.sharedScripts || []).map((name) => html`<script src="${ovServe.url(name)}" defer></script>`).concat((o.scripts || []).map((rel) => html`<script src="${asset(rel)}" defer></script>`));
    return shell.page({
        name: SITE_NAME,
        lang: 'en',
        // The workspace pages carry their own phone tab bar, so the page's bottom inset is theirs (C4c).
        bodyClass: c4Workspace ? 'ov-workspace' : '',
        title: o.title || `${SITE_NAME}: code with any agent`,
        titleSuffix: o.title ? ` · ${SITE_NAME}` : '',
        siteName: SITE_NAME,
        description: o.description || 'The open coding-agent harness: Claude Code, Codex, OpenCode, Command Code, Aider, the DeepSeek API and your own models behind one router, and the way to improve OpenVibe itself.',
        canonical,
        robots: o.index ? 'index, follow' : 'noindex, nofollow',
        // A page with a Markdown twin (o.agent) advertises it in the head and the Link header; the twin itself
        // is server/agent-pages.js.
        agentLayer: o.agent === true,
        llms: `${String(o.config.baseUrl).replace(/\/+$/, '')}/llms.txt`,
        jsonLd: (o.jsonLd || []).filter(Boolean),
        home: '/',
        navLinks: NAV,
        navbar: nav,
        footer,
        head: `<meta name="referrer" content="${o.noReferrer ? 'no-referrer' : 'strict-origin-when-cross-origin'}">
${appIcon.headTags({ site: 'codes' })}
<link rel="stylesheet" href="${asset('css/codes.css')}">
${(o.css || []).map((rel) => `<link rel="stylesheet" href="${esc(asset(rel))}">`).join('\n')}
${(o.styles || []).map((name) => `<link rel="stylesheet" href="${esc(ovServe.url(name))}">`).join('\n')}
${render(scripts)}
<meta name="ov-boost" content="codes@${esc(RELEASE)}">
<script src="${ovServe.url('boost.js')}" data-main="#main" defer></script>`,
        body: `<a class="skip" href="#main">Skip to content</a>
<div id="navbar-mount"></div>
<noscript><div class="account-bar" role="navigation" aria-label="Account">${render(account)}</div></noscript>
<main id="main" class="page">
${render(crumbs)}
${render(o.body)}
${o.path === '/' && !signedIn ? frame.shipped({ service: 'codes', title: `Recently shipped on ${SITE_NAME}` }) : ''}
</main>
<script>
window.__OV_PAGE = ${JSON.stringify({ navbar: nav, footer }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () {
  try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* the Frame is optional */ }
});
</script>`,
    });
}

function render(v) { return require('./html').render(v); }

/** Send a page; a page rendered for a signed-in person is private and never cached. */
function send(res, status, o) {
    // A page rendered for a signed-in person names them in the account bar: never shared caches.
    const personal = o.viewer && o.viewer.kind === 'user';
    if (!res.get('Cache-Control')) res.set('Cache-Control', !personal && o.cache ? o.cache : cache.htmlHeaders({ private: true }));
    res.set('Vary', 'Cookie');
    if (o.agent) {
        const site = String(o.config.baseUrl).replace(/\/+$/, '');
        res.set('Link', require('openvibe-shared/agent-layer').linkHeaderTags(`${site}${String(o.path || '/').split('?')[0]}`, `${site}/llms.txt`).header);
    }
    res.status(status).type('html').send(renderPage(o));
}

module.exports = { renderPage, send, asset, assetVersion, setRelease, SITE_NAME, NETWORK_URL, NAV, raw, html };
