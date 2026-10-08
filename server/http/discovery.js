'use strict';

/**
 * Crawl and machine-readability artifacts (plan T11): GET /robots.txt, GET /sitemap.xml,
 * GET /llms.txt and GET /llms-full.txt, plus the home page's JSON-LD. Every one is built with
 * openvibe-shared/seo — the same toolkit the other OpenVibe sites use — so they say the same things
 * here as everywhere.
 *
 * Public pages only, and never the viewer: sign-in and the API are absent from all of them and Disallowed in
 * robots.txt. lastmod is the committed content-revision date in STATUS.json, never "today" from the clock, which
 * would tell crawlers the whole site changed on every fetch. The developer console's pages moved to
 * openvibe.services (http/moved.js answers them with 301s), so none of them is listed here.
 */
const fs = require('fs');
const path = require('path');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');

const SITE_NAME = 'OpenVibe.Codes';
const SERVICES_ORIGIN = 'https://openvibe.services';
const DESCRIPTION = 'The open coding-agent harness: run a coding task on Claude Code, Codex, OpenCode, Command Code, Aider, the DeepSeek API or a model you host, with routing by capability and cost, hand-offs between agents, and the way to improve OpenVibe itself.';
const { version: VERSION } = require('../../package.json');
const INSTALL_HINT = `npm install -g https://codeload.github.com/OpenVibers/OpenVibe.Codes/tar.gz/refs/tags/v${VERSION}`;
const HARNESS_PAGES = ['/', '/start', '/harnesses', '/improve'];
// Sign-in and the API are not for crawlers. The console's old addresses redirect to openvibe.services.
const DISALLOW = ['/auth/', '/api/'];

