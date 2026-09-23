'use strict';

/**
 * The signed-in portal: projects, members, apps, credentials, grants, quotas and audit — all over
 * OpenVibe.Network's /api/v1/projects API with the person's own access token (ADR-014: Network owns
 * every one of these; Codes stores none of them). Plus the Codes-owned parts that hang off an app:
 * releases (manifest editor, publish/deprecate/revoke) and playgrounds.
 *
 * Honesty rules:
 *   - a Network failure is shown as Network answered it (HTTP status, problem code, detail, request
 *     id), with the same status on the page; an unreachable Network is a 502, never an empty list
 *   - a client secret appears only in the response to the create/rotate that produced it, with
 *     Cache-Control: no-store, and is never stored, logged or redirected through a URL
 *   - quotas are "recorded limit — enforced by <service>": Network records, the owner enforces
 *   - the scope editor offers only capabilities apps can be granted (public, or partner when in the
 *     allowance) and refuses to forward anything else
 */
const express = require('express');
const { asyncRouter } = require('./router');
const Busboy = require('busboy');
const { html, raw, table, code, badge, time, notice, csrfField, problemBox } = require('../render/html');
const { send } = require('../render/layout');
const { csrfToken, checkCsrf, sameOrigin } = require('../auth/forms');
const manifestsLib = require('../domain/manifests');
const { RANK, ReleaseError } = require('../domain/releases');
const { validationResult } = require('./tools');
const { statusBadge } = require('./pages');

const PRJ_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const APP_RE = /^app_[0-9A-HJKMNP-TV-Z]{26}$/;
const CRD_RE = /^crd_[0-9A-HJKMNP-TV-Z]{26}$/;
const USR_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const CAP_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}$/;
const REL_RE = /^rel_[0-9A-HJKMNP-TV-Z]{26}$/;

const atLeast = (role, need) => Boolean(role) && RANK[role] >= RANK[need];

