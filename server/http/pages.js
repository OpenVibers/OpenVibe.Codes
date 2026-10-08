'use strict';

/**
 * Public pages: the home page (the open coding-agent harness), the agent catalog, Improve OpenVibe (how OpenVibe
 * itself is built and how to help), the community documents, and the update log. Crawl artifacts (robots.txt,
 * sitemap.xml, llms.txt, llms-full.txt, the home page's JSON-LD) live in http/discovery.js and are mounted here.
 *
 * What is shown is read, never restated: the catalog is server/data/harness-offers.json as validated at boot, the
 * repositories are the pinned openvibe-contracts service manifests, and the community documents render this
 * repository's Markdown files as they are. The developer console that used to live here (projects, apps, docs,
 * tools, releases) is OpenVibe.Services' since 2026-10-08; http/moved.js redirects its addresses there.
 */
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd, SERVICES_ORIGIN } = require('./discovery');
const { html, raw, table, notice } = require('../render/html');
const { send } = require('../render/layout');
const { markdown } = require('../render/markdown');
const placement = require('../domain/harness-placement');

const ROOT = path.join(__dirname, '..', '..');
const GITHUB = 'https://github.com/OpenVibers';

/**
 * Community documents: Markdown in this repository (the same files GitHub shows), rendered as they are. A document
 * whose text starts with the draft line is shown with a draft notice, kept out of search engines and the sitemap;
 * removing that line after the owner's review publishes it.
 */
const GOVERNANCE = [
    { slug: 'code-of-conduct', file: 'CODE_OF_CONDUCT.md', blurb: 'how we treat each other, and how to report a problem' },
    { slug: 'contributing', file: 'CONTRIBUTING.md', blurb: 'how to report a bug, propose a change and open a pull request' },
    { slug: 'contributor-ladder', file: 'docs/governance/contributor-ladder.md', blurb: 'participant, contributor, reviewer, maintainer, owner' },
    { slug: 'moderation', file: 'docs/governance/moderation.md', blurb: 'what is moderated, the steps, and appeals' },
];
const DRAFT_LINE = /^\*\*Draft — pending owner review\.\*\*.*$/m;
function loadGovernance() {
    return GOVERNANCE.map((g) => {
        const text = fs.readFileSync(path.join(ROOT, g.file), 'utf8');
        const title = (text.match(/^# (.+)$/m) || [null, g.slug])[1].trim();
        const draft = DRAFT_LINE.test(text.split('\n').slice(0, 5).join('\n'));
        const body = text.replace(/^# .+\n/m, '').replace(DRAFT_LINE, '');
        return { ...g, title, draft, body };
    });
}

/**
 * The repositories OpenVibe is built from, as the pinned contracts' service manifests name them: the services that
 * run (by their site position), then the libraries every service shares. A manifest without a repository is skipped.
 */
function repositories() {
    const rows = contracts.services.manifests
        .filter((m) => m && typeof m.repository === 'string' && /^OpenVibers\/[A-Za-z0-9._-]+$/.test(m.repository))
        .filter((m) => m.exposure && ['live', 'library'].includes(m.exposure.state));
    const order = (m) => (m.site && m.site.position != null ? m.site.position : 50);
    const running = rows.filter((m) => m.exposure.state === 'live').sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
    const libraries = rows.filter((m) => m.exposure.state === 'library').sort((a, b) => a.name.localeCompare(b.name));
    return { running, libraries };
}

const FLAG_LABELS = { host_access: 'runs on your machine', mcp: 'MCP tools', long_autonomy: 'long autonomous runs', resume: 'resumes a session', review: 'reviews', vision: 'reads images' };
const flagsOf = (c) => Object.keys(FLAG_LABELS).filter((k) => c && c[k]).map((k) => FLAG_LABELS[k]);

function createPageRoutes(ctx) {
    const { config, harnesses } = ctx;
    const r = asyncRouter();
    const PUBLIC_CACHE = cache.htmlHeaders({ maxAge: 300 });
    const governance = loadGovernance();
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });

    // ── Home: code with any agent ───────────────────────────
    r.get('/', (req, res) => {
        const offers = harnesses.list();
        const tasks = Object.keys(placement.TASKS);
        const snippet = `# Which agent should take this task?
curl -s ${config.baseUrl}/api/v1/harnesses/route \\
  -H 'content-type: application/json' \\
  -d '{"task":"edit"}'

# → { "selected": "claude-code:…",
#     "reasons": […], "candidates": […] }`;
        page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            jsonLd: homeJsonLd(config),
            styles: [showcase.STYLESHEET],
            body: html`${raw(showcase.hero({
                eyebrow: 'OpenVibe.Codes · the open coding-agent harness · alpha',
                title: 'Code with', accent: 'any agent',
                lede: 'One open harness for Claude Code, Codex, OpenCode, Command Code, Aider, the DeepSeek API and models you host yourself: send a coding task to the agent that fits it, hand it over when one gets stuck, and keep the whole run in one place. Then point it at OpenVibe itself.',
                actions: [{ label: 'Meet the agents', href: '/harnesses', primary: true }, { label: 'Improve OpenVibe', href: '/improve' }],
                note: 'Open source (AGPL-3.0). Today: the agent catalog and a routing API anyone can call. Running jobs, hand-offs and a self-hosted runner come next; the list below says exactly what works.',
                aside: { html: `<pre class="codes-hero-code"><code>${showcase.esc(snippet)}</code></pre>` },
            }))}
${raw(showcase.features({
                id: 'agents', title: 'The agents', lede: `${offers.length} harnesses in the catalog, each with the models it runs. Routing picks one by what the task needs first, then by cost.`,
                items: offers.map((o) => ({ title: o.name, text: [o.provider, ...flagsOf(o.capabilities).slice(0, 3)].join(' · '), href: `/harnesses#${o.id}` })),
            }))}
