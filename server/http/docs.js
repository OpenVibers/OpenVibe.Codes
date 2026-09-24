'use strict';

/**
 * Generated documentation pages. Every page states the package versions it was generated from and
 * renders ONLY what the pinned packages (or, for the service registry, the Network) say.
 *
 *   /docs                       index + versions
 *   /docs/contracts[/:id]       catalog; one page per contract: field table, fixtures, raw schema
 *   /docs/contracts/:id.json    the schema itself
 *   /docs/capabilities[/:id]    capability catalog; grantable (public/partner, active) highlighted
 *   /docs/events                event types from the service manifests
 *   /docs/services              the Network's registry with health as reported (never invented)
 *   /docs/sdk[/:module]         SDK reference from its .d.ts files
 *   /docs/adr/:id               ADRs as published in openvibe-contracts
 */
const { asyncRouter } = require('./router');
const { html, raw, table, code, badge, time, problemBox } = require('../render/html');
const { send } = require('../render/layout');
const { markdown } = require('../render/markdown');

function createDocsRoutes(ctx) {
    const { docs, config, network } = ctx;
    const r = asyncRouter();
    const PUBLIC_CACHE = 'public, max-age=300';

    const tagNote = (tag, version) => (tag !== `v${version}` ? html` (tag ${tag})` : '');
    const versions = () => html`<p class="versions">Generated at ${time(docs.generatedAt)} from
<a href="https://github.com/OpenVibers/OpenVibe.Contracts/tree/${docs.contractsTag}"><code>openvibe-contracts v${docs.contractsVersion}</code></a>${tagNote(docs.contractsTag, docs.contractsVersion)} and
<a href="https://github.com/OpenVibers/OpenVibe.SDK/tree/${docs.sdkTag}"><code>openvibe-sdk v${docs.sdkVersion}</code></a>${tagNote(docs.sdkTag, docs.sdkVersion)}.</p>`;
    const page = (req, res, o, status = 200) => send(res, status, { index: true, cache: PUBLIC_CACHE, viewer: req.viewer, config, path: req.originalUrl, ...o });

    r.get('/', (req, res) => {
        const grantable = docs.capabilities.filter((c) => c.grantable).length;
        page(req, res, {
            title: 'Docs',
            description: `OpenVibe platform reference generated from openvibe-contracts v${docs.contractsVersion} and openvibe-sdk v${docs.sdkVersion}.`,
            crumbs: [{ label: 'Docs' }],
            body: html`<h1>Platform reference</h1>${versions()}
<p>Nothing on these pages is written by hand: each one is rendered from the published packages above when Codes starts, so it always matches what the platform runs against. If something is missing here, it is not part of the public surface yet (<a href="/policy/compatibility">why</a>).</p>
<ul class="cards">
<li><a href="/docs/contracts"><strong>Contracts</strong></a><span>${docs.contracts.length} JSON Schemas with fields, examples and versions</span></li>
<li><a href="/docs/capabilities"><strong>Capabilities</strong></a><span>${docs.capabilities.length} capabilities; ${grantable} can be granted to apps</span></li>
<li><a href="/docs/events"><strong>Events</strong></a><span>${docs.events.length} event types services declare they produce</span></li>
<li><a href="/docs/services"><strong>Services</strong></a><span>the registry as OpenVibe.Network reports it, with health</span></li>
<li><a href="/docs/tools"><strong>Tools API</strong></a><span>every OpenVibe tool you can call from code, from the live registry</span></li>
<li><a href="/docs/sdk"><strong>SDK</strong></a><span>${docs.sdk.length} modules of openvibe-sdk from their type definitions</span></li>
<li><a href="/policy/rfc"><strong>Decisions</strong></a><span>${docs.adrs.length} architecture decision records</span></li>
</ul>
<h2>Install</h2>
<pre><code>npm install https://codeload.github.com/OpenVibers/OpenVibe.SDK/tar.gz/refs/tags/${docs.sdkTag}
npm install https://codeload.github.com/OpenVibers/OpenVibe.Contracts/tar.gz/refs/tags/${docs.contractsTag}</code></pre>
<p>The SDK is ${docs.sdkLicense}; the contracts are ${docs.contractsLicense}. The SDK release is tested against contracts <code>${docs.sdkContractsRange || 'n/a'}</code>.</p>`,
        });
    });

    // ── Contracts ───────────────────────────────────────────
    r.get('/contracts', (req, res) => {
        page(req, res, {
            title: 'Contracts',
            crumbs: [{ label: 'Docs', href: '/docs' }, { label: 'Contracts' }],
            body: html`<h1>Contracts</h1>${versions()}
<p>A contract id is permanent. Minor versions only add optional fields; a breaking change is a new major with a deprecation window (<a href="/policy/compatibility">policy</a>).</p>
${table(['Contract', 'Version', 'Owner', 'Visibility', 'Status', 'Compatibility'], docs.contracts.map((c) => [
                html`<a href="/docs/contracts/${c.id}">${c.id}</a>${c.deprecation ? html` ${badge('deprecated', 'warn')}` : ''}`,
                c.version, c.owner, c.visibility, c.status, c.compatibility,
            ]))}`,
        });
    });

    r.get('/contracts/:id.json', (req, res, next) => {
        const c = docs.contract(req.params.id);
        if (!c) return next();
        res.set('Cache-Control', PUBLIC_CACHE).type('application/schema+json').send(JSON.stringify(c.schema, null, 2));
    });

    r.get('/contracts/:id', (req, res, next) => {
        const c = docs.contract(req.params.id);
        if (!c) return next();
        const major = c.version.split('.')[0];
        const fixture = (f, ok) => html`<details${ok ? raw(' open') : ''}><summary>${ok ? 'Valid' : 'Rejected'}: ${f.name}</summary><pre><code>${JSON.stringify(f.body, null, 2)}</code></pre></details>`;
        page(req, res, {
            title: `${c.id}@${major}`,
            description: c.description.slice(0, 200),
            crumbs: [{ label: 'Docs', href: '/docs' }, { label: 'Contracts', href: '/docs/contracts' }, { label: c.id }],
            body: html`<h1>${c.title} <small><code>${c.id}@${major}</code></small></h1>${versions()}
<dl class="facts"><dt>Version</dt><dd>${c.version}</dd><dt>Owner</dt><dd>${c.owner}</dd><dt>Visibility</dt><dd>${c.visibility}</dd><dt>Status</dt><dd>${c.status}</dd>
<dt>Compatibility</dt><dd>${c.compatibility}</dd>${c.adr ? html`<dt>Decision</dt><dd><a href="/docs/adr/${c.adr}">${c.adr}</a></dd>` : ''}
<dt>Schema</dt><dd><a href="/docs/contracts/${c.id}.json"><code>${c.$id}</code></a></dd></dl>
${c.deprecation ? html`<div class="notice warn">Deprecated since ${c.deprecation.since}; use ${c.deprecation.replacement}. Removed after ${c.deprecation.removeAfter}. ${c.deprecation.reason || ''}</div>` : ''}
<p>${c.description}</p>
<h2>Fields</h2>
${table(['Field', 'Type', 'Required', 'Description', 'Constraints'], c.fields.map((f) => [
                code(f.path),
                f.refId ? html`<a href="/docs/contracts/${f.refId}">${f.refId}</a>` : (f.ref ? code(f.ref) : f.type),
                f.required ? 'yes' : '',
                f.description,
                f.constraints.length ? html`<ul class="plain">${f.constraints.map((x) => html`<li><code>${x}</code></li>`)}</ul>` : '',
            ]), { empty: 'This schema has no named fields.' })}
<h2>Examples</h2>
<p class="muted">From the contract's own test fixtures: valid ones validate, rejected ones must fail.</p>
${c.fixtures.valid.map((f) => fixture(f, true))}${c.fixtures.invalid.map((f) => fixture(f, false))}
${!c.fixtures.valid.length && !c.fixtures.invalid.length ? html`<p class="muted">No fixtures ship with this contract.</p>` : ''}
<h2>Validate</h2>
<pre><code>const contracts = require('openvibe-contracts');
contracts.validate('${c.id}@${major}', value);   // { valid, errors: [{ path, message }] }</code></pre>`,
        });
    });

    // ── Capabilities ────────────────────────────────────────
    r.get('/capabilities', (req, res) => {
        const owners = [...new Set(docs.capabilities.map((c) => c.owner))].sort();
        const filter = typeof req.query.owner === 'string' && owners.includes(req.query.owner) ? req.query.owner : null;
        const onlyGrantable = req.query.grantable === '1';
        const list = docs.capabilities.filter((c) => (!filter || c.owner === filter) && (!onlyGrantable || c.grantable));
        page(req, res, {
            title: 'Capabilities',
            crumbs: [{ label: 'Docs', href: '/docs' }, { label: 'Capabilities' }],
            body: html`<h1>Capabilities</h1>${versions()}
<p>A capability is an action a principal may invoke, checked at the owning service against the token's grants. <strong>Highlighted rows can be granted to apps</strong>: only active capabilities whose visibility is <code>public</code> (or <code>partner</code>, when staff put one in a project's allowance). <code>first-party</code> and <code>internal</code> capabilities are never granted to apps.</p>
<form method="get" action="/docs/capabilities" class="inline-form"><label>Owner <select name="owner"><option value="">all</option>${owners.map((o) => html`<option value="${o}"${o === filter ? raw(' selected') : ''}>${o}</option>`)}</select></label>
<label><input type="checkbox" name="grantable" value="1"${onlyGrantable ? raw(' checked') : ''}> grantable to apps only</label> <button type="submit">Filter</button></form>
${table(['Capability', 'Owner', 'Visibility', 'Status', 'Description', 'Quota class'], list.map((c) => [
                html`<a href="/docs/capabilities/${c.id}" class="${c.grantable ? 'grantable' : ''}">${c.id}</a>${c.grantable ? html` ${badge('grantable', 'ok')}` : ''}`,
                c.owner, c.visibility, c.status, c.description || '', c.quotaClass,
            ]), { cls: 'caps' })}`,
        });
    });

    r.get('/capabilities/:id', (req, res, next) => {
        const c = docs.capability(req.params.id);
        if (!c) return next();
        page(req, res, {
            title: c.id,
            description: (c.description || '').slice(0, 200),
            crumbs: [{ label: 'Docs', href: '/docs' }, { label: 'Capabilities', href: '/docs/capabilities' }, { label: c.id }],
            body: html`<h1><code>${c.id}</code></h1>${versions()}
${c.grantable ? html`<div class="notice ok">Grantable to apps: request it for an app on its project page. Network approves it only inside the project's allowance.</div>`
                : html`<div class="notice">Not grantable to apps (${c.status}, ${c.visibility}).</div>`}
<p>${c.description || ''}</p>
<dl class="facts"><dt>Owner</dt><dd>${c.owner} (token audience <code>openvibe.${c.owner}</code>)</dd><dt>Version</dt><dd>${c.version}</dd>
<dt>Status</dt><dd>${c.status}</dd><dt>Visibility</dt><dd>${c.visibility}</dd>
<dt>Resource constraints</dt><dd>${c.resourceConstraints.join(', ') || 'none'}</dd><dt>Quota class</dt><dd>${c.quotaClass}</dd>
<dt>Permissions</dt><dd>${c.permissions.join(', ') || '—'}</dd>
${c.inputSchema ? html`<dt>Input</dt><dd>${docs.contract(c.inputSchema.split('@')[0]) ? html`<a href="/docs/contracts/${c.inputSchema.split('@')[0]}">${c.inputSchema}</a>` : c.inputSchema}</dd>` : ''}
${c.outputSchema ? html`<dt>Output</dt><dd>${c.outputSchema}</dd>` : ''}
<dt>Events</dt><dd>${c.events.length ? c.events.join(', ') : '—'}</dd>
<dt>Implemented by</dt><dd>${(c.implementedBy || []).length ? html`<ul class="plain">${c.implementedBy.map((x) => html`<li><code>${x}</code></li>`)}</ul>` : '—'}</dd></dl>`,
        });
    });

    // ── Events ──────────────────────────────────────────────
    // Event types that have a payload contract (events/payloads/<type>.v<major>.json in openvibe-contracts).
    const payloadIds = new Set(require('openvibe-contracts').catalog.filter((c) => String(c.schema || '').startsWith('events/payloads/')).map((c) => c.id));
    r.get('/events', (req, res) => {
        page(req, res, {
            title: 'Event types',
            crumbs: [{ label: 'Docs', href: '/docs' }, { label: 'Events' }],
            body: html`<h1>Event types</h1>${versions()}
<p>Every event type a service manifest declares it produces, and who declares they consume it. Events travel as <a href="/docs/contracts/events.event-envelope">events.event-envelope@1</a>; deliveries are signed (<a href="/tools/webhooks">webhook tester</a>). Each event's payload has its own contract where one is published (named after the event type, version = the envelope's <code>version</code>).</p>
${table(['Event type', 'Payload', 'Produced by', 'Consumed by'], docs.events.map((e) => [code(e.type), payloadIds.has(e.type) ? html`<a href="/docs/contracts/${e.type}">schema</a>` : html`<span class="muted">planned</span>`, e.producers.join(', '), e.consumers.join(', ') || '—']))}`,
        });
    });

    // ── Services (live registry) ────────────────────────────
    r.get('/services', async (req, res) => {
        let services = null;
        let problem = null;
        try { services = await network.registry.services(); } catch (err) { problem = network.problemOf(err); }
        const rows = (services || []).map((s) => {
            const rt = s.runtime || {};
            return [
                html`<strong>${s.name || s.id}</strong><br><code>${s.id}</code>`,
                s.status,
                (s.domains || []).join(', ') || '—',
                html`${badge(rt.status || 'unknown', rt.status === 'up' ? 'ok' : (rt.status === 'down' ? 'bad' : ''))}${rt.reason ? html`<br><span class="small muted">${rt.reason}</span>` : ''}`,
                rt.checked_at ? time(rt.checked_at) : '—',
                (s.capabilities || []).length,
            ];
        });
        send(res, problem ? 502 : 200, {
            index: true, cache: 'public, max-age=30', viewer: req.viewer, config, path: req.originalUrl,
            title: 'Services',
            crumbs: [{ label: 'Docs', href: '/docs' }, { label: 'Services' }],
            body: html`<h1>Service registry</h1>
<p>As OpenVibe.Network's registry reports it (<code>GET /api/v1/registry/services</code>), fetched at most every ${Math.round(config.registryTtlMs / 1000)} s. Health is Network's own check with the time it ran; a stale or missing check reads <em>unknown</em>, never up.</p>
${problem ? html`${problemBox(problem, { title: 'The registry could not be read' })}
<p>The service manifests published in <code>openvibe-contracts v${docs.contractsVersion}</code> are below, without health (nothing here says whether they run).</p>
${table(['Service', 'Status (manifest)', 'Domains'], docs.services.map((s) => [html`<strong>${s.name}</strong><br><code>${s.id}</code>`, s.status, (s.domains || []).join(', ') || '—']))}`
                : table(['Service', 'Maturity', 'Domains', 'Health (as reported)', 'Checked', 'Capabilities'], rows)}`,
        });
    });

    // ── Tools (live registry from OpenVibe.Tools, ADR-027) ──────────
    const TOOLS_URL = (process.env.OV_TOOLS_INTERNAL_URL || 'http://127.0.0.1:4001').replace(/\/$/, '');
    let toolsCache = { at: 0, list: null };
    r.get('/tools', async (req, res) => {
        let list = toolsCache.list; let problem = null;
        if (!list || Date.now() - toolsCache.at > 300_000) {
            try {
                const out = await fetch(`${TOOLS_URL}/api/v1/tools`, { headers: { Host: 'openvibe.tools', Accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
                if (!out.ok) throw new Error(`Tools answered ${out.status}`);
                list = (await out.json()).tools || [];
                toolsCache = { at: Date.now(), list };
            } catch (err) { problem = { code: 'codes.tools_unavailable', detail: err.message }; }
        }
        const api = (list || []).filter((t) => t.api && t.status !== 'unavailable');
        const families = [...new Set(api.map((t) => t.family))].sort();
        send(res, problem && !list ? 502 : 200, {
            index: true, cache: 'public, max-age=60', viewer: req.viewer, config, path: req.originalUrl,
            title: 'Tools API',
            crumbs: [{ label: 'Docs', href: '/docs' }, { label: 'Tools' }],
            body: html`<h1>Tools API</h1>
<p>${api.length} tools on <a href="https://openvibe.tools">OpenVibe.Tools</a> can be called from code: <code>POST https://openvibe.tools/api/v1/tools/{id}/run</code> (capability <code>tools.tool.run</code>; anonymous calls run on the lowest tier), long work as jobs at <code>/api/v1/jobs/{id}</code>. OpenAPI: <a href="https://openvibe.tools/api/v1/openapi.json">openapi.json</a> · guide: <a href="https://openvibe.tools/developers">openvibe.tools/developers</a> · SDK: <code>openvibe-sdk/tools</code>.</p>
${problem && !list ? html`${problemBox(problem, { title: 'The Tools registry could not be read' })}` : ''}
${families.map((f) => html`<h2>${f}</h2>${table(['Tool', 'Runs as', 'Access', 'Inputs'], api.filter((t) => t.family === f).map((t) => [
                html`<a href="${t.docs || `https://openvibe.tools/tool/${t.id}`}"><strong>${t.name}</strong></a><br><code>${t.id}</code>`,
                t.execution === 'job' ? 'job' : 'direct',
                t.auth && t.auth.anonymous ? 'anonymous or token' : (t.auth && t.auth.capability === 'tools.net.probe' ? 'partner token (tools.net.probe)' : 'session or token'),
                t.files ? `files (${t.files.min}-${t.files.max})` : 'JSON',
            ]))}`)}`,
        });
    });

    // ── SDK ─────────────────────────────────────────────────
    r.get('/sdk', (req, res) => {
        page(req, res, {
            title: 'SDK reference',
            crumbs: [{ label: 'Docs', href: '/docs' }, { label: 'SDK' }],
            body: html`<h1>openvibe-sdk v${docs.sdkVersion}</h1>${versions()}
<p><strong>If a capability is not in the SDK, it is not public.</strong> Apps call services through the SDK; a route with no SDK wrapper is internal and can change without notice.</p>
${table(['Module', 'Where', 'Declarations', 'Types file'], docs.sdk.map((m) => [
                html`<a href="/docs/sdk/${m.slug}"><code>${m.name}</code></a>`, m.browser, m.declarations.length, code(m.typesFile),
            ]))}`,
        });
    });

    r.get('/sdk/:module', (req, res, next) => {
        const m = docs.sdk.find((x) => x.slug === req.params.module);
        if (!m) return next();
        page(req, res, {
            title: m.name,
            crumbs: [{ label: 'Docs', href: '/docs' }, { label: 'SDK', href: '/docs/sdk' }, { label: m.name }],
            body: html`<h1><code>${m.name}</code></h1>${versions()}
<p class="muted">From <code>${m.typesFile}</code> (${m.browser}). Declarations are shown verbatim.</p>
<nav class="toc"><ul class="plain">${m.declarations.map((d, i) => html`<li><a href="#d${i}">${d.kind} ${d.name}</a></li>`)}</ul></nav>
${m.declarations.map((d, i) => html`<section id="d${i}" class="decl"><h2><small>${d.kind}</small> ${d.name}</h2>${d.doc ? html`<p>${d.doc}</p>` : ''}<pre><code>${d.text}</code></pre></section>`)}`,
        });
    });

    r.get('/adr/:id', (req, res, next) => {
        const a = docs.adrs.find((x) => x.id === req.params.id);
        if (!a) return next();
        page(req, res, {
            title: a.title,
            crumbs: [{ label: 'Policy', href: '/policy' }, { label: 'Decisions', href: '/policy/rfc' }, { label: a.id }],
            body: html`<p class="versions">Published in <code>openvibe-contracts v${docs.contractsVersion}</code> (<code>docs/adr/${a.file}</code>), rendered as is.</p>
<article class="prose">${raw(markdown(a.markdown, { headingOffset: 0 }))}</article>`,
        });
    });

    return r;
}

module.exports = { createDocsRoutes };