function createPortalRoutes(ctx) {
    const { config, docs, network, sso, releases, trust, playground, log } = ctx;
    const r = asyncRouter();
    const form = express.urlencoded({ extended: false, limit: '96kb' });

    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    const csrf = (req) => csrfToken(config, req.viewer);

    function problemPage(req, res, problem, { title = 'Request failed', back = null } = {}) {
        page(req, res, {
            title,
            body: html`<h1>${title}</h1>${problemBox(problem, { title: problem.code && problem.code.startsWith('network.') ? 'OpenVibe.Network could not be reached' : `OpenVibe.Network answered ${problem.status}` })}
${back ? html`<p><a href="${back}">Back</a></p>` : ''}`,
        }, problem.status >= 400 && problem.status < 600 ? problem.status : 502);
    }

    /** Run a Network call as the viewer. → { ok, data } | { ok: false, problem } */
    async function net(req, res, fn) {
        try {
            return { ok: true, data: await sso.asViewer(req, res, fn) };
        } catch (err) {
            const p = network.problemOf(err);
            log.warn(`[Codes] network ${p.status} ${p.code}${p.requestId ? ` (${p.requestId})` : ''}`);
            return { ok: false, problem: p };
        }
    }

    // Everything here needs a signed-in person with a canonical subject.
    r.use((req, res, next) => {
        if (req.viewer.kind !== 'user') {
            return page(req, res, {
                title: 'Sign in',
                body: html`<h1>Sign in to manage projects</h1><p>Projects and apps belong to your OpenVibe account and live in OpenVibe.Network.</p>
<p><a class="button" href="/auth/login?next=${encodeURIComponent(req.originalUrl)}">Sign in with OpenVibe</a></p>`,
            }, 401);
        }
        if (!req.viewer.subject) return page(req, res, { title: 'Account', body: html`<h1>Your account has no subject id yet</h1><p>Sign out and in again; Network assigns one on sign-in.</p>` }, 409);
        next();
    });
    // Every state change: same-origin and a valid form token.
    const guard = (req, res, next) => {
        if (!sameOrigin(config, req) || !checkCsrf(config, req.viewer, req.body && req.body.csrf)) {
            return page(req, res, { title: 'Form expired', body: html`<h1>This form has expired</h1><p>Go back, reload the page and try again.</p>` }, 403);
        }
        next();
    };
    const idParams = (req, res, next) => {
        const { project, app } = req.params;
        if ((project && !PRJ_RE.test(project)) || (app && !APP_RE.test(app))) return page(req, res, { title: 'Not found', body: html`<h1>Not found</h1>` }, 404);
        next();
    };

    // ── Projects ────────────────────────────────────────────
    async function projectsPage(req, res, { problem = null, status = 200 } = {}) {
        const got = await net(req, res, (t) => network.projects.list(t, { all: req.viewer.staff && req.query.all === '1' }));
        if (!got.ok) return problemPage(req, res, got.problem, { title: 'Your projects' });
        const list = got.data.projects || [];
        page(req, res, {
            title: 'Your projects', crumbs: [{ label: 'Projects' }],
            body: html`<h1>Your projects</h1>${problem ? problemBox(problem, { title: `OpenVibe.Network answered ${problem.status}` }) : ''}
${table(['Project', 'Your role', 'Environments', 'Apps', 'Created'], list.map((p) => [
                html`<a href="/projects/${p.id}">${p.name}</a><br><code class="small">${p.id}</code>${p.archived_at ? html` ${badge('archived', 'bad')}` : ''}`,
                p.role || (req.viewer.staff ? 'staff' : '—'), (p.environments || []).join(', '), p.counts ? p.counts.apps : '—', time(p.created_at),
            ]), { empty: 'You are not a member of any project yet.' })}
<h2>Create a project</h2>
<form method="post" action="/projects" class="inline-form">${csrfField(csrf(req))}
<label>Name <input name="name" required maxlength="80"></label><button type="submit">Create</button></form>
<p class="muted small">New projects are sandbox-only. OpenVibe staff enable production and set which capabilities a project's apps may hold (its allowance).</p>`,
        }, status);
    }
    r.get('/', (req, res) => projectsPage(req, res));
    r.post('/', form, guard, async (req, res) => {
        const got = await net(req, res, (t) => network.projects.create(t, { name: String(req.body.name || '') }));
        if (!got.ok) return projectsPage(req, res, { problem: got.problem, status: got.problem.status });
        res.redirect(303, `/projects/${got.data.id}`);
    });

    /** Project + its role; renders the problem and returns null when Network refuses. */
    async function loadProject(req, res) {
        const got = await net(req, res, (t) => network.projects.get(t, req.params.project));
        if (!got.ok) { problemPage(req, res, got.problem, { title: 'Project', back: '/projects' }); return null; }
        return got.data;
    }

    r.get('/:project', idParams, async (req, res) => {
        const project = await loadProject(req, res);
        if (!project) return;
        const [members, apps, quotas] = await Promise.all([
            net(req, res, (t) => network.projects.members(t, project.id)),
            net(req, res, (t) => network.projects.apps(t, project.id)),
            net(req, res, (t) => network.projects.quotas(t, project.id)),
        ]);
        const role = project.role;
        const archived = Boolean(project.archived_at);
        const c = csrf(req);
        const envs = project.environments || ['sandbox'];
        const assignable = role === 'owner' ? ['admin', 'developer', 'viewer'] : (role === 'admin' ? ['developer', 'viewer'] : []);
        page(req, res, {
            title: project.name, crumbs: [{ label: 'Projects', href: '/projects' }, { label: project.name }],
            body: html`<h1>${project.name}</h1>${req.query.done ? notice(String(req.query.done).slice(0, 80), 'ok') : ''}
${archived ? notice('This project is archived: every app in it is revoked.', 'bad') : ''}
<dl class="facts"><dt>Project</dt><dd>${code(project.id)}</dd><dt>Your role</dt><dd>${role || (req.viewer.staff ? 'staff (not a member)' : '—')}</dd>
<dt>Environments</dt><dd>${envs.join(', ')}${project.environment_policy === 'sandbox' ? html` <span class="muted small">(production apps need staff to enable production for this project)</span>` : ''}</dd>
<dt>Allowance</dt><dd>${(project.allowance || []).length ? html`<ul class="plain">${project.allowance.map((id) => html`<li><a href="/docs/capabilities/${id}"><code>${id}</code></a></li>`)}</ul>` : html`<span class="muted">empty: staff decide which capabilities this project's apps may hold</span>`}</dd>
<dt>Created</dt><dd>${time(project.created_at)}</dd></dl>
${atLeast(role, 'admin') || req.viewer.staff ? html`<p><a href="/projects/${project.id}/audit">Audit log</a></p>` : ''}

<h2>Apps</h2>
${apps.ok ? table(['App', 'Environment', 'Type', 'Grants', 'Created'], (apps.data.apps || []).map((a) => [
                html`<a href="/projects/${project.id}/apps/${a.id}">${a.name}</a><br><code class="small">${a.id}</code>${a.revoked_at ? html` ${badge('revoked', 'bad')}` : ''}`,
                a.environment, a.client_type, (a.grants || []).length, time(a.created_at),
            ]), { empty: 'No apps yet.' }) : problemBox(apps.problem, { title: 'Apps could not be loaded' })}
${!archived && atLeast(role, 'developer') ? html`<h3>Add an app</h3>
<form method="post" action="/projects/${project.id}/apps" class="stack">${csrfField(c)}
<label>Name <input name="name" required maxlength="80"></label>
<label>Environment <select name="environment">${envs.map((e) => html`<option value="${e}"${e === 'production' && !atLeast(role, 'admin') ? raw(' disabled') : ''}>${e}${e === 'production' && !atLeast(role, 'admin') ? ' (admin+)' : ''}</option>`)}</select></label>
<label>Type <select name="type"><option value="confidential">confidential — has a client secret (server-side apps)</option><option value="public">public — no secret, authorization code + PKCE only</option></select></label>
<label>Redirect URIs (one per line; https, or http://localhost for sandbox apps) <textarea name="redirect_uris" rows="3" spellcheck="false" placeholder="${config.baseUrl}/oauth/test-callback"></textarea></label>
<button type="submit">Create app</button></form>` : ''}

<h2>Quotas</h2>
${quotas.ok ? html`${table(['Capability', 'Limit', 'Window', 'Unit', 'Enforcement'], (quotas.data.quotas || []).map((q) => [
                html`<a href="/docs/capabilities/${q.capability}"><code>${q.capability}</code></a>`, String(q.limit), q.window, q.unit,
                html`recorded limit — enforced by <code>${q.enforced_by || 'the owning service'}</code>`,
            ]), { empty: 'No quotas recorded for this project.' })}
<p class="muted small">${quotas.data.note || ''} Codes shows these limits; it does not enforce them, and no usage numbers are collected yet.</p>` : problemBox(quotas.problem, { title: 'Quotas could not be loaded' })}

<h2>Members</h2>
${members.ok ? table(['Member', 'Role', 'Added', ''], (members.data.members || []).map((m) => [
                html`${m.display_name || m.username || ''} ${m.username ? html`<span class="muted">@${m.username}</span>` : ''}<br><code class="small">${m.subject.id}</code>`,
                m.role, time(m.added_at),
                memberActions(project, role, m, c, req.viewer.subject, assignable),
            ])) : problemBox(members.problem, { title: 'Members could not be loaded' })}
${!archived && assignable.length ? html`<h3>Add a member</h3>
<form method="post" action="/projects/${project.id}/members" class="inline-form">${csrfField(c)}
<label>Username <input name="username" required maxlength="64"></label>
<label>Role <select name="role">${assignable.map((x) => html`<option>${x}</option>`)}</select></label><button type="submit">Add</button></form>` : ''}
${role === 'owner' && !archived ? html`<h2>Archive</h2><form method="post" action="/projects/${project.id}/archive" class="stack">${csrfField(c)}
<label><input type="checkbox" name="confirm" value="1" required> Archiving cannot be undone and revokes every app in the project</label><button type="submit" class="danger">Archive project</button></form>` : ''}`,
        });
    });

    function memberActions(project, role, m, c, me, assignable) {
        if (project.archived_at || m.role === 'owner') return '';
        const self = m.subject.id === me;
        const canChange = assignable.includes(m.role);
        return html`${canChange ? html`<form method="post" action="/projects/${project.id}/members/${m.subject.id}/role" class="inline-form">${csrfField(c)}
<select name="role" aria-label="Role">${assignable.map((x) => html`<option${x === m.role ? raw(' selected') : ''}>${x}</option>`)}</select><button type="submit">Change</button></form>` : ''}
${canChange || self ? html`<form method="post" action="/projects/${project.id}/members/${m.subject.id}/remove" class="inline-form">${csrfField(c)}<button type="submit">${self ? 'Leave' : 'Remove'}</button></form>` : ''}`;
    }

    const back = (req) => `/projects/${req.params.project}`;
    const after = (req, res, got, target, done) => {
        if (!got.ok) return problemPage(req, res, got.problem, { back: target });
        res.redirect(303, `${target}?done=${encodeURIComponent(done)}`);
    };

    r.post('/:project/members', idParams, form, guard, async (req, res) => {
        const username = String(req.body.username || '').trim().replace(/^@/, '');
        const got = await net(req, res, (t) => network.projects.addMember(t, req.params.project, { username, role: String(req.body.role || 'viewer') }));
        after(req, res, got, back(req), `Added ${username}`);
    });
    r.post('/:project/members/:subject/role', idParams, form, guard, async (req, res) => {
        if (!USR_RE.test(req.params.subject)) return problemPage(req, res, { status: 422, code: 'codes.invalid', detail: 'not a member subject' }, { back: back(req) });
        const got = await net(req, res, (t) => network.projects.updateMember(t, req.params.project, req.params.subject, { role: String(req.body.role || '') }));
        after(req, res, got, back(req), 'Role changed');
    });
    r.post('/:project/members/:subject/remove', idParams, form, guard, async (req, res) => {
        if (!USR_RE.test(req.params.subject)) return problemPage(req, res, { status: 422, code: 'codes.invalid', detail: 'not a member subject' }, { back: back(req) });
        const self = req.params.subject === req.viewer.subject;
        const got = await net(req, res, (t) => network.projects.removeMember(t, req.params.project, req.params.subject));
        if (got.ok && self) return res.redirect(303, '/projects');
        after(req, res, got, back(req), 'Member removed');
    });
    r.post('/:project/archive', idParams, form, guard, async (req, res) => {
        if (req.body.confirm !== '1') return problemPage(req, res, { status: 422, code: 'codes.confirm', detail: 'tick the box to confirm' }, { back: back(req) });
        const got = await net(req, res, (t) => network.projects.archive(t, req.params.project));
        after(req, res, got, back(req), 'Project archived');
    });

    r.get('/:project/audit', idParams, async (req, res) => {
        const project = await loadProject(req, res);
        if (!project) return;
        const before = /^\d+$/.test(String(req.query.before || '')) ? req.query.before : undefined;
        const got = await net(req, res, (t) => network.projects.audit(t, project.id, { before }));
        if (!got.ok) return problemPage(req, res, got.problem, { title: 'Audit log', back: back(req) });
        page(req, res, {
            title: `Audit · ${project.name}`, crumbs: [{ label: 'Projects', href: '/projects' }, { label: project.name, href: back(req) }, { label: 'Audit' }],
            body: html`<h1>Audit log</h1><p class="muted">Append-only, kept by OpenVibe.Network. Credential ids and last four characters only; never a secret.</p>
${table(['When', 'Actor', 'Action', 'Target', 'Detail', 'Event'], (got.data.entries || []).map((e) => [
                time(e.at), code(e.actor), e.action, e.target ? code(e.target) : '', html`<code class="small">${JSON.stringify(e.detail || {})}</code>`, e.event_type || '',
            ]))}
${got.data.next_before ? html`<p><a href="/projects/${project.id}/audit?before=${got.data.next_before}">Older</a></p>` : ''}`,
        });
    });

    // ── Apps ────────────────────────────────────────────────
    const redirectList = (text) => String(text || '').split(/\s+/).map((s) => s.trim()).filter(Boolean).slice(0, 11);

    /** The one page a client secret ever appears on. */
    function secretPage(req, res, { project, app, credential, rotated = false, previous = [] }) {
        res.set('Cache-Control', 'no-store');
        res.set('Pragma', 'no-cache');
        page(req, res, {
            title: 'Copy your client secret', scripts: ['js/copy.js'],
            crumbs: [{ label: 'Projects', href: '/projects' }, { label: project, href: `/projects/${project}` }, { label: app.name || app.id }],
            body: html`<h1>${rotated ? 'New client secret' : `${app.name} is ready`}</h1>
<div class="secret-box">
<label>client_id <input readonly value="${app.id}" id="client-id" autocomplete="off" spellcheck="false"></label>
<label>client_secret <input readonly value="${credential.client_secret}" id="client-secret" class="secret" autocomplete="off" spellcheck="false"></label>
<button type="button" class="copy" data-copy="#client-secret" hidden>Copy secret</button>
</div>
<div class="notice warn"><strong>You won't see this secret again.</strong> Copy it into your server's secret store now. Codes does not keep it and OpenVibe.Network stores only a hash (credential <code>${credential.id}</code>, ending <code>…${credential.hint}</code>). If you lose it, rotate the credential. Never put it in a browser or a repository.</div>
${rotated && previous.length ? html`<p>The previous secret${previous.length > 1 ? 's stay' : ' stays'} valid until ${previous.map((p) => html`${time(p.expires_at)} `)} so you can deploy the new one first.</p>` : ''}
<h2>Use it</h2>
<pre><code>const sdk = require('openvibe-sdk');
const client = sdk.createClient({
    tokenProvider: sdk.auth.createServiceTokenClient({ clientId: '${app.id}', clientSecret: process.env.OV_CLIENT_SECRET }),
});</code></pre>
<p><a class="button" href="/projects/${project}/apps/${app.id}">I have stored it — continue</a></p>`,
        });
    }

    r.post('/:project/apps', idParams, form, guard, async (req, res) => {
        const body = {
            name: String(req.body.name || ''), environment: String(req.body.environment || 'sandbox'),
            type: String(req.body.type || 'confidential'), redirect_uris: redirectList(req.body.redirect_uris),
        };
        const got = await net(req, res, (t) => network.projects.createApp(t, req.params.project, body));
        if (!got.ok) return problemPage(req, res, got.problem, { title: 'Create app', back: back(req) });
        const app = got.data;
        if (app.credential && app.credential.client_secret) return secretPage(req, res, { project: req.params.project, app, credential: app.credential });
        res.redirect(303, `/projects/${req.params.project}/apps/${app.id}?done=${encodeURIComponent('App created (public: no secret)')}`);
    });

    /** Capabilities the scope editor may offer: grantable to apps, per the pinned catalog AND Network. */
    function offered(catalog, project) {
        const allowance = new Set(project.allowance || []);
        return ((catalog && catalog.capabilities) || []).filter((c) => {
            if (!c || typeof c.id !== 'string' || !CAP_RE.test(c.id)) return false;
            const pinned = docs.capability(c.id);
            if (pinned && !pinned.grantable) return false;      // never offer what the contracts say is not grantable
            const vis = pinned ? pinned.visibility : c.visibility;
            if (vis === 'public') return true;
            if (vis === 'partner') return allowance.has(c.id);  // partner: only when staff put it in this allowance
            return false;
        }).map((c) => {
            const pinned = docs.capability(c.id);
            return {
                id: c.id, owner: c.owner || (pinned && pinned.owner), audience: c.audience || `openvibe.${c.owner}`,
                visibility: pinned ? pinned.visibility : c.visibility, description: c.description || (pinned && pinned.description) || '',
                inAllowance: allowance.has(c.id),
            };
        });
    }

    async function loadApp(req, res) {
        const [project, app] = await Promise.all([
            net(req, res, (t) => network.projects.get(t, req.params.project)),
            net(req, res, (t) => network.projects.app(t, req.params.project, req.params.app)),
        ]);
        if (!project.ok) { problemPage(req, res, project.problem, { title: 'Project', back: '/projects' }); return null; }
        if (!app.ok) { problemPage(req, res, app.problem, { title: 'App', back: back(req) }); return null; }
        return { project: project.data, app: app.data };
    }

    r.get('/:project/apps/:app', idParams, async (req, res) => {
        const loaded = await loadApp(req, res);
        if (!loaded) return;
        const { project, app } = loaded;
        const [creds, grants, catalog] = await Promise.all([
            net(req, res, (t) => network.projects.credentials(t, project.id, app.id)),
            net(req, res, (t) => network.projects.grants(t, project.id, app.id)),
            net(req, res, (t) => network.projects.catalog(t)),
        ]);
        const role = project.role;
        const manage = atLeast(role, app.environment === 'production' ? 'admin' : 'developer') && !app.revoked_at && !project.archived_at;
        const decide = atLeast(role, 'admin') && !app.revoked_at;
        const c = csrf(req);
        const base = `/projects/${project.id}/apps/${app.id}`;
        const grantRows = grants.ok ? (grants.data.grants || []) : [];
        const byCap = new Map(grantRows.map((g) => [g.capability, g]));
        const offer = catalog.ok ? offered(catalog.data, project) : [];
        const t = trust.get(app.id);
        const rels = releases.listForApp(app.id, { includeDrafts: true });
        page(req, res, {
            title: app.name, scripts: ['js/copy.js'],
            crumbs: [{ label: 'Projects', href: '/projects' }, { label: project.name, href: `/projects/${project.id}` }, { label: app.name }],
            body: html`<h1>${app.name} ${app.revoked_at ? badge('revoked', 'bad') : badge(app.environment, app.environment === 'production' ? 'warn' : '')}</h1>
${req.query.done ? notice(String(req.query.done).slice(0, 120), 'ok') : ''}
<dl class="facts"><dt>client_id</dt><dd>${code(app.client_id)}</dd><dt>Subject</dt><dd>${code(`app:${app.id}`)}</dd>
<dt>Type</dt><dd>${app.client_type}</dd><dt>Environment</dt><dd>${app.environment}</dd><dt>Trust tier</dt><dd>${t.tier} <span class="muted small">(metadata only; never grants anything)</span></dd>
<dt>Created</dt><dd>${time(app.created_at)}</dd>${app.revoked_at ? html`<dt>Revoked</dt><dd>${time(app.revoked_at)}</dd>` : ''}</dl>

<h2>Redirect URIs</h2>
${manage ? html`<form method="post" action="${base}/redirects" class="stack">${csrfField(c)}
<textarea name="redirect_uris" rows="3" spellcheck="false">${(app.redirect_uris || []).join('\n')}</textarea>
<p class="muted small">Exact match. https only (http://localhost, 127.0.0.1 and [::1] for sandbox apps). At most 10. To try sign-in before your callback exists, add <code>${config.baseUrl}/oauth/test-callback</code> (<a href="/oauth?client_id=${app.id}">helper</a>).</p>
<button type="submit">Save redirect URIs</button></form>` : table(['URI'], (app.redirect_uris || []).map((u) => [code(u)]), { empty: 'None.' })}

<h2>Credentials</h2>
${app.client_type === 'public' ? html`<p>Public apps have no secret: they use authorization code + PKCE only.</p>` : (creds.ok ? html`
${table(['Credential', 'Ends with', 'State', 'Created', 'Expires', 'Last used', ''], (creds.data.credentials || []).map((cr) => [
                code(cr.id), code(`…${cr.hint}`), badge(cr.state, cr.state === 'active' ? 'ok' : (cr.state === 'revoked' || cr.state === 'expired' ? 'bad' : 'warn')),
                time(cr.created_at), time(cr.expires_at), time(cr.last_used_at),
                manage && (cr.state === 'active' || cr.state === 'expiring') ? html`<form method="post" action="${base}/credentials/${cr.id}/revoke" class="inline-form">${csrfField(c)}<button type="submit" class="danger">Revoke now</button></form>` : '',
            ]), { empty: 'No credentials.' })}
<p class="muted small">Only the last four characters are ever shown: the secret itself was displayed once when it was made. A revoked secret stops working at once; tokens already issued with it end within 5 minutes.</p>
${manage ? html`<form method="post" action="${base}/credentials/rotate" class="inline-form">${csrfField(c)}
<label>Keep the previous secret valid for <select name="overlap_seconds"><option value="0">0 (stop at once)</option><option value="3600">1 hour</option><option value="86400" selected>24 hours</option><option value="604800">7 days</option></select></label>
<button type="submit">Rotate secret</button></form>` : ''}` : problemBox(creds.problem, { title: 'Credentials could not be loaded' }))}

<h2>Grants</h2>
${grants.ok ? table(['Capability', 'Audience', 'Status', 'Requested', 'Decided', ''], grantRows.map((g) => [
                html`<a href="/docs/capabilities/${g.capability}"><code>${g.capability}</code></a>`, code(g.audience), badge(g.status, g.status === 'approved' ? 'ok' : (g.status === 'requested' ? 'warn' : 'bad')),
                time(g.requested_at), time(g.decided_at),
                decide ? grantActions(base, g, c, project) : '',
            ]), { empty: 'No grants yet: this app can call nothing.' }) : problemBox(grants.problem, { title: 'Grants could not be loaded' })}

<h3 id="request">Request a capability</h3>
${catalog.ok ? html`<p class="muted small">Only capabilities apps can be granted are offered: active and <code>public</code>, or <code>partner</code> when staff put one in this project's allowance. A request outside the allowance waits until staff add it; owners and admins get requests inside it approved at once.</p>
${table(['Capability', 'Owner', 'Visibility', 'Description', 'Allowance', ''], offer.map((o) => {
                const g = byCap.get(o.id);
                return [
                    html`<a href="/docs/capabilities/${o.id}"><code>${o.id}</code></a>`, html`${o.owner}<br><code class="small">${o.audience}</code>`, o.visibility, o.description,
                    o.inAllowance ? badge('in allowance', 'ok') : badge('outside allowance'),
                    g && (g.status === 'approved' || g.status === 'requested') ? g.status
                        : (atLeast(role, 'developer') && !app.revoked_at ? html`<form method="post" action="${base}/grants" class="inline-form">${csrfField(c)}<input type="hidden" name="capability" value="${o.id}"><button type="submit">Request</button></form>` : ''),
                ];
            }), { cls: 'scope-editor', empty: 'Network offers no grantable capabilities.' })}` : problemBox(catalog.problem, { title: 'The capability catalog could not be loaded' })}

<h2>Playground</h2>
<p><a href="${base}/playground">Try calls with this app's own credentials</a> — it can do only what this app is granted.</p>

<h2>Releases</h2>
${table(['Version', 'Kind', 'Status', 'Created', 'Published'], rels.map((x) => [html`<a href="/releases/${x.id}">${x.version}</a>`, x.kind, statusBadge(x.status), time(x.created_at), time(x.published_at)]), { empty: 'No releases yet.' })}
${manage ? html`<p><a class="button" href="${base}/releases/new">New release</a> <a href="/apps/${app.id}">Public page</a></p>` : html`<p><a href="/apps/${app.id}">Public page</a></p>`}

${manage ? html`<h2>Revoke this app</h2><form method="post" action="${base}/revoke" class="stack">${csrfField(c)}
<label><input type="checkbox" name="confirm" value="1" required> Revoking stops every credential and pending code at once and cannot be undone</label>
<button type="submit" class="danger">Revoke app</button></form>` : ''}`,
        });
    });

    function grantActions(base, g, c, project) {
        const f = (action, label, cls = '') => html`<form method="post" action="${base}/grants/${g.capability}/${action}" class="inline-form">${csrfField(c)}<button type="submit" class="${cls}">${label}</button></form>`;
        if (g.status === 'requested') {
            const inside = (project.allowance || []).includes(g.capability);
            return html`${inside ? f('approve', 'Approve') : html`<span class="muted small">outside the allowance</span> `}${f('deny', 'Deny')}`;
        }
        if (g.status === 'approved') return f('revoke', 'Revoke', 'danger');
        return '';
    }

    const appBase = (req) => `/projects/${req.params.project}/apps/${req.params.app}`;
    r.post('/:project/apps/:app/redirects', idParams, form, guard, async (req, res) => {
        const got = await net(req, res, (t) => network.projects.updateApp(t, req.params.project, req.params.app, { redirect_uris: redirectList(req.body.redirect_uris) }));
        after(req, res, got, appBase(req), 'Redirect URIs saved');
    });
    r.post('/:project/apps/:app/revoke', idParams, form, guard, async (req, res) => {
        if (req.body.confirm !== '1') return problemPage(req, res, { status: 422, code: 'codes.confirm', detail: 'tick the box to confirm' }, { back: appBase(req) });
        const got = await net(req, res, (t) => network.projects.revokeApp(t, req.params.project, req.params.app));
        after(req, res, got, appBase(req), 'App revoked');
    });
    r.post('/:project/apps/:app/credentials/rotate', idParams, form, guard, async (req, res) => {
        const n = Number(req.body.overlap_seconds);
        const body = Number.isInteger(n) && n >= 0 && n <= 604800 ? { overlap_seconds: n } : {};
        const got = await net(req, res, (t) => network.projects.rotate(t, req.params.project, req.params.app, body));
        if (!got.ok) return problemPage(req, res, got.problem, { title: 'Rotate secret', back: appBase(req) });
        const appInfo = await net(req, res, (t) => network.projects.app(t, req.params.project, req.params.app));
        secretPage(req, res, {
            project: req.params.project, app: appInfo.ok ? appInfo.data : { id: req.params.app, name: req.params.app },
            credential: got.data.credential, rotated: true, previous: got.data.previous || [],
        });
    });
    r.post('/:project/apps/:app/credentials/:credential/revoke', idParams, form, guard, async (req, res) => {
        if (!CRD_RE.test(req.params.credential)) return problemPage(req, res, { status: 404, code: 'credential.not_found', detail: 'no such credential' }, { back: appBase(req) });
        const got = await net(req, res, (t) => network.projects.revokeCredential(t, req.params.project, req.params.app, req.params.credential));
        after(req, res, got, appBase(req), 'Credential revoked');
    });

    r.post('/:project/apps/:app/grants', idParams, form, guard, async (req, res) => {
        const capability = String(req.body.capability || '');
        // Re-derive what the scope editor offers and refuse anything else before Network sees it.
        const [project, catalog] = await Promise.all([
            net(req, res, (t) => network.projects.get(t, req.params.project)),
            net(req, res, (t) => network.projects.catalog(t)),
        ]);
        if (!project.ok) return problemPage(req, res, project.problem, { back: appBase(req) });
        if (!catalog.ok) return problemPage(req, res, catalog.problem, { back: appBase(req) });
        if (!offered(catalog.data, project.data).some((o) => o.id === capability)) {
            return problemPage(req, res, { status: 422, code: 'codes.not_grantable', detail: `${capability.slice(0, 80) || 'that'} is not a capability apps can be granted (only public ones, or partner ones in this project's allowance)` }, { title: 'Request a capability', back: appBase(req) });
        }
        const got = await net(req, res, (t) => network.projects.requestGrant(t, req.params.project, req.params.app, capability));
        after(req, res, got, appBase(req), got.ok ? `${capability}: ${got.data.status}` : '');
    });
    for (const [action, decision] of [['approve', 'approved'], ['deny', 'denied'], ['revoke', 'revoked']]) {
        r.post(`/:project/apps/:app/grants/:capability/${action}`, idParams, form, guard, async (req, res) => {
            if (!CAP_RE.test(req.params.capability)) return problemPage(req, res, { status: 404, code: 'grant.not_found', detail: 'no such grant' }, { back: appBase(req) });
            const got = await net(req, res, (t) => network.projects.decideGrant(t, req.params.project, req.params.app, req.params.capability, decision));
            after(req, res, got, appBase(req), `${req.params.capability}: ${decision}`);
        });
    }

    // ── Playgrounds ─────────────────────────────────────────
    async function playgroundPage(req, res, { result = null, kind = null, values = {}, status = 200 } = {}) {
        const loaded = await loadApp(req, res);
        if (!loaded) return;
        const { project, app } = loaded;
        const base = `/projects/${project.id}/apps/${app.id}`;
        const c = csrf(req);
        const events = playground.precheck(app, 'events');
        const media = playground.precheck(app, 'media');
        const credFields = html`<fieldset><legend>The app's credential (used for this request only, never stored)</legend>
<label><input type="radio" name="credential_type" value="client_secret" checked> client secret — Codes asks Network for a 5-minute token with it</label>
<label><input type="radio" name="credential_type" value="access_token"> access token you minted for this app</label>
<input type="password" name="credential" value="" autocomplete="off" required aria-label="Credential"></fieldset>`;
        const pre = (p) => (p.ok ? '' : html`<div class="notice ${p.stage === 'grant' ? 'warn' : 'bad'}"><strong>Cannot run:</strong> ${p.detail}${p.missing && p.grantable ? html` <a href="${base}#request">Request it</a>.` : ''}</div>`);
        const runs = playground.runsFor(app.id);
        page(req, res, {
            title: `Playground · ${app.name}`,
            crumbs: [{ label: 'Projects', href: '/projects' }, { label: project.name, href: `/projects/${project.id}` }, { label: app.name, href: base }, { label: 'Playground' }],
            body: html`<h1>Playground</h1>
<p>Calls here run <strong>as the app</strong>, with its own token, against the real services: the playground can do exactly what this app is granted and nothing more. Codes' own credentials are never used. Sandbox apps only.</p>
${result ? runResult(result) : ''}
<h2>${playground.KINDS.events.label}</h2>
<p class="muted small">Needs <code>events.app.publish</code> (audience <code>openvibe.events</code>). This app may publish types starting with <code>app.${playground.projectKey(project.id)}.</code> with source <code>${playground.appSource(app.id)}</code>; sandbox events reach sandbox subscriptions only. Endpoint: <code>${config.playground.eventsUrl}</code>.</p>
${pre(events)}${events.ok ? html`<form method="post" action="${base}/playground/events" class="stack">${csrfField(c)}
<label>Event type <input name="event_type" required value="${values.event_type || `app.${playground.projectKey(project.id)}.test.ping`}"></label>
<label>Subject type <input name="subject_type" value="${values.subject_type || 'test'}"></label>
<label>Subject id <input name="subject_id" value="${values.subject_id || 'test-1'}"></label>
<label>Payload (JSON object) <textarea name="payload" rows="4" spellcheck="false">${values.payload || '{}'}</textarea></label>
${credFields}<button type="submit">Publish test event</button></form>` : ''}
<h2>${playground.KINDS.media.label}</h2>
<p class="muted small">Needs <code>media.object.upload</code> (audience <code>openvibe.media</code>) for the project's namespace <code>${project.id}</code>. Endpoint: <code>${config.playground.mediaUrl}</code>. At most ${config.playground.maxUploadBytes} bytes.</p>
${pre(media)}${media.ok ? html`<form method="post" action="${base}/playground/media" enctype="multipart/form-data" class="stack">${csrfField(c)}
<label>File <input type="file" name="file" required></label>${credFields}<button type="submit">Upload</button></form>` : ''}
<h2>Recent runs</h2>
${table(['When', 'Playground', 'Credential', 'Outcome', 'Stage', 'HTTP', 'Code', 'Detail', 'Result'], runs.map((x) => [
                time(x.at), x.kind, x.credential, badge(x.outcome, x.outcome === 'ok' ? 'ok' : (x.outcome === 'failed' ? 'bad' : 'warn')), x.stage, x.http_status || '', x.code ? code(x.code) : '', x.detail, x.ref ? code(x.ref) : '',
            ]), { empty: 'No runs yet.' })}`,
        }, status);
    }

    function runResult(r) {
        return html`<div class="result ${r.outcome === 'ok' ? 'ok' : 'bad'}" role="status"><p><strong>${r.outcome === 'ok' ? 'Done.' : (r.outcome === 'refused' ? 'Refused.' : 'Failed.')}</strong> ${r.detail}</p>
<p class="muted small">stage ${r.stage}${r.http_status ? ` · HTTP ${r.http_status}` : ''}${r.code ? html` · <code>${r.code}</code>` : ''}${r.runId ? html` · run <code>${r.runId}</code>` : ''}</p>
${r.result ? html`<pre><code>${JSON.stringify(r.result, null, 2)}</code></pre>` : ''}</div>`;
    }

    const statusFor = (out) => (out.outcome === 'ok' ? 200 : (out.stage === 'grant' || out.stage === 'app' ? 403 : (out.stage === 'input' ? 422 : (out.stage === 'rate' ? 429 : (out.stage === 'token' ? (out.http_status && out.http_status >= 400 ? out.http_status : 401) : 502)))));

    r.get('/:project/apps/:app/playground', idParams, (req, res) => playgroundPage(req, res));

    r.post('/:project/apps/:app/playground/events', idParams, form, guard, async (req, res) => {
        const got = await net(req, res, (t) => network.projects.app(t, req.params.project, req.params.app));
        if (!got.ok) return problemPage(req, res, got.problem, { back: appBase(req) });
        const b = req.body || {};
        const out = await playground.run({
            actor: `user:${req.viewer.subject}`, app: got.data, kind: 'events',
            credential: { type: b.credential_type === 'access_token' ? 'access_token' : 'client_secret', value: typeof b.credential === 'string' ? b.credential.trim() : '' },
            input: { event_type: b.event_type, subject_type: b.subject_type, subject_id: b.subject_id, payload: b.payload },
        });
        // The credential is NOT passed back: the form comes back with it empty.
        return playgroundPage(req, res, { result: out, values: { event_type: b.event_type, subject_type: b.subject_type, subject_id: b.subject_id, payload: b.payload }, status: statusFor(out) });
    });

    r.post('/:project/apps/:app/playground/media', idParams, async (req, res) => {
        if (!sameOrigin(config, req)) return page(req, res, { title: 'Forbidden', body: html`<h1>Forbidden</h1>` }, 403);
        let parsed;
        try { parsed = await readMultipart(req, config.playground.maxUploadBytes); } catch (err) {
            return page(req, res, { title: 'Upload', body: problemBox({ status: 413, code: 'playground.too_large', detail: err.message }) }, 413);
        }
        if (!checkCsrf(config, req.viewer, parsed.fields.csrf)) return page(req, res, { title: 'Form expired', body: html`<h1>This form has expired</h1><p>Reload the page and try again.</p>` }, 403);
        const got = await net(req, res, (t) => network.projects.app(t, req.params.project, req.params.app));
        if (!got.ok) return problemPage(req, res, got.problem, { back: appBase(req) });
        const out = await playground.run({
            actor: `user:${req.viewer.subject}`, app: got.data, kind: 'media',
            credential: { type: parsed.fields.credential_type === 'access_token' ? 'access_token' : 'client_secret', value: String(parsed.fields.credential || '').trim() },
            file: parsed.file,
        });
        return playgroundPage(req, res, { result: out, status: statusFor(out) });
    });

    // ── Releases (Codes-owned) ──────────────────────────────
    async function editorPage(req, res, { status = 200, kind, text, notes = '', validation = null, parseError = null, problem = null } = {}) {
        const loaded = await loadApp(req, res);
        if (!loaded) return;
        const { project, app } = loaded;
        const k = kind === 'mod' ? 'mod' : 'app';
        const base = `/projects/${project.id}/apps/${app.id}`;
        const starter = JSON.stringify(manifestsLib.template(k, { appId: app.id, projectId: project.id, environment: app.environment, name: app.name, subject: req.viewer.subject }), null, 2);
        page(req, res, {
            title: `New release · ${app.name}`,
            crumbs: [{ label: 'Projects', href: '/projects' }, { label: project.name, href: `/projects/${project.id}` }, { label: app.name, href: base }, { label: 'New release' }],
            body: html`<h1>New release</h1>
<p>A release is Codes' record of a version of this app (or of a mod it publishes): a validated manifest, compatibility ranges and a status. Versions are immutable. Publishing announces <code>codes.app.published</code>; a manifest's capabilities are only a request — grants in Network stay the authority.</p>
<p class="muted small">Start from: <a href="${base}/releases/new?kind=app">app manifest</a> · <a href="${base}/releases/new?kind=mod">mod manifest</a> (<code>mods.mod-manifest@1</code>)</p>
${problem ? problemBox(problem, { title: 'Not created' }) : ''}${parseError ? notice(parseError, 'bad') : ''}${validation ? validationResult(validation) : ''}
<form method="post" action="${base}/releases" class="stack">${csrfField(csrf(req))}
<input type="hidden" name="kind" value="${k}">
<label>${k === 'mod' ? 'Mod' : 'App'} manifest (JSON) <textarea name="manifest" rows="22" spellcheck="false">${text != null ? text : starter}</textarea></label>
<label>Release notes (public) <textarea name="notes" rows="3" maxlength="2000">${notes}</textarea></label>
<div class="buttons"><button type="submit" name="intent" value="validate">Validate only</button> <button type="submit" name="intent" value="create">Create draft</button></div></form>`,
        }, status);
    }

    r.get('/:project/apps/:app/releases/new', idParams, (req, res) => editorPage(req, res, { kind: req.query.kind }));
    r.post('/:project/apps/:app/releases', idParams, form, guard, async (req, res) => {
        const b = req.body || {};
        const kind = b.kind === 'mod' ? 'mod' : 'app';
        const p = manifestsLib.parse(b.manifest);
        if (p.error) return editorPage(req, res, { status: 422, kind, text: b.manifest || '', notes: b.notes, parseError: p.error });
        const [project, app] = await Promise.all([
            net(req, res, (t) => network.projects.get(t, req.params.project)),
            net(req, res, (t) => network.projects.app(t, req.params.project, req.params.app)),
        ]);
        if (!project.ok || !app.ok) return problemPage(req, res, (project.ok ? app : project).problem, { back: appBase(req) });
        if (b.intent !== 'create') {
            const v = manifestsLib.validate(kind, p.manifest, { app: app.data, viewerSubject: req.viewer.subject, eventTypes: docs.eventTypes });
            return editorPage(req, res, { status: v.valid ? 200 : 422, kind, text: b.manifest, notes: b.notes, validation: v });
        }
        try {
            const out = releases.createDraft({
                actor: { kind: 'user', label: `user:${req.viewer.subject}`, subject: req.viewer.subject, role: project.data.role, staff: req.viewer.staff, traceparent: req.ov.traceparent },
                app: app.data, kind, manifest: p.manifest, notes: b.notes, eventTypes: docs.eventTypes,
            });
            res.redirect(303, `/releases/${out.release.id}`);
        } catch (err) {
            if (!(err instanceof ReleaseError)) return unexpected(req, res, err);
            return editorPage(req, res, { status: err.status, kind, text: b.manifest, notes: b.notes, validation: err.validation || null, problem: err.validation ? null : { status: err.status, code: err.code, detail: err.detail } });
        }
    });

    return r;
}

/**
 * Release actions (/releases/:id/publish|deprecate|revoke): the actor's role comes from Network,
 * asked with the actor's own token for the release's project and app.
 */
function createReleaseActionRoutes(ctx) {
    const { config, network, sso, releases, log } = ctx;
    const r = asyncRouter();
    const form = express.urlencoded({ extended: false, limit: '16kb' });
    const page = (req, res, o, status) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });

    for (const action of ['publish', 'deprecate', 'revoke']) {
        r.post(`/:id/${action}`, form, async (req, res) => {
            if (req.viewer.kind !== 'user' || !req.viewer.subject) return page(req, res, { title: 'Sign in', body: html`<h1>Sign in first</h1>` }, 401);
            if (!sameOrigin(config, req) || !checkCsrf(config, req.viewer, req.body && req.body.csrf)) return page(req, res, { title: 'Form expired', body: html`<h1>This form has expired</h1>` }, 403);
            if (!REL_RE.test(req.params.id)) return page(req, res, { title: 'Not found', body: html`<h1>Not found</h1>` }, 404);
            const rel = releases.get(req.params.id);
            if (!rel) return page(req, res, { title: 'Not found', body: html`<h1>Not found</h1>` }, 404);
            let project = null;
            let app = null;
            try {
                [project, app] = await Promise.all([
                    sso.asViewer(req, res, (t) => network.projects.get(t, rel.project_id)),
                    sso.asViewer(req, res, (t) => network.projects.app(t, rel.project_id, rel.app_id)),
                ]);
            } catch (err) {
                const p = network.problemOf(err);
                // Codes staff may revoke a release of a project they cannot see in Network.
                if (!(action === 'revoke' && req.viewer.staff && p.status === 404)) {
                    log.warn(`[Codes] network ${p.status} ${p.code}`);
                    return page(req, res, { title: 'Release', body: problemBox(p, { title: `OpenVibe.Network answered ${p.status}` }) }, p.status);
                }
            }
            const actor = { kind: 'user', label: `user:${req.viewer.subject}`, subject: req.viewer.subject, role: project ? project.role : null, staff: req.viewer.staff, traceparent: req.ov.traceparent };
            try {
                if (action === 'publish') releases.publish({ actor, releaseId: rel.id, app });
                else if (action === 'deprecate') releases.deprecate({ actor, releaseId: rel.id, app, reason: req.body.reason, replacement: req.body.replacement || null });
                else {
                    if (req.body.confirm !== '1') throw new ReleaseError(422, 'codes.confirm', 'tick the box to confirm');
                    releases.revoke({ actor, releaseId: rel.id, app, reason: req.body.reason });
                }
                res.redirect(303, `/releases/${rel.id}?done=${action === 'publish' ? 'published' : (action === 'deprecate' ? 'deprecated' : 'revoked')}`);
            } catch (err) {
                if (!(err instanceof ReleaseError)) return unexpected(req, res, err);
                page(req, res, { title: 'Release', body: html`${problemBox({ status: err.status, code: err.code, detail: err.detail }, { title: 'Not done' })}<p><a href="/releases/${rel.id}">Back</a></p>` }, err.status);
            }
        });
    }
    return r;
}