${raw(showcase.steps({
                title: 'How a task finds its agent',
                items: [
                    { title: 'Describe the task', text: `One of ${tasks.join(', ')}, plus anything it must have: a capability, a runtime, a ceiling on cost.` },
                    { title: 'Hard limits first', text: 'An agent that lacks a required capability is out, whatever it costs. Each refusal says why.' },
                    { title: 'Then the cheapest fit', text: 'Already-paid capacity and free allowances first, then price per token, through the same placement engine every OpenVibe service uses.' },
                    { title: 'Hand-offs', text: 'When the first agent stalls, the run moves to the next candidate with its context (next: the runner).' },
                ],
            }))}
<section class="sc-sec" aria-labelledby="h-improve"><h2 id="h-improve">Improve OpenVibe</h2>
<p class="sc-lede">OpenVibe is built in the open, ${repositories().running.length} services and their shared libraries, every one on GitHub. Pick a repository, describe the change, and send a pull request; the harness's job is to make that one step.</p>
<p><a class="sc-btn sc-primary" href="/improve">Start contributing</a> <a class="sc-btn" href="/policy/contributing">Read the guide</a></p></section>
<section class="sc-sec" aria-labelledby="h-status"><h2 id="h-status">What works today</h2>
${table(['Piece', 'State'], [
                [html`<a href="/harnesses">The agent catalog</a>`, 'Live: every harness and model with its capabilities, prices and limits.'],
                [html`<code>GET /api/v1/harnesses</code>, <code>POST /api/v1/harnesses/route</code>`, 'Live: public, no key needed; per-address and per-caller limits.'],
                ['Running a task on an agent, streaming its output, budgets', 'Next. The agents run today on OpenVibe\'s own machines; opening that to everyone is the next step.'],
                ['Hand-offs between agents, resumable sessions', 'Next, with the runner.'],
                ['A runner on your own machine (your CLIs, your keys)', 'Planned.'],
                [html`Improve OpenVibe from here: repository → change → tests → review → pull request`, 'Planned. Today: the contributor path on GitHub, below.'],
            ])}</section>
