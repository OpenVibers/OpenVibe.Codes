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
const { twinUrl } = require('openvibe-shared/agent-layer');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');

const SITE_NAME = 'OpenVibe.Codes';
const SERVICES_ORIGIN = 'https://openvibe.services';
const DESCRIPTION = 'The open coding-agent harness: run a coding task on Claude Code, Codex, OpenCode, Command Code, Aider, Muse Code, the DeepSeek API or a model you host, with routing by capability and cost, hand-offs between agents, and the way to improve OpenVibe itself.';
const { version: VERSION } = require('../../package.json');
const INSTALL_HINT = `npm install -g https://codeload.github.com/OpenVibers/OpenVibe.Codes/tar.gz/refs/tags/v${VERSION}`;
// Sign-in and the API are not for crawlers. The console's old addresses redirect to openvibe.services.
const DISALLOW = ['/auth/', '/api/', '/tasks', '/run/tasks', '/settings', '/internal/', '/conductor', '/approvals', '/machines', '/memory', '/knowledge', '/usage'];

// Titles and one-line summaries for llms.txt. Full text uses the public HTML renderers.
// These are the pages publicPages() lists (and so the sitemap), so the two cannot name different sets.
const PAGE_TEXT = {
    '/': ['OpenVibe.Codes home', 'Code with any agent: the coding-agent harness, how a task is routed and handed off, what works today, and how to improve OpenVibe.'],
    '/run': ['Run locally', 'Start coding agents from any browser and run them on your own computer.'],
    '/start': ['Get started with the coding-agent harness', 'Install openvibe-codes; the agents it can use and what each needs; the commands, permission levels, hand-offs, the event format and using it from your own code.'],
    '/harnesses': ['The coding agents', 'Every harness the router can pick (Claude Code, Codex, OpenCode, Command Code, Aider, Muse Code, DeepSeek, your own model) with its models, capabilities, prices and limits.'],
    '/model-plans': ['Model plans', 'Single, pair, council and escalating plans for coding tasks, with model roles, checks, configuration and API.'],
    '/skills': ['The skills hub', 'Skills, rules and MCP servers kept per person and per project, versioned, shared through the four audiences, and synced into each coding tool on your own machine with a dry run and an undo.'],
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
 * SoftwareApplication) and the page that carries them. The same nodes for every crawler; nothing about the reader.
 */
