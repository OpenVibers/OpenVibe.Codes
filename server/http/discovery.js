'use strict';

/**
 * Crawl and machine-readability artifacts (plan T11): GET /robots.txt, GET /sitemap.xml,
 * GET /llms.txt and GET /llms-full.txt, plus the home page's JSON-LD. Every one is built with
 * openvibe-shared/seo — the same toolkit the other OpenVibe sites use — so they say the same things
 * here as everywhere.
 *
 * Public pages only, and never the viewer: the portal, staff console, sign-in and the API are absent
 * from all of them and Disallowed in robots.txt. lastmod is a real timestamp from the site's own
 * data — the committed content-revision date in STATUS.json (and each published release's publish
 * time for the pages a release changes) — never "today" from the clock, which would tell crawlers
 * the whole site changed on every fetch.
 */
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');

const SITE_NAME = 'OpenVibe.Codes';
const DESCRIPTION = 'The OpenVibe developer portal: create projects and apps in OpenVibe.Network, get scoped credentials and capability grants, and read reference documentation generated from the exact contracts and SDK versions the platform runs.';
// Every rule robots.txt had before this module existed: none of them may quietly disappear.
const DISALLOW = ['/projects', '/auth/', '/oauth/test-callback', '/staff', '/api/'];
const RELEASE_LIMIT = 5000;

// The one line /llms-full.txt says about each fixed public page: a title and what the page serves.
// These are the pages publicPages() lists (and so the sitemap), so the two cannot name different sets.
const PAGE_TEXT = {
    '/': ['OpenVibe.Codes home', 'The developer portal: create a project, get scoped credentials and request capability grants over OpenVibe.Network.'],
    '/updates': ['What shipped on OpenVibe.Codes', 'This site\'s update log, from the network changelog feed.'],
    '/docs': ['Platform reference', 'Reference generated at boot from the pinned openvibe-contracts and openvibe-sdk.'],
    '/docs/api': ['API explorer', 'Every service\'s routes from the contracts\' OpenAPI 3.1 documents.'],
    '/docs/updates': ['The update system', 'The feed, the data-ov-shipped markup and the shared helpers every OpenVibe site shows.'],
    '/docs/contracts': ['Contracts', 'The JSON Schemas with their fields, examples and versions.'],
    '/docs/capabilities': ['Capabilities', 'Every capability, which of them can be granted to apps, and its owner, visibility and status.'],
    '/docs/events': ['Event types', 'Every event type a service manifest declares it produces or consumes.'],
    '/docs/services': ['Service registry', 'The Network\'s registry as it answers, with health (never invented).'],
    '/docs/billing': ['Billing policy', 'The billing policy as OpenVibe.Billing\'s /policy.json states it.'],
    '/docs/limits': ['Limits and tiers', 'What a project may do in sandbox and production, from the services that enforce it.'],
    '/docs/tools': ['Tools API', 'The OpenVibe.Tools registry, callable from code.'],
    '/docs/harnesses': ['Coding harnesses', 'The harnesses and agents a coding task can be routed to, with their prices and limits.'],
    '/docs/export': ['Project export', 'What a project export holds: the metadata JSON and the full archive.'],
    '/docs/sdk': ['SDK reference', 'openvibe-sdk modules, from their type definitions.'],
    '/oauth': ['OAuth callback helper', 'Authorization code + PKCE, with a callback that never exchanges the code.'],
    '/tools/webhooks': ['Webhook signature tester', 'Decides as a receiver requiring signature v2 does.'],
    '/manifests/validate': ['Manifest validation', 'App and mod manifests, validated against the pinned contracts.'],
    '/policy': ['Policy', 'The portal\'s policy pages: decisions, compatibility, licensing, transparency and community.'],
    '/policy/rfc': ['Proposals and decisions', 'How a contract, capability or event changes, and the ADR record.'],
    '/policy/compatibility': ['Compatibility and deprecation', 'ADR-002 and ADR-016 as published, with the current deprecations.'],
    '/policy/licensing': ['Licensing', 'What each package Codes runs is licensed under.'],
    '/policy/transparency': ['Transparency', 'What Codes stores, what it does not, and what works today.'],
};

/** "2026-09-28" or "2026-09-28T12:00:00Z" as YYYY-MM-DD; null when the value is unusable. */
function dayOf(ts) {
    const m = String(ts == null ? '' : ts).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}

/** The committed status file's content date: the site's own revision date, never the clock. */
function siteUpdated() {
    try { return dayOf(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'STATUS.json'), 'utf8')).updated); } catch { return null; }
}