${raw(showcase.cta({ title: 'Building an app instead?', text: 'Projects, keys, grants and the API docs of every OpenVibe service live on OpenVibe.Services.', actions: [{ label: 'Open the developer platform', href: SERVICES_ORIGIN, primary: true }, { label: 'Meet the agents', href: '/harnesses' }] }))}`,
        });
    });

    // ── The agent catalog (server/data/harness-offers.json, validated at boot) ──
    // No address target that is a local path is ever shown — only the address kind.
    const isLocalPath = (t) => /^(?:[A-Za-z]:[\\/]|[~/]|\.\.?[\\/])/.test(String(t || ''));
    const addressOf = (o) => {
        const kind = (o.address && o.address.kind) || '—';
        const target = o.address && o.address.target;
        return target && !isLocalPath(target) ? html`${kind} <code>${target}</code>` : kind;
    };
    const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
    const duration = (n) => (n >= 3600 && n % 3600 === 0 ? `${n / 3600} h` : `${n} s`);
    const count = (n) => Number(n).toLocaleString('en-US');
    r.get('/harnesses', (req, res) => {
        const offers = harnesses.list();
        page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            title: 'The coding agents',
            description: 'Claude Code, Codex, OpenCode, Command Code, Aider and the DeepSeek API: every coding harness OpenVibe.Codes routes a task to, with its models, capabilities, prices and limits.',
            crumbs: [{ label: 'Agents' }],
            body: html`<h1>The coding agents</h1>
<p>A task is routed with <code>POST /api/v1/harnesses/route</code> over <code>openvibe-sdk/placement</code>, which picks an offer from this catalog: hard requirements first (a capability the task needs), then cost. The catalog is read and validated when Codes starts; every price and limit is as the offer states it. Machine-readable: <a href="/api/v1/harnesses"><code>GET /api/v1/harnesses</code></a>.</p>
${table(['Harness', 'Provider', 'Address', 'Can', 'Price', 'Limits'], offers.map((o) => [
                html`<strong id="${o.id}">${o.name}</strong><br><code>${o.id}</code>`,
                o.provider,
                addressOf(o),
                flagsOf(o.capabilities).join(', ') || '—',
                `${usd(o.price.amount_usd)} / ${o.price.unit}`,
                `${duration(o.limits.max_duration_seconds)}, ${count(o.limits.max_concurrent_runs)} concurrent, ${count(o.limits.max_context_tokens)} context tokens`,
            ]))}
<h2>Models</h2>
${offers.map((o) => html`<h3>${o.name} <code>${o.id}</code></h3>${o.agents.length
                ? table(['Provider', 'Model', 'Context (in / out)', 'Price per 1k tokens'], o.agents.map((a) => [
                    a.provider,
                    a.model,
                    `${count(a.context_limits.input_tokens)} / ${count(a.context_limits.output_tokens)}`,
                    `${usd(a.price_per_1k_tokens.fresh_usd)} fresh, ${usd(a.price_per_1k_tokens.cached_usd)} cached, ${usd(a.price_per_1k_tokens.output_usd)} output`,
                ]))
                : html`<p class="muted">no models yet</p>`}`)}`,
        });
    });

    // ── Improve OpenVibe ─────────────────────────────────────
    r.get('/improve', (req, res) => {
        const { running, libraries } = repositories();
        const repoCards = (list) => html`<ul class="cards">${list.map((m) => html`<li><a href="${GITHUB}/${m.repository.split('/')[1]}"><strong>${m.repository.split('/')[1]}</strong></a><span>${(m.site && (m.site.tagline || m.site.what)) || m.name}</span></li>`)}</ul>`;
        page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            title: 'Improve OpenVibe',
            description: 'OpenVibe is open source: every service and library is on GitHub. How to pick a repository, make a change, run its tests and open a pull request, and the community rules that apply.',
            crumbs: [{ label: 'Improve OpenVibe' }],
            body: html`<h1>Improve OpenVibe</h1>