function homeJsonLd(config) {
    const site = String(config.baseUrl).replace(/\/+$/, '');
    return [
        seo.jsonLd.website({ name: SITE_NAME, url: site, description: DESCRIPTION }),
        { ...seo.jsonLd.softwareApp({ name: SITE_NAME, url: site, description: DESCRIPTION, category: 'DeveloperApplication', keywords: 'ai coding agent, coding agent harness, coding agent router, agent hand-off, claude code, codex, opencode, command code, deepseek, aider, self-hosted coding agent, open source coding harness, contribute to open source' }), '@type': 'SoftwareApplication', operatingSystem: 'Linux, macOS, Windows', offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' } },
        seo.jsonLd.webPage({ name: SITE_NAME, url: `${site}/`, description: DESCRIPTION, siteUrl: site }),
    ];
}

/** The site's public pages, with their crawl hints; a community document is listed once it is published. */
function publicPages({ governance = [] }) {
    const pages = [
        { path: '/', changefreq: 'weekly', priority: 1.0 },
        { path: '/run', changefreq: 'weekly', priority: 0.9 },
        { path: '/start', changefreq: 'weekly', priority: 0.9 },
        { path: '/harnesses', changefreq: 'weekly', priority: 0.9 },
        { path: '/model-plans', changefreq: 'monthly', priority: 0.6 },
        { path: '/skills', changefreq: 'weekly', priority: 0.9 },
        { path: '/improve', changefreq: 'weekly', priority: 0.8 },
        { path: '/updates', changefreq: 'daily', priority: 0.5 },
        { path: '/policy', changefreq: 'monthly', priority: 0.4 },
    ];
    for (const g of governance) if (!g.draft) pages.push({ path: `/policy/${g.slug}`, changefreq: 'monthly', priority: 0.3 });
    const repos = require('./pages').repositories();
    for (const repo of [...repos.running, ...repos.libraries]) pages.push({ path: `/improve/${repo.repository}`, changefreq: 'weekly', priority: 0.6 });
    return pages;
}

/** The title and one-line text /llms-full.txt gives a public page. */
function describePage(pathname, { governance = [] }) {
    if (PAGE_TEXT[pathname]) return { title: PAGE_TEXT[pathname][0], text: PAGE_TEXT[pathname][1] };
    const m = /^\/policy\/([^/]+)$/.exec(pathname);
    const g = m && governance.find((x) => x.slug === m[1]);
    if (g) return { title: g.title, text: g.blurb || '' };
    if (pathname.startsWith('/improve/')) { const name = pathname.split('/').pop(); return { title: `Improve ${name}`, text: `Contribute a change to ${name} with a coding agent on your computer.` }; }
    return { title: pathname, text: '' };
}

/**
 * llms.txt: the shared kit's llmsTxt, with one thing it cannot say. A POST-only endpoint is not a
 * page to fetch — a link to it is a URL that answers 404 to a GET, and a language model that
 * follows it gets nothing. So a section may carry notes: plain lines that describe such an
 * endpoint (POST /api/v1/route — ...) instead of linking it. Every real GET link stays a link.
 */
// AGT-5: each of the site's own pages is linked at its Markdown twin (/start → /start.md, / → /index.md); a file, an
// /api/ or /.well-known/ path and another site's link keep their URL, as openvibe-shared's seo.llmsTxt markdown mode
// does. `optional` is llmstxt.org's "## Optional", last.
function twinOf(url, base) {
    let u;
    try { u = new URL(url); } catch { return url; }
    if (!base || u.origin !== new URL(base).origin || /^\/(api|\.well-known)(\/|$)/.test(u.pathname) || /\.[a-z0-9]{1,8}$/i.test(u.pathname.split('/').pop())) return url;
    return twinUrl(url);
}

function llmsTxt({ name, summary, details, sections = [], optional = [], base = null }) {
    const out = [`# ${name}`, '', `> ${String(summary || '').replace(/\s+/g, ' ').trim()}`, ''];
    if (details) out.push(String(details).trim(), '');
    for (const sec of [...sections, ...(optional.length ? [{ title: 'Optional', links: optional }] : [])]) {
        if (!sec) continue;
        const links = (sec.links || []).map((l) => '- [' + l.title + '](' + (l.canonical ? l.url : twinOf(l.url, base)) + ')' + (l.note ? ': ' + String(l.note).replace(/\s+/g, ' ').trim() : ''));
        const notes = (sec.notes || []).map((n) => String(n).replace(/\s+/g, ' ').trim());
        if (!links.length && !notes.length) continue;
        out.push('## ' + sec.title, '');
        if (links.length) out.push(...links, '');
        if (notes.length) out.push(...notes, '');
    }
    return out.join('\n');
}

function createDiscoveryRoutes(ctx) {
    const { config, governance = [] } = ctx;
    const r = asyncRouter();
    const site = String(config.baseUrl).replace(/\/+$/, '');
    const abs = (p) => `${site}${p}`;
    const TEXT = cache.htmlHeaders({ maxAge: 3600 });
    const allPages = async () => {
        const skills = ctx.skills && ctx.skills.publicPages ? await ctx.skills.publicPages() : [];
        const updates = ctx.updateDate ? await ctx.updateDate() : null;
        const revision = siteUpdated();
        const latest = dates => dates.filter(Boolean).sort().at(-1);
        return [...publicPages({ governance }).map(p => ({ ...p,
            lastmod: p.path === '/skills' ? latest([revision, ...skills.map(s => s.lastmod)])
                : p.path === '/updates' ? latest([revision, updates]) : revision,
        })), ...skills];
    };

    r.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(
            '# openvibe.codes: the public pages are for search and AI crawlers; sign-in and the API are not.\n'
            + '# Agent manifest: https://openvibe.codes/.well-known/agent.json; every public page has a .md twin.\n'
            + seo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: DISALLOW }));
    });

    r.get('/llms.txt', async (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(llmsTxt({
            name: SITE_NAME,
            base: site,
            summary: 'OpenVibe.Codes: the open coding-agent harness. openvibe-codes runs a coding task on Claude Code, Codex, OpenCode, Command Code, Aider, Muse Code, the DeepSeek API or your own OpenAI-compatible model, hands it to the next agent when one fails, and keeps every run; plus a public catalog and routing API, and the way to improve OpenVibe itself.',
            details: `Every page is server-rendered and readable without JavaScript. The harness is a command-line tool and a Node.js module that runs on your machine with your agents and keys (install: ${INSTALL_HINT}). Every agent's output becomes one event stream in Claude Code's stream-json shape. The catalog and the router are public: GET /api/v1/harnesses lists every harness with its models, and POST /api/v1/harnesses/route picks one for a task by capability first, then cost. Model plans: GET/PUT /api/v1/model-plans, GET /api/v1/model-plans/presets, and POST /api/v1/tasks with plan or preset; see /model-plans. A hosted runner comes next. The developer console that used to live here (projects, apps, keys, the API reference, OAuth and webhook tools, releases) is OpenVibe.Services at ${SERVICES_ORIGIN}.`,
            sections: [
                { title: 'Public pages', links: (await allPages()).map(p => ({ title: p.title || describePage(p.path, { governance }).title, url: abs(p.path), note: p.text || describePage(p.path, { governance }).text, canonical: true })) },
                { title: 'Start here', links: [
                    { title: 'Code with any agent', url: abs('/'), note: 'what the harness is, how a task finds its agent, what works today' },
                    { title: 'Get started', url: abs('/start'), note: 'install, agents, commands, permission levels, hand-offs, events, from your own code' },
                    { title: 'The coding agents', url: abs('/harnesses'), note: 'every harness with its models, capabilities, prices and limits' },
                    { title: 'Improve OpenVibe', url: abs('/improve'), note: 'every repository and the path to a reviewed pull request' },
                ] },
                { title: 'Community', links: [
                    { title: 'Community home', url: abs('/policy') },
                    ...governance.filter((g) => !g.draft).map((g) => ({ title: g.title, url: abs(`/policy/${g.slug}`) })),
                ] },
                { title: 'Machine-readable', links: [
                    { title: 'The agent catalog (JSON)', url: abs('/api/v1/harnesses'), note: 'every harness with its agents (platform.harness-offer@1 rows)' },
                    { title: 'The agent manifest (JSON)', url: abs('/.well-known/agent.json'), note: 'what this site tells an agent about itself' },
                ], notes: [
                    'POST /api/v1/harnesses/route — pick a harness for a task: send { task, requirements? } and get { selected, reasons, candidates }. It answers POST only, so there is no page here to fetch; the catalog and the router are described at /harnesses and /start.',
                ] },
            ],
            optional: [
                { title: 'What shipped on OpenVibe.Codes', url: abs('/updates') },
                { title: 'Sitemap', url: abs('/sitemap.xml'), note: 'the public pages, each with a real lastmod' },
                { title: 'Full text for language models', url: abs('/llms-full.txt'), note: 'the complete public pages as Markdown' },
                { title: 'Release metadata (JSON)', url: abs('/release.json'), note: 'this service\'s current release, per ADR-016' },
                { title: 'OpenVibe.Services', url: SERVICES_ORIGIN, note: 'the developer platform: projects, keys, grants and the API docs of every service' },
            ],
        }));
    });

    // Full text comes from the same anonymous renderers as HTML and negotiated Markdown.
    r.get('/llms-full.txt', async (_req, res) => {
        const chunks = [`# ${SITE_NAME}`, DESCRIPTION];
        for (const p of await allPages()) {
            const rendered = await ctx.renderPublicPage(p.path);
            if (!rendered) continue;
            chunks.push(`URL: ${abs(p.path)}\n` + require('openvibe-shared/agent-layer').markdownTwin({ ...rendered, canonical: abs(p.path) }));
        }
        res.type('text/plain').set('Cache-Control', TEXT).send(chunks.join('\n\n'));
    });

    r.get('/sitemap.xml', async (_req, res) => {
        const lastmod = siteUpdated();
        const urls = (await allPages()).map((e) => ({ loc: abs(e.path), ...(e.lastmod || lastmod ? { lastmod: e.lastmod || lastmod } : {}), changefreq: e.changefreq, priority: e.priority }));
        res.type('application/xml').set('Cache-Control', TEXT).send(seo.sitemapXml(urls));
    });

    r.publicPages = allPages;
    return r;
}

module.exports = { createDiscoveryRoutes, homeJsonLd, publicPages, dayOf, SERVICES_ORIGIN, DESCRIPTION };
