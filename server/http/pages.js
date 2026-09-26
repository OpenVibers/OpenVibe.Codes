'use strict';

/**
 * Public pages: the landing page, policy pages, public release and trust pages, the staff trust
 * console, robots.txt and the sitemap.
 *
 * Policy pages are derived, not paraphrased: the compatibility and deprecation policy renders
 * ADR-002 and ADR-016 exactly as openvibe-contracts publishes them; the decision index is the ADR
 * directory; licensing reads the license fields of the packages Codes runs; the governance pages
 * (code of conduct, contributing, contributor ladder, moderation) render this repository's
 * Markdown files as they are.
 */
const fs = require('fs');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const path = require('path');
const express = require('express');
const { asyncRouter } = require('./router');
const { html, raw, table, code, badge, time, notice, csrfField, problemBox } = require('../render/html');
const { send } = require('../render/layout');
const { markdown } = require('../render/markdown');
const { csrfToken, checkCsrf, sameOrigin } = require('../auth/forms');
const { TABLES } = require('../db');
const { EVENT_TYPES } = require('../events/outbox');

const ROOT = path.join(__dirname, '..', '..');
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

/**
 * Governance documents: Markdown in this repository (the same files GitHub shows), rendered as
 * they are. A document whose text starts with the draft line is shown with a draft notice, kept out
 * of search engines and the sitemap; removing that line after the owner's review publishes it.
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

function createPageRoutes(ctx) {
    const { config, docs, releases, trust, network, sso } = ctx;
    const r = asyncRouter();
    const form = express.urlencoded({ extended: false, limit: '32kb' });
    const PUBLIC_CACHE = 'public, max-age=300';
    const governance = loadGovernance();
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });

    r.get('/', (req, res) => {
        const recent = releases.recentPublic(10);
        page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            body: html`<h1>Build on OpenVibe</h1>
<p class="lead">OpenVibe.Codes is the developer portal: create a project and apps in OpenVibe.Network, get scoped credentials, request capability grants, and read reference docs generated from the exact contract and SDK versions the platform runs.</p>
<div class="notice">Status: alpha. What works and what does not is listed on the <a href="/policy/transparency">transparency page</a>. Network owns projects, apps, credentials, grants and quotas; Codes is a portal over its API and never stores a secret.</div>
<h2>From account to integration</h2>
<ol class="steps">
<li><a href="/projects">Create a project</a> (signed in with your OpenVibe account). New projects are sandbox-only; staff enable production.</li>
<li>Add a <strong>sandbox app</strong>. A confidential app gets a client secret, shown once.</li>
<li><a href="/docs/capabilities?grantable=1">Pick capabilities</a> and request them for the app. They are approved only inside the project's allowance.</li>
<li>Install <a href="/docs/sdk">openvibe-sdk</a>; get a token with <code>createServiceTokenClient()</code> (client credentials) or sign people in with <a href="/oauth">authorization code + PKCE</a>.</li>
<li>Receive events: subscribe, then verify each delivery's signature (<a href="/tools/webhooks">tester</a>).</li>
<li>Try calls in the app's playground with the app's own credentials: it cannot do anything the app is not granted.</li>
<li>Publish release metadata with a <a href="/manifests/validate">validated manifest</a>; rotate or revoke credentials any time.</li>
</ol>
<h2>Reference</h2>
<p>Generated from <code>openvibe-contracts v${docs.contractsVersion}</code> and <code>openvibe-sdk v${docs.sdkVersion}</code>: <a href="/docs/api">API explorer</a> · <a href="/docs/contracts">contracts</a> · <a href="/docs/capabilities">capabilities</a> · <a href="/docs/events">events</a> · <a href="/docs/services">services</a> · <a href="/docs/tools">tools</a> · <a href="/docs/sdk">SDK</a>.</p>
<h2>Recent releases</h2>
${table(['App', 'Kind', 'Version', 'Status', 'Trust', 'Published'], recent.map((x) => [
                html`<a href="/apps/${x.app_id}">${x.name}</a>`, x.kind, html`<a href="/releases/${x.id}">${x.version}</a>`, x.status, x.trust.tier, time(x.published_at),
            ]), { empty: 'No releases have been published yet.' })}`,
        });
    });

    // ── Policy ──────────────────────────────────────────────
    const adr = (id) => docs.adrs.find((a) => a.id === id);
    // What shipped on OpenVibe.Codes: the shared update log every OpenVibe site has.
    r.get('/updates', (req, res) => page(req, res, { index: true, cache: PUBLIC_CACHE, title: 'What shipped on OpenVibe.Codes', body: raw(frame.updatesBody({ service: 'codes', siteName: 'OpenVibe.Codes' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`) }));
    r.get('/policy', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE, title: 'Policy', crumbs: [{ label: 'Policy' }],
        body: html`<h1>Policy</h1><ul class="cards">
<li><a href="/policy/rfc"><strong>Proposals and decisions</strong></a><span>how a contract, capability or event changes; the decision record</span></li>
<li><a href="/policy/compatibility"><strong>Compatibility and deprecation</strong></a><span>ADR-002 and ADR-016, as published</span></li>
<li><a href="/policy/licensing"><strong>Licensing</strong></a><span>what each package is licensed under</span></li>
<li><a href="/policy/transparency"><strong>Transparency</strong></a><span>what Codes stores, what it does not, and what works today</span></li></ul>
<h2>Community</h2><ul class="cards">
${governance.map((g) => html`<li><a href="/policy/${g.slug}"><strong>${g.title}</strong></a><span>${g.blurb}${g.draft ? ' (draft, pending owner review)' : ''}</span></li>`)}</ul>`,
    }));

    for (const g of governance) {
        r.get(`/policy/${g.slug}`, (req, res) => page(req, res, {
            index: !g.draft, cache: PUBLIC_CACHE, title: g.title, crumbs: [{ label: 'Policy', href: '/policy' }, { label: g.title }],
            body: html`<h1>${g.title}</h1>
${g.draft ? notice(html`<strong>Draft — pending owner review.</strong> This is a proposal, not yet in effect. It takes effect when the owner of the OpenVibers organization approves it.`, 'warn') : ''}
<article class="prose">${raw(markdown(g.body, { headingOffset: 0 }))}</article>
<p class="muted small">Source: <a href="https://github.com/OpenVibers/OpenVibe.Codes/blob/main/${g.file}"><code>${g.file}</code></a>. Changes go through a pull request that the owner approves.</p>`,
        }));
    }

    r.get('/policy/rfc', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE, title: 'Proposals and decisions', crumbs: [{ label: 'Policy', href: '/policy' }, { label: 'Proposals' }],
        body: html`<h1>Proposals and decisions</h1>
<p>Changes to the platform's public surface — a contract, a capability, an event type, or a major product policy — are proposed in the open and recorded as an architecture decision record (ADR) in <a href="https://github.com/OpenVibers/OpenVibe.Contracts">OpenVibe.Contracts</a>.</p>
<ol class="steps">
<li><strong>Propose.</strong> Open an issue or pull request on OpenVibe.Contracts describing the change, who owns it, and who consumes it. A service that introduces capabilities ships proposals in its own repository (<code>docs/capabilities-proposal/</code>, <code>docs/service-manifest-proposal.json</code>) — this portal's are in <a href="https://github.com/OpenVibers/OpenVibe.Codes/tree/main/docs">its repository</a>.</li>
<li><strong>Decide.</strong> An accepted proposal becomes an ADR with context, decision, alternatives, migration consequences, rollback and acceptance tests.</li>
<li><strong>Release.</strong> The contract lands in a tagged openvibe-contracts release; CI in every consuming service checks it (<code>openvibe-contracts-check</code>). The SDK wraps it in the same or the next release, and these docs regenerate from the new pins.</li>
</ol>
<h2>Decision record</h2>
<p class="versions">The ADRs in <code>openvibe-contracts v${docs.contractsVersion}</code>:</p>
${table(['Decision', 'Status'], docs.adrs.map((a) => [html`<a href="/docs/adr/${a.id}">${a.title}</a>`, a.status]))}`,
    }));

    r.get('/policy/compatibility', (req, res) => {
        const a2 = adr('ADR-002');
        const a16 = adr('ADR-016');
        page(req, res, {
            index: true, cache: PUBLIC_CACHE, title: 'Compatibility and deprecation', crumbs: [{ label: 'Policy', href: '/policy' }, { label: 'Compatibility' }],
            body: html`<h1>Compatibility and deprecation</h1>
<p class="versions">This page renders two decisions exactly as published in <code>openvibe-contracts v${docs.contractsVersion}</code>, so it cannot say anything they do not.</p>
<p>Current deprecations in that release: ${docs.contracts.filter((c) => c.deprecation).length ? html`<ul>${docs.contracts.filter((c) => c.deprecation).map((c) => html`<li><a href="/docs/contracts/${c.id}">${c.id}</a> → ${c.deprecation.replacement}, removed after ${c.deprecation.removeAfter}</li>`)}</ul>` : 'none.'}
Deprecated capabilities: ${docs.capabilities.filter((c) => c.status === 'deprecated').map((c) => c.id).join(', ') || 'none'}.</p>
${a2 ? html`<article class="prose">${raw(markdown(a2.markdown))}</article>` : notice('ADR-002 is not in this contracts release.', 'warn')}
${a16 ? html`<article class="prose">${raw(markdown(a16.markdown))}</article>` : notice('ADR-016 is not in this contracts release.', 'warn')}`,
        });
    });

    r.get('/policy/licensing', (req, res) => {
        const pkgs = ['openvibe-contracts', 'openvibe-sdk', 'openvibe-shared'].map((n) => {
            const p = readJson(path.join(path.dirname(require.resolve(`${n}/package.json`)), 'package.json')) || {};
            return [code(n), p.version || '—', p.license || 'not declared'];
        });
        const own = readJson(path.join(ROOT, 'package.json')) || {};
        page(req, res, {
            index: true, cache: PUBLIC_CACHE, title: 'Licensing', crumbs: [{ label: 'Policy', href: '/policy' }, { label: 'Licensing' }],
            body: html`<h1>Licensing</h1>
<p>Read from the packages this portal runs, not typed in:</p>
${table(['Package', 'Version', 'License'], [[code(own.name || 'openvibe-codes'), own.version || '—', own.license || 'not declared'], ...pkgs])}
<p>The SDK is the library apps outside the network embed; the services and their contracts are open source under the licenses above. Each repository's LICENSE file is authoritative. This page is not legal advice.</p>
<p>Source: <a href="https://github.com/OpenVibers">github.com/OpenVibers</a>.</p>`,
        });
    });

    r.get('/policy/transparency', (req, res) => {
        const status = readJson(path.join(ROOT, 'STATUS.json')) || {};
        page(req, res, {
            index: true, cache: PUBLIC_CACHE, title: 'Transparency', crumbs: [{ label: 'Policy', href: '/policy' }, { label: 'Transparency' }],
            body: html`<h1>Transparency</h1>
<h2>What Codes stores</h2>
<p>Its own SQLite database has these tables and nothing else: ${TABLES.map((t, i) => html`${i ? ', ' : ''}<code>${t}</code>`)}, plus the event outbox. That is release metadata keyed to Network app ids, trust tiers (metadata), validated manifests, and a log of playground runs (who ran what, the outcome and the problem code).</p>
<h2>What Codes does not store</h2>
<ul><li>Projects, members, apps, credentials, grants and quotas: OpenVibe.Network owns them; Codes shows what Network answers for the signed-in person.</li>
<li>Client secrets: Network returns a new secret once, Codes shows it in that response and keeps no copy. Network itself stores only a hash.</li>
<li>Access tokens: your Network session sits in httpOnly cookies in your browser; tokens a playground uses exist only for that request.</li>
<li>Webhook secrets typed into the tester: used for one computation, then dropped.</li></ul>
<h2>What Codes does not do</h2>
<ul><li>It does not enforce quotas: each service that owns a capability does (quotas are shown as recorded limits).</li>
<li>It does not issue tokens or decide grants: Network does.</li>
<li>Trust tiers never grant anything: authority comes only from grants.</li></ul>
<h2>Events it publishes</h2>
<p>${EVENT_TYPES.map((t, i) => html`${i ? ', ' : ''}<code>${t}</code>`)} when a release is published, deprecated or revoked (through OpenVibe.Events once its relay is configured).</p>
<h2>Status</h2>
<p>Stage <strong>${status.stage || 'unknown'}</strong>. ${status.summary || ''}</p>
${Array.isArray(status.works) ? html`<h3>Works</h3><ul>${status.works.map((w) => html`<li>${w}</li>`)}</ul>` : ''}
${Array.isArray(status.notYet) ? html`<h3>Not yet</h3><ul>${status.notYet.map((w) => html`<li>${w}</li>`)}</ul>` : ''}`,
        });
    });

    // ── Public release pages ────────────────────────────────
    const APP_ID_RE = /^app_[0-9A-HJKMNP-TV-Z]{26}$/;
    r.get('/apps/:app', (req, res, next) => {
        if (!APP_ID_RE.test(req.params.app)) return next();
        const list = releases.listForApp(req.params.app);
        const t = trust.get(req.params.app);
        const hist = trust.history(req.params.app);
        page(req, res, {
            index: list.length > 0, cache: PUBLIC_CACHE, title: list[0] ? list[0].name : req.params.app,
            crumbs: [{ label: 'Apps' }, { label: req.params.app }],
            body: html`<h1>${list[0] ? list[0].name : 'App'} <small><code>${req.params.app}</code></small></h1>
<p>Trust tier: ${badge(t.tier)} ${t.note ? html`<span class="muted">— ${t.note}</span>` : ''}</p>
<p class="muted small">Trust tiers (<a href="/docs/adr/ADR-013">ADR-013</a>: unreviewed, reviewed, first-party) are metadata. They change defaults and discovery, never a grant check: what an app may do comes only from its grants in OpenVibe.Network.</p>
<h2>Releases</h2>
${table(['Version', 'Kind', 'Environment', 'Status', 'Published', 'Compatibility'], list.map((x) => [
                html`<a href="/releases/${x.id}">${x.version}</a>`, x.kind, x.environment, statusBadge(x.status), time(x.published_at),
                Object.entries(x.compatibility).map(([k, v]) => `${k} ${v}`).join('; '),
            ]), { empty: 'No public releases.' })}
${hist.length ? html`<h2>Trust history</h2>${table(['When', 'Change', 'Note'], hist.map((h) => [time(h.set_at), `${h.from_tier} → ${h.to_tier}`, h.note]))}` : ''}`,
        });
    });

    r.get('/releases/:id', async (req, res, next) => {
        const rel = releases.get(req.params.id);
        if (!rel) return next();
        if (rel.status === 'draft') {
            // Drafts are visible to members of the app's project only — as Network reports it.
            let member = false;
            if (req.viewer.kind === 'user') {
                try { await sso.asViewer(req, res, (t) => network.projects.app(t, rel.project_id, rel.app_id)); member = true; } catch { member = false; }
            }
            if (!member) return next();
        }
        const m = releases.manifestOf(rel.manifest_id);
        const signedIn = req.viewer.kind === 'user';
        page(req, res, {
            index: rel.status === 'published', cache: rel.status === 'draft' ? null : PUBLIC_CACHE, title: `${rel.name} ${rel.version}`,
            crumbs: [{ label: 'Apps' }, { label: rel.app_id, href: `/apps/${rel.app_id}` }, { label: rel.version }],
            body: html`<h1>${rel.name} <small>${rel.version}</small> ${statusBadge(rel.status)}</h1>
${req.query.done ? notice(`Release ${req.query.done}.`, 'ok') : ''}
<dl class="facts"><dt>Release</dt><dd>${code(rel.id)}</dd><dt>App</dt><dd><a href="/apps/${rel.app_id}">${rel.app_id}</a> (${rel.environment})</dd>
<dt>Kind</dt><dd>${rel.kind} ${code(rel.subject_id)}</dd><dt>Trust tier</dt><dd>${rel.trust.tier} <span class="muted small">(metadata only)</span></dd>
<dt>Compatibility</dt><dd>${Object.entries(rel.compatibility).map(([k, v]) => html`<code>${k} ${v}</code> `)}</dd>
<dt>Created</dt><dd>${time(rel.created_at)}</dd>${rel.published_at ? html`<dt>Published</dt><dd>${time(rel.published_at)}</dd>` : ''}
${rel.deprecated_at ? html`<dt>Deprecated</dt><dd>${time(rel.deprecated_at)}: ${rel.deprecation_reason}${rel.replacement ? html` — use <a href="/releases/${rel.replacement}">${rel.replacement}</a>` : ''}</dd>` : ''}
${rel.revoked_at ? html`<dt>Revoked</dt><dd>${time(rel.revoked_at)}: ${rel.revocation_reason}</dd>` : ''}</dl>
${rel.notes ? html`<h2>Notes</h2><p>${rel.notes}</p>` : ''}
<h2>Manifest</h2><p class="muted small">Validated with openvibe-contracts ${m ? m.contracts_version : '?'}.</p><pre><code>${m ? JSON.stringify(m.body, null, 2) : ''}</code></pre>
${signedIn ? releaseActions(req, rel) : ''}
<h2>History</h2>${table(['When', 'Action', 'By'], releases.log(rel.id).map((l) => [time(l.at), l.action, l.actor]))}`,
        });
    });

    function releaseActions(req, rel) {
        const csrf = csrfToken(config, req.viewer);
        const f = (action, label, extra = '') => html`<form method="post" action="/releases/${rel.id}/${action}" class="stack inline-box">${csrfField(csrf)}${raw(extra)}<button type="submit">${label}</button></form>`;
        const out = [];
        if (rel.status === 'draft') out.push(f('publish', 'Publish this release'));
        if (rel.status === 'published') out.push(f('deprecate', 'Deprecate', '<label>Why (public) <input name="reason" required maxlength="500"></label><label>Replacement release id (optional) <input name="replacement" pattern="rel_[0-9A-HJKMNP-TV-Z]{26}"></label>'));
        if (rel.status !== 'revoked') out.push(f('revoke', 'Revoke', '<label>Why (public) <input name="reason" required maxlength="500"></label><label><input type="checkbox" name="confirm" value="1" required> Revoking cannot be undone</label>'));
        return out.length ? html`<h2>Manage</h2><p class="muted small">Network decides whether you may: developer+ for sandbox apps, admin+ for production apps.</p>${out}` : '';
    }

    // ── Staff: trust tiers (metadata) ───────────────────────
    r.get('/staff', (req, res) => {
        if (!req.viewer.staff) return page(req, res, { title: 'Staff', body: html`<h1>Staff only</h1><p>Trust tiers are set by Codes staff.</p>` }, req.viewer.kind === 'user' ? 403 : 401);
        page(req, res, {
            title: 'Staff: trust tiers', crumbs: [{ label: 'Staff' }],
            body: html`<h1>Trust tiers</h1>${req.query.done ? notice('Saved.', 'ok') : ''}
<p>Tiers follow <a href="/docs/adr/ADR-013">ADR-013</a>: <code>unreviewed</code> (the default), <code>reviewed</code>, <code>first-party</code>. Metadata only: a tier never grants, allows or bypasses anything. Grants and allowances are set in Network.</p>
<form method="post" action="/staff/trust" class="stack">${csrfField(csrfToken(config, req.viewer))}
<label>App id <input name="app_id" required pattern="app_[0-9A-HJKMNP-TV-Z]{26}"></label>
<label>Tier <select name="tier">${trust.TIERS.map((t) => html`<option>${t}</option>`)}</select></label>
<label>Note (public) <input name="note" required maxlength="500"></label><button type="submit">Set tier</button></form>
<h2>Set tiers</h2>${table(['App', 'Tier', 'Note', 'By', 'When'], trust.listSet().map((t) => [html`<a href="/apps/${t.app_id}">${t.app_id}</a>`, t.tier, t.note, t.set_by, time(t.set_at)]))}`,
        });
    });
    r.post('/staff/trust', form, (req, res) => {
        if (!req.viewer.staff || !sameOrigin(config, req) || !checkCsrf(config, req.viewer, req.body && req.body.csrf)) return page(req, res, { title: 'Forbidden', body: html`<h1>Forbidden</h1>` }, 403);
        try {
            trust.set({ appId: req.body.app_id, tier: req.body.tier, note: req.body.note, actor: { staff: true, label: `user:${req.viewer.subject}` } });
            res.redirect(303, '/staff?done=1');
        } catch (err) {
            page(req, res, { title: 'Staff', body: problemBox({ status: err.status || 422, code: err.code || 'trust.invalid', detail: err.message }) }, err.status || 422);
        }
    });

    // ── Discovery ───────────────────────────────────────────
    r.get('/robots.txt', (req, res) => {
        res.set('Cache-Control', 'public, max-age=3600').type('text/plain').send([
            'User-agent: *', 'Disallow: /projects', 'Disallow: /auth/', 'Disallow: /oauth/test-callback', 'Disallow: /staff', 'Disallow: /api/',
            'Allow: /', `Sitemap: ${config.baseUrl}/sitemap.xml`, '',
        ].join('\n'));
    });
    r.get('/sitemap.xml', (req, res) => {
        const urls = ['/', '/docs', '/docs/api', '/docs/updates', '/docs/contracts', '/docs/capabilities', '/docs/events', '/docs/services', '/docs/billing', '/docs/limits', '/docs/tools', '/docs/sdk', '/oauth', '/tools/webhooks', '/manifests/validate',
            '/policy', '/policy/rfc', '/policy/compatibility', '/policy/licensing', '/policy/transparency',
            ...governance.filter((g) => !g.draft).map((g) => `/policy/${g.slug}`),
            ...docs.contracts.map((c) => `/docs/contracts/${c.id}`), ...docs.capabilities.map((c) => `/docs/capabilities/${c.id}`),
            ...require('openvibe-contracts').openapi.index().map((x) => `/docs/api/${x.service}`),
            ...docs.sdk.map((m) => `/docs/sdk/${m.slug}`), ...docs.adrs.map((a) => `/docs/adr/${a.id}`)];
        const x = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        res.set('Cache-Control', 'public, max-age=3600').type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${x(config.baseUrl + u)}</loc></url>`).join('\n')}\n</urlset>\n`);
    });

    return r;
}

const statusBadge = (s) => badge(s, s === 'published' ? 'ok' : (s === 'revoked' ? 'bad' : (s === 'deprecated' ? 'warn' : '')));

module.exports = { createPageRoutes, statusBadge, GOVERNANCE };