// The one line /llms-full.txt says about each fixed public page: a title and what the page serves.
// These are the pages publicPages() lists (and so the sitemap), so the two cannot name different sets.
const PAGE_TEXT = {
    '/': ['OpenVibe.Codes home', 'Code with any agent: the coding-agent harness, how a task is routed and handed off, what works today, and how to improve OpenVibe.'],
    '/start': ['Get started with the coding-agent harness', 'Install openvibe-codes; the agents it can use and what each needs; the commands, permission levels, hand-offs, the event format and using it from your own code.'],
    '/harnesses': ['The coding agents', 'Every harness the router can pick (Claude Code, Codex, OpenCode, Command Code, Aider, DeepSeek, your own model) with its models, capabilities, prices and limits.'],
    '/improve': ['Improve OpenVibe', 'How OpenVibe is built in the open: every repository, and the path from a change to a reviewed pull request.'],
    '/updates': ['What shipped on OpenVibe.Codes', 'This site\'s update log, from the network changelog feed.'],
    '/policy': ['Community', 'The code of conduct, the contributing guide, the contributor ladder and the moderation policy.'],
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
 * The home page's JSON-LD: the site as a WebSite, the harness as the site's primary type (the shared kit's
 * WebApplication) and the page that carries them. The same nodes for every crawler; nothing about the reader.
 */
function homeJsonLd(config) {
    const site = String(config.baseUrl).replace(/\/+$/, '');
    return [
        seo.jsonLd.website({ name: SITE_NAME, url: site, description: DESCRIPTION }),
        seo.jsonLd.softwareApp({ name: SITE_NAME, url: site, description: DESCRIPTION, category: 'DeveloperApplication', keywords: 'ai coding agent, coding agent harness, coding agent router, agent hand-off, claude code, codex, opencode, command code, deepseek, aider, self-hosted coding agent, open source coding harness, contribute to open source' }),
        seo.jsonLd.webPage({ name: SITE_NAME, url: `${site}/`, description: DESCRIPTION, siteUrl: site }),
    ];
}

/** The site's public pages, with their crawl hints; a community document is listed once it is published. */
function publicPages({ governance = [] }) {
    const pages = [
        { path: '/', changefreq: 'weekly', priority: 1.0 },
        { path: '/start', changefreq: 'weekly', priority: 0.9 },
        { path: '/harnesses', changefreq: 'weekly', priority: 0.9 },
        { path: '/improve', changefreq: 'weekly', priority: 0.8 },
        { path: '/updates', changefreq: 'daily', priority: 0.5 },
        { path: '/policy', changefreq: 'monthly', priority: 0.4 },
    ];
    for (const g of governance) if (!g.draft) pages.push({ path: `/policy/${g.slug}`, changefreq: 'monthly', priority: 0.3 });
    return pages;
}

/** The title and one-line text /llms-full.txt gives a public page. */
function describePage(pathname, { governance = [] }) {
    if (PAGE_TEXT[pathname]) return { title: PAGE_TEXT[pathname][0], text: PAGE_TEXT[pathname][1] };
    const m = /^\/policy\/([^/]+)$/.exec(pathname);
    const g = m && governance.find((x) => x.slug === m[1]);
    if (g) return { title: g.title, text: g.blurb || '' };
    return { title: pathname, text: '' };
}

function createDiscoveryRoutes(ctx) {
    const { config, governance = [] } = ctx;
    const r = asyncRouter();
    const site = String(config.baseUrl).replace(/\/+$/, '');
    const abs = (p) => `${site}${p}`;
    const TEXT = cache.htmlHeaders({ maxAge: 3600 });

    r.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(
            '# openvibe.codes: the public pages are for search and AI crawlers; sign-in and the API are not.\n'
            + seo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: DISALLOW }));
    });

    r.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsTxt({
            name: SITE_NAME,
            summary: 'OpenVibe.Codes: the open coding-agent harness. openvibe-codes runs a coding task on Claude Code, Codex, OpenCode, Command Code, Aider, the DeepSeek API or your own OpenAI-compatible model, hands it to the next agent when one fails, and keeps every run; plus a public catalog and routing API, and the way to improve OpenVibe itself.',
            details: `Every page is server-rendered and readable without JavaScript. The harness is a command-line tool and a Node.js module that runs on your machine with your agents and keys (install: ${INSTALL_HINT}). Every agent's output becomes one event stream in Claude Code's stream-json shape. The catalog and the router are public: GET /api/v1/harnesses lists every harness with its models, and POST /api/v1/harnesses/route picks one for a task by capability first, then cost. A hosted runner comes next. The developer console that used to live here (projects, apps, keys, the API reference, OAuth and webhook tools, releases) is OpenVibe.Services at ${SERVICES_ORIGIN}.`,
            sections: [
                { title: 'Start here', links: [
                    { title: 'Code with any agent', url: abs('/'), note: 'what the harness is, how a task finds its agent, what works today' },
                    { title: 'Get started', url: abs('/start'), note: 'install, agents, commands, permission levels, hand-offs, events, from your own code' },
                    { title: 'The coding agents', url: abs('/harnesses'), note: 'every harness with its models, capabilities, prices and limits' },
                    { title: 'Improve OpenVibe', url: abs('/improve'), note: 'every repository and the path to a reviewed pull request' },
                    { title: 'What shipped on OpenVibe.Codes', url: abs('/updates') },
                ] },
                { title: 'Community', links: [
                    { title: 'Community home', url: abs('/policy') },
                    ...governance.filter((g) => !g.draft).map((g) => ({ title: g.title, url: abs(`/policy/${g.slug}`) })),
                ] },
                { title: 'Machine-readable', links: [
                    { title: 'The agent catalog (JSON)', url: abs('/api/v1/harnesses'), note: 'every harness with its agents (platform.harness-offer@1 rows)' },
                    { title: 'Route a task', url: abs('/api/v1/harnesses/route'), note: 'POST { task, requirements? } → { selected, reasons, candidates }' },
                    { title: 'Sitemap', url: abs('/sitemap.xml'), note: 'the public pages, each with a real lastmod' },
                    { title: 'Full text for language models', url: abs('/llms-full.txt'), note: 'every public page, one line each' },
                    { title: 'Release metadata (JSON)', url: abs('/release.json'), note: 'this service\'s current release, per ADR-016' },
                ] },
                { title: 'Elsewhere', links: [
                    { title: 'OpenVibe.Services', url: SERVICES_ORIGIN, note: 'the developer platform: projects, keys, grants and the API docs of every service' },
                ] },
            ],
        }));
    });

    // /llms-full.txt: the same public pages the sitemap lists, one title and one line of text each.
    r.get('/llms-full.txt', (_req, res) => {
        const pages = publicPages({ governance }).map((p) => ({ url: p.path, ...describePage(p.path, { governance }) }));
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsFull({
            site: SITE_NAME,
            summary: 'Every public page of OpenVibe.Codes, one line each: the harness, getting started, the agent catalog, Improve OpenVibe, the update log and the community documents.',
            base: site,
            maxBytes: 128 * 1024,
            sections: [
                { title: 'Harness', pages: pages.filter((p) => HARNESS_PAGES.includes(p.url)) },
                { title: 'Site', pages: pages.filter((p) => !HARNESS_PAGES.includes(p.url)) },
            ],
        }));
    });

    r.get('/sitemap.xml', (_req, res) => {
        const lastmod = siteUpdated();
        const urls = publicPages({ governance }).map((e) => ({ loc: abs(e.path), ...(lastmod ? { lastmod } : {}), changefreq: e.changefreq, priority: e.priority }));
        res.type('application/xml').set('Cache-Control', TEXT).send(seo.sitemapXml(urls));
    });

    return r;
}

module.exports = { createDiscoveryRoutes, homeJsonLd, publicPages, dayOf, SERVICES_ORIGIN, DESCRIPTION };