/** An unexpected error in an async handler: logged without the request body, a plain 500 page. */
function unexpected(req, res, err) {
    const log = req.app.locals.ctx.log;
    log.error('[Codes]', err && err.message ? err.message.slice(0, 300) : err);
    if (res.headersSent) return;
    res.set('Cache-Control', 'private, no-store');
    res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
}

/** multipart/form-data → { fields, file: { buffer, filename, mimeType } | null }; rejects past the limit. */
function readMultipart(req, maxBytes) {
    return new Promise((resolve, reject) => {
        let bb;
        try { bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: maxBytes, fields: 10, fieldSize: 16 * 1024 } }); } catch (err) { reject(new Error('expected multipart/form-data')); return; }
        const fields = {};
        let file = null;
        let tooBig = false;
        bb.on('field', (name, value) => { fields[name] = value; });
        bb.on('file', (name, stream, info) => {
            const chunks = [];
            stream.on('data', (d) => chunks.push(d));
            stream.on('limit', () => { tooBig = true; });
            stream.on('end', () => { if (name === 'file') file = { buffer: Buffer.concat(chunks), filename: String(info.filename || 'file').slice(0, 200), mimeType: info.mimeType || 'application/octet-stream' }; });
        });
        bb.on('close', () => (tooBig ? reject(new Error(`playground uploads are at most ${maxBytes} bytes`)) : resolve({ fields, file })));
        bb.on('error', () => reject(new Error('the upload could not be read')));
        req.pipe(bb);
    });
}

module.exports = { createPortalRoutes, createReleaseActionRoutes };