/**
 * The home page's JSON-LD: the site as a WebSite, the developer portal as the site's primary type
 * (the shared kit's WebApplication) and the page that carries them. The same nodes for every
 * crawler; nothing about the reader.
 */
function homeJsonLd(config) {
    const site = String(config.baseUrl).replace(/\/+$/, '');
    return [
        seo.jsonLd.website({ name: SITE_NAME, url: site, description: DESCRIPTION }),
        seo.jsonLd.softwareApp({ name: SITE_NAME, url: site, description: DESCRIPTION, category: 'DeveloperApplication', keywords: 'developer portal, api, oauth, webhooks, sdk, openvibe' }),
        seo.jsonLd.webPage({ name: SITE_NAME, url: `${site}/`, description: DESCRIPTION, siteUrl: site }),
    ];
}

/**
 * The site's fixed public pages, with their crawl hints. Docs and policy pages are generated from
 * the pinned contracts and SDK and from the repository's Markdown, so their lastmod is the site's
 * content-revision date; governance drafts stay out (they are noindex and not published).
 */
function publicPages({ docs, governance = [] }) {
    const pages = [
        { path: '/', changefreq: 'daily', priority: 1.0 },
        { path: '/updates', changefreq: 'daily', priority: 0.5 },
        { path: '/docs', changefreq: 'weekly', priority: 0.9 },
        { path: '/docs/api', changefreq: 'weekly', priority: 0.8 },
        { path: '/docs/updates', changefreq: 'daily', priority: 0.6 },
        { path: '/docs/contracts', changefreq: 'weekly', priority: 0.7 },
        { path: '/docs/capabilities', changefreq: 'weekly', priority: 0.7 },
        { path: '/docs/events', changefreq: 'weekly', priority: 0.6 },
        { path: '/docs/services', changefreq: 'weekly', priority: 0.6 },
        { path: '/docs/billing', changefreq: 'monthly', priority: 0.5 },
        { path: '/docs/limits', changefreq: 'monthly', priority: 0.5 },
        { path: '/docs/tools', changefreq: 'monthly', priority: 0.5 },
        { path: '/docs/harnesses', changefreq: 'weekly', priority: 0.6 },
        { path: '/docs/export', changefreq: 'monthly', priority: 0.5 },
        { path: '/docs/sdk', changefreq: 'weekly', priority: 0.7 },
        { path: '/oauth', changefreq: 'monthly', priority: 0.5 },
        { path: '/tools/webhooks', changefreq: 'monthly', priority: 0.5 },
        { path: '/manifests/validate', changefreq: 'monthly', priority: 0.5 },
        { path: '/policy', changefreq: 'monthly', priority: 0.5 },
        { path: '/policy/rfc', changefreq: 'monthly', priority: 0.4 },
        { path: '/policy/compatibility', changefreq: 'monthly', priority: 0.4 },
        { path: '/policy/licensing', changefreq: 'monthly', priority: 0.4 },
        { path: '/policy/transparency', changefreq: 'monthly', priority: 0.4 },
    ];
    for (const g of governance) if (!g.draft) pages.push({ path: `/policy/${g.slug}`, changefreq: 'monthly', priority: 0.3 });
    for (const c of docs.contracts) pages.push({ path: `/docs/contracts/${c.id}`, changefreq: 'monthly', priority: 0.4 });
    for (const c of docs.capabilities) pages.push({ path: `/docs/capabilities/${c.id}`, changefreq: 'monthly', priority: 0.4 });
    for (const x of contracts.openapi.index()) pages.push({ path: `/docs/api/${x.service}`, changefreq: 'monthly', priority: 0.4 });
    for (const m of docs.sdk) pages.push({ path: `/docs/sdk/${m.slug}`, changefreq: 'monthly', priority: 0.3 });
    for (const a of docs.adrs) pages.push({ path: `/docs/adr/${a.id}`, changefreq: 'yearly', priority: 0.3 });
    return pages;
}

/**
 * The title and one-line text /llms-full.txt gives a public page: the fixed pages from PAGE_TEXT,
 * governance pages from their own blurb, and the generated docs pages from the same data the page
 * renders. Nothing here is fetched or invented; an unknown path (there is none today) falls back to
 * the path as its title.
 */