<p>Every OpenVibe service and library is open source under <a href="${GITHUB}">OpenVibers</a> on GitHub, and changes arrive as pull requests that the owner approves. You can do it by hand today; the harness will take the same path for you: repository → change → tests → independent review → pull request, never straight to <code>main</code>.</p>
<ol class="steps">
<li><strong>Pick a repository</strong> from the lists below, or find the page you want to change and follow its "source" link.</li>
<li><strong>Read its README</strong>: what it owns, how to run it, and its tests (<code>npm test</code> runs them on temporary databases; nothing needs a live service).</li>
<li><strong>Make the change</strong> on a branch, with a test that would have failed before it.</li>
<li><strong>Open a pull request</strong> that says what changes for people and why. CI runs the tests, an audit and a secret scan.</li>
<li><strong>Review</strong>: a maintainer reviews it; the owner approves what ships. See the <a href="/policy/contributor-ladder">contributor ladder</a> for how reviewers and maintainers are chosen.</li>
</ol>
<p>Before you start: the <a href="/policy/contributing">contributing guide</a> and the <a href="/policy/code-of-conduct">code of conduct</a>. Building your own app on OpenVibe instead? That is <a href="${SERVICES_ORIGIN}">OpenVibe.Services</a>.</p>
<h2>Services that run</h2>
${repoCards(running)}
<h2>Shared libraries</h2>
${repoCards(libraries)}`,
        });
    });

    // ── Community documents and the update log ───────────────
    // What shipped on OpenVibe.Codes: the shared update log every OpenVibe site has.
    r.get('/updates', (req, res) => page(req, res, { index: true, cache: PUBLIC_CACHE, title: 'What shipped on OpenVibe.Codes', body: raw(frame.updatesBody({ service: 'codes', siteName: 'OpenVibe.Codes' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`) }));
    r.get('/policy', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE, title: 'Community', crumbs: [{ label: 'Community' }],
        body: html`<h1>Community</h1>
<p>The rules for everyone who builds OpenVibe and everything published on it: the repositories, and the apps and releases on OpenVibe.Services.</p>
<ul class="cards">
${governance.map((g) => html`<li><a href="/policy/${g.slug}"><strong>${g.title}</strong></a><span>${g.blurb}${g.draft ? ' (draft, pending owner review)' : ''}</span></li>`)}</ul>
<p class="muted">The platform's own policy (how a contract or capability changes, compatibility and deprecation, licensing, transparency) is on <a href="${SERVICES_ORIGIN}/policy">OpenVibe.Services</a>.</p>`,
    }));

    for (const g of governance) {
        r.get(`/policy/${g.slug}`, (req, res) => page(req, res, {
            index: !g.draft, cache: PUBLIC_CACHE, title: g.title, crumbs: [{ label: 'Community', href: '/policy' }, { label: g.title }],
            body: html`<h1>${g.title}</h1>
${g.draft ? notice(html`<strong>Draft — pending owner review.</strong> This is a proposal, not yet in effect. It takes effect when the owner of the OpenVibers organization approves it.`, 'warn') : ''}
<article class="prose">${raw(markdown(g.body, { headingOffset: 0 }))}</article>
<p class="muted small">Source: <a href="${GITHUB}/OpenVibe.Codes/blob/main/${g.file}"><code>${g.file}</code></a>. Changes go through a pull request that the owner approves.</p>`,
        }));
    }

    // ── Discovery: robots.txt, sitemap.xml, llms.txt, llms-full.txt (http/discovery.js, openvibe-shared/seo) ──
    r.use(createDiscoveryRoutes({ ...ctx, governance }));

    return r;
}

module.exports = { createPageRoutes, GOVERNANCE, repositories };