function describePage(pathname, { docs, governance = [], apiIndex = [] }) {
    if (PAGE_TEXT[pathname]) return { title: PAGE_TEXT[pathname][0], text: PAGE_TEXT[pathname][1] };
    let m;
    if ((m = /^\/policy\/([^/]+)$/.exec(pathname))) {
        const g = governance.find((x) => x.slug === m[1]);
        if (g) return { title: g.title, text: g.blurb || '' };
    }
    if ((m = /^\/docs\/contracts\/([^/]+)$/.exec(pathname))) {
        const c = docs.contracts.find((x) => x.id === m[1]);
        if (c) return { title: c.title, text: seo.clip(c.description, 200) };
    }
    if ((m = /^\/docs\/capabilities\/([^/]+)$/.exec(pathname))) {
        const c = docs.capabilities.find((x) => x.id === m[1]);
        if (c) return { title: c.id, text: seo.clip(c.description, 200) };
    }
    if ((m = /^\/docs\/api\/([^/]+)$/.exec(pathname))) {
        const s = apiIndex.find((x) => x.service === m[1]);
        if (s) return { title: `${s.name} API`, text: `${s.operations} routes performing ${s.capabilities} capabilities.` };
    }
    if ((m = /^\/docs\/sdk\/([^/]+)$/.exec(pathname))) {
        const mod = docs.sdk.find((x) => x.slug === m[1]);
        if (mod) return { title: mod.name, text: `From ${mod.typesFile} (${mod.browser}).` };
    }
    if ((m = /^\/docs\/adr\/([^/]+)$/.exec(pathname))) {
        const a = docs.adrs.find((x) => x.id === m[1]);
        if (a) return { title: a.title, text: `Status: ${a.status}. Published in openvibe-contracts.` };
    }
    return { title: pathname, text: '' };
}

function createDiscoveryRoutes(ctx) {
    const { config, docs, releases, governance = [] } = ctx;
    const r = asyncRouter();
    const site = String(config.baseUrl).replace(/\/+$/, '');
    const abs = (p) => `${site}${p}`;

    // The public, indexable releases: what the sitemap lists and what dates the pages a release
    // changes. Never drafts, revoked or private ones (only 'published' pages are index: true).
    async function releaseIndex() {
        try { return await releases.publicIndex(RELEASE_LIMIT); } catch { return []; }
    }

    async function sitemapEntries() {
        const content = siteUpdated();
        const rows = await releaseIndex();
        const entries = publicPages({ docs, governance }).map((p) => ({ ...p, lastmod: content }));
        const newest = rows.map((x) => dayOf(x.published_at)).filter(Boolean).sort().pop() || null;
        // The home and shipped pages change when a release publishes, so they carry the newer of
        // that real publish time and the site's content date.
        for (const e of entries) if ((e.path === '/' || e.path === '/updates') && newest && (!e.lastmod || newest > e.lastmod)) e.lastmod = newest;
        const byApp = new Map();
        for (const x of rows) {
            const d = dayOf(x.published_at);
            if (d && (!byApp.has(x.app_id) || d > byApp.get(x.app_id))) byApp.set(x.app_id, d);
        }
        for (const [appId, lastmod] of byApp) entries.push({ path: `/apps/${appId}`, changefreq: 'weekly', priority: 0.4, lastmod });
        for (const x of rows.filter((x) => x.status === 'published')) entries.push({ path: `/releases/${x.id}`, changefreq: 'monthly', priority: 0.3, lastmod: dayOf(x.published_at) });
        return entries;
    }

    r.get('/robots.txt', (_req, res) => {
        // The same rules as before, plus the search and AI crawlers the shared kit names by name and
        // the sitemap. Every previous Disallow is kept (DISALLOW).
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(
            '# openvibe.codes: the public pages are for search and AI crawlers; the portal, sign-in, staff and the API are not.\n'
            + seo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: DISALLOW }));
    });

    r.get('/llms.txt', (_req, res) => {
        const firstContract = docs.contracts[0] ? docs.contracts[0].id : null;
        const firstService = (contracts.openapi.index()[0] || {}).service || null;
        const machine = [
            { title: 'Sitemap', url: abs('/sitemap.xml'), note: 'the public pages below, each with a real lastmod' },
            { title: 'robots.txt', url: abs('/robots.txt'), note: 'search and AI crawlers are welcome on the public pages' },
            { title: 'Full text for language models', url: abs('/llms-full.txt'), note: 'every fixed public page, one line each' },
            { title: 'Release metadata (JSON)', url: abs('/release.json'), note: 'this service\'s current release, per ADR-016' },
        ];
        if (firstContract) machine.push({ title: 'Contract JSON Schema', url: abs(`/docs/contracts/${firstContract}.json`), note: 'append .json to any contract page for its schema' });
        if (firstService) machine.push({ title: 'Service OpenAPI', url: abs(`/docs/api/${firstService}.json`), note: 'append .json to any API explorer page for its OpenAPI document' });
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(seo.llmsTxt({
            name: SITE_NAME,
            summary: 'OpenVibe.Codes: the OpenVibe developer portal over OpenVibe.Network\'s API — projects, apps, scoped credentials and capability grants, reference documentation generated from the pinned contracts and SDK, and OAuth, webhook and manifest tools.',
            details: 'Every page is server-rendered and readable without JavaScript, and every one is public: no account is needed to read the docs or use the OAuth, webhook and manifest tools. Projects, apps, credentials and grants belong to OpenVibe.Network; the pages that manage them need a signed-in OpenVibe account and are deliberately not listed here or in the sitemap. The reference under /docs is generated at boot from the exact openvibe-contracts and openvibe-sdk versions the platform runs, so it cannot drift from them.',
            sections: [
                { title: 'Start here', links: [
                    { title: 'The developer portal', url: abs('/'), note: 'what the portal is for and how an account becomes an integration' },
                    { title: 'Reference documentation', url: abs('/docs'), note: 'generated from the pinned contracts and SDK' },
                    { title: 'What shipped on OpenVibe.Codes', url: abs('/updates') },
                    { title: 'Transparency', url: abs('/policy/transparency'), note: 'what the portal stores, what it does not, and what works today' },
                ] },
                { title: 'Reference', links: [
                    { title: 'API explorer', url: abs('/docs/api'), note: 'each service\'s OpenAPI document, per page as .json' },
                    { title: 'Contracts', url: abs('/docs/contracts'), note: 'schemas, field tables and fixtures, per page as .json' },
                    { title: 'Capabilities', url: abs('/docs/capabilities') },
                    { title: 'Events', url: abs('/docs/events') },
                    { title: 'Services', url: abs('/docs/services') },
                    { title: 'Tools', url: abs('/docs/tools') },
                    { title: 'Coding harnesses', url: abs('/docs/harnesses'), note: 'the harness catalog and how tasks are routed' },
                    { title: 'SDK', url: abs('/docs/sdk') },
                ] },
                { title: 'Developer tools', links: [
                    { title: 'OAuth callback helper', url: abs('/oauth'), note: 'authorization code + PKCE, with a callback that never exchanges the code' },
                    { title: 'Webhook signature tester', url: abs('/tools/webhooks'), note: 'decides as a receiver requiring signature v2 does' },
                    { title: 'Manifest validation', url: abs('/manifests/validate'), note: 'app and mod manifests, validated against the pinned contracts' },
                ] },
                { title: 'Policy', links: [
                    { title: 'Policy home', url: abs('/policy') },
                    { title: 'Proposals and decisions', url: abs('/policy/rfc') },
                    { title: 'Compatibility and deprecation', url: abs('/policy/compatibility') },
                    { title: 'Licensing', url: abs('/policy/licensing') },
                    ...governance.filter((g) => !g.draft).map((g) => ({ title: g.title, url: abs(`/policy/${g.slug}`) })),
                ] },
                { title: 'Machine-readable', links: machine },
            ],
        }));
    });

    // /llms-full.txt: the same public pages the sitemap lists, one title and one line of text each,
    // so a language model sees what this origin serves without fetching every page. Never a private
    // page (the portal, sign-in, staff and the API are absent) and maxBytes caps the file.
    r.get('/llms-full.txt', (_req, res) => {
        const pages = publicPages({ docs, governance });
        const apiIndex = contracts.openapi.index();
        const isDocs = (p) => p === '/docs' || p.startsWith('/docs/');
        const tools = ['/oauth', '/tools/webhooks', '/manifests/validate'];
        const group = (pick) => pages.filter((p) => pick(p.path)).map((p) => ({ url: p.path, ...describePage(p.path, { docs, governance, apiIndex }) }));
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(seo.llmsFull({
            site: SITE_NAME,
            summary: 'Every fixed public page of OpenVibe.Codes, one line each: the home and update log, the reference generated from the pinned contracts and SDK, the developer tools, and the policy pages.',
            base: site,
            maxBytes: 512 * 1024,
            sections: [
                { title: 'Home', pages: group((p) => p === '/') },
                { title: 'Reference', pages: group(isDocs) },
                { title: 'Playgrounds', pages: group((p) => tools.includes(p)) },
                { title: 'Site', pages: group((p) => p !== '/' && !isDocs(p) && !tools.includes(p)) },
            ],
        }));
    });

    r.get('/sitemap.xml', async (_req, res) => {
        const entries = await sitemapEntries();
        const urls = entries.map((e) => ({ loc: abs(e.path), ...(e.lastmod ? { lastmod: e.lastmod } : {}), changefreq: e.changefreq, priority: e.priority }));
        res.type('application/xml').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(seo.sitemapXml(urls));
    });

    return r;
}

module.exports = { createDiscoveryRoutes, homeJsonLd, publicPages, dayOf };
