'use strict';

/**
 * The skills hub's pages (the Compute plan §5, E6): the gallery at /skills and one record at /skills/:id.
 *
 * The page is server-rendered and complete without JavaScript. Only public records are in the gallery; a link record
 * opens by its URL, a people record for its members, and a private one for its owner. A skill's body is untrusted
 * text rendered through server/render/markdown.js, the markup gate (escape first, then headings, lists, code, tables,
 * bold, inline code and http(s) or relative links only), never as HTML.
 */
const express = require('express');
const { asyncRouter } = require('./router');
const { html, raw, table, notice, badge } = require('../render/html');
const { markdown } = require('../render/markdown');
const { send } = require('../render/layout');
const { KINDS, TOOLS, AUDIENCES, SkillError } = require('../domain/skills');

const KIND_LABELS = { skill: 'Skill', rule: 'Rule', mcp: 'MCP server', command: 'Command', hook: 'Hook' };
const AUDIENCE_LABELS = {
    public: 'Public: in the gallery, search and agents',
    link: 'Link: anyone with the address, not listed',
    people: 'People: you and the members you add',
    private: 'Private: only you',
};
const TOOL_LABELS = {
    'claude-code': 'Claude Code',
    codex: 'Codex',
    opencode: 'OpenCode',
    'command-code': 'Command Code',
    'minimax-code': 'MiniMax Code',
    aider: 'Aider',
    agents: 'AGENTS.md (Codex and friends)',
};

function createSkillPageRoutes({ config, skills }) {
    const r = asyncRouter();
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const sameOrigin = (req) => {
        const origin = req.get('origin');
        if (!origin) return true;
        try { return new URL(origin).origin === new URL(config.baseUrl).origin; } catch { return false; }
    };
    const form = express.urlencoded({ extended: false, limit: '200kb' });
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });

    const toolsText = (tools) => (tools && tools.length ? tools.map((t) => TOOL_LABELS[t] || t).join(', ') : 'every tool');
    const skillCard = (s, extra = '') => html`<li>
<a href="/skills/${s.id}"><strong>${s.title}</strong></a>
<span>${s.summary || 'No summary yet.'}</span>
<span>${badge(KIND_LABELS[s.kind] || s.kind)} ${badge(`v${s.version}`)} ${s.official ? badge('OpenVibe', 'ok') : ''}</span>
<span class="muted small">${s.slug} · ${toolsText(s.tools)}</span>
${extra}
</li>`;

    function formFields(s = null, { audience = true } = {}) {
        const v = s || { kind: 'skill', slug: '', title: '', summary: '', body: '', audience: 'private', tools: [] };
        return html`<div class="field"><label for="sk-title">Title</label><input id="sk-title" name="title" maxlength="120" required value="${v.title}"></div>
<div class="field"><label for="sk-slug">Slug (the folder name; lowercase letters, digits and hyphens)</label><input id="sk-slug" name="slug" maxlength="64" pattern="[a-z0-9][a-z0-9-]{0,63}" required value="${v.slug}"></div>
<div class="field"><label for="sk-kind">Kind</label><select id="sk-kind" name="kind">${KINDS.map((k) => html`<option value="${k}" ${k === v.kind ? raw('selected') : ''}>${KIND_LABELS[k]}</option>`)}</select></div>
<div class="field"><label for="sk-summary">Summary (one line, shown in the gallery)</label><input id="sk-summary" name="summary" maxlength="500" value="${v.summary}"></div>
<div class="field"><label for="sk-body">Body (SKILL.md content, Markdown)</label><textarea id="sk-body" name="body" rows="16" maxlength="131072" required>${v.body}</textarea></div>
${audience ? html`<div class="field"><label for="sk-audience">Who may read it</label><select id="sk-audience" name="audience">${AUDIENCES.map((a) => html`<option value="${a}" ${a === v.audience ? raw('selected') : ''}>${AUDIENCE_LABELS[a]}</option>`)}</select></div>` : ''}
<fieldset class="field"><legend>Tools</legend>${TOOLS.map((t) => html`<label class="check"><input type="checkbox" name="tools" value="${t}" ${v.tools.includes(t) ? raw('checked') : ''}> ${TOOL_LABELS[t]}</label>`)}</fieldset>`;
    }

    async function galleryPage(req, res, { error = null, status = 200 } = {}) {
        const kind = KINDS.includes(String(req.query.kind || '')) ? String(req.query.kind) : '';
        const q = String(req.query.q || '').slice(0, 80);
        const shown = await skills.gallery({ kind, q });
        const mine = signedIn(req) ? await skills.mine(req.viewer.subject) : [];
        const assigned = signedIn(req) ? new Set((await skills.assignments(req.viewer.subject)).map((a) => a.skill_id)) : new Set();
        const create = signedIn(req)
            ? html`<section aria-labelledby="h-new"><h2 id="h-new">Publish a skill, a rule or an MCP server</h2>
<form class="stack" method="post" action="/skills/new">${formFields()}<button class="run-btn run-btn-primary" type="submit">Save version 1</button></form></section>`
            : html`<p><a class="run-btn" href="/auth/login?next=${encodeURIComponent('/skills')}">Sign in to publish and sync skills</a></p>`;
        return page(req, res, {
            title: 'Skills: the hub for your agents',
            description: 'Skills, rules and MCP servers kept per person and per project, versioned, and synced into Claude Code, Codex, OpenCode and Command Code on your machine.',
            crumbs: [{ label: 'Skills' }],
            body: html`<h1>Skills</h1>
<p class="lede">Skills, rules and MCP servers kept per person and per project, versioned, and synced into each agent tool's own folder on your machine. Add one from the gallery; <code>openvibe-link skills sync</code> writes it inside its marked block, with a dry run, a diff and an undo.</p>
${error ? notice(error, 'bad') : ''}
<form class="inline-form" method="get" action="/skills" role="search">
<label>Search the gallery <input name="q" value="${q}" maxlength="80"></label>
<label>Kind <select name="kind"><option value="">all</option>${KINDS.map((k) => html`<option value="${k}" ${k === kind ? raw('selected') : ''}>${KIND_LABELS[k]}</option>`)}</select></label>
<button class="run-btn" type="submit">Show</button></form>
<section aria-labelledby="h-gallery"><h2 id="h-gallery">The gallery</h2>
${shown.length ? html`<ul class="cards">${shown.map(skillCard)}</ul>` : html`<p class="muted">No public ${kind ? KIND_LABELS[kind].toLowerCase() + 's' : 'records'} yet. The first one published appears here.</p>`}
</section>
${create}
${signedIn(req) ? html`<section aria-labelledby="h-mine"><h2 id="h-mine">Yours</h2>
${mine.length ? html`<ul class="cards">${mine.map((s) => skillCard(s, html`<span class="muted small">${badge(AUDIENCE_LABELS[s.audience].split(':')[0])} ${assigned.has(s.id) ? badge('in your sync', 'ok') : ''}</span>`))}</ul>` : html`<p class="muted">Nothing yet. Publish one above.</p>`}
</section>` : ''}`,
        }, status);
    }

    async function detailPage(req, res, { error = null, status = 200 } = {}) {
        const skill = await skills.get(req.params.id, req.viewer && req.viewer.kind === 'user' ? { subject: req.viewer.subject } : null);
        if (!skill) return page(req, res, { title: 'Not found', body: html`<h1>Not found</h1><p>No such skill. <a href="/skills">The gallery</a></p>` }, 404);
        const owner = signedIn(req) && req.viewer.subject === skill.owner_subject;
        const versions = await skills.listVersions(skill.id, owner ? { subject: req.viewer.subject } : (signedIn(req) ? { subject: req.viewer.subject } : null)) || [];
        const assigned = signedIn(req) ? (await skills.assignments(req.viewer.subject)).some((a) => a.skill_id === skill.id) : false;
        const members = owner && skill.audience === 'people' ? await skills.members(skill.id, { subject: req.viewer.subject }) : [];
        const controls = owner ? html`<section aria-labelledby="h-edit"><h2 id="h-edit">A new version</h2>
<form class="stack" method="post" action="/skills/${skill.id}/versions"><input type="hidden" name="slug" value="${skill.slug}">${formFields(skill, { audience: false })}<button class="run-btn run-btn-primary" type="submit">Save version ${skill.version + 1}</button></form>
<h2>Who may read it</h2>
<form class="inline-form" method="post" action="/skills/${skill.id}/audience">
<label>Audience <select name="audience">${AUDIENCES.map((a) => html`<option value="${a}" ${a === skill.audience ? raw('selected') : ''}>${AUDIENCE_LABELS[a]}</option>`)}</select></label>
<button class="run-btn" type="submit">Save</button></form>
${skill.audience === 'people' ? html`<h3>Members</h3>${members.length ? html`<ul>${members.map((m) => html`<li><code>${m.subject}</code> ${badge(m.role)} <form class="inline-form" method="post" action="/skills/${skill.id}/members/remove"><input type="hidden" name="subject" value="${m.subject}"><button class="run-btn" type="submit">Remove</button></form></li>`)}</ul>` : html`<p class="muted">Nobody added yet; only you can read it.</p>`}
<form class="inline-form" method="post" action="/skills/${skill.id}/members"><label>Person <input name="subject" placeholder="usr_…" pattern="usr_[0-9A-HJKMNP-TV-Z]{26}" required></label><button class="run-btn" type="submit">Add</button></form>` : ''}
</section>` : '';
        return page(req, res, {
            title: skill.title,
            description: skill.summary || `A ${KIND_LABELS[skill.kind]} on OpenVibe.Codes.`,
            crumbs: [{ label: 'Skills', href: '/skills' }, { label: skill.title }],
            body: html`${error ? notice(error, 'bad') : ''}
<h1>${skill.title}</h1>
<p class="lede">${skill.summary || ''}</p>
<p>${badge(KIND_LABELS[skill.kind])} ${badge(`v${skill.version}`)} ${badge(AUDIENCE_LABELS[skill.audience].split(':')[0])} ${skill.official ? badge('OpenVibe', 'ok') : ''} <span class="muted small">${skill.slug} · ${toolsText(skill.tools)} · updated ${skill.updated_at.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}</span></p>
${signedIn(req) ? html`<form class="inline-form" method="post" action="/skills/${skill.id}/add"><button class="run-btn run-btn-primary" type="submit">${assigned ? 'Remove from my sync' : 'Add to my sync'}</button></form>` : html`<p><a class="run-btn" href="/auth/login?next=${encodeURIComponent(`/skills/${skill.id}`)}">Sign in to add it to your sync</a></p>`}
<article class="prose">${raw(markdown(skill.body, { headingOffset: 1 }))}</article>
<section aria-labelledby="h-history"><h2 id="h-history">Versions</h2>
${table(['Version', 'When', 'Audience', 'Note'], versions.map((v) => [
            owner ? html`<form class="inline-form" method="post" action="/skills/${skill.id}/rollback"><input type="hidden" name="version" value="${v.version}"><button class="run-btn" type="submit" title="Copy this version into a new one">Roll back to v${v.version}</button></form>` : `v${v.version}`,
            v.created_at.replace('T', ' ').replace(/\.\d+Z$/, ' UTC'),
            v.audience,
            v.note || '—',
        ]))}
<p class="muted small">A rollback copies the chosen version into a new one, so history is never rewritten. The Link records the version it wrote.</p></section>
${controls}`,
        }, status);
    }

    r.get('/skills', (req, res, next) => galleryPage(req, res).catch(next));
    r.get('/skills/:id', (req, res, next) => detailPage(req, res).catch(next));

    r.post('/skills/new', form, async (req, res, next) => {
        try {
            if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent('/skills')}`);
            if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
            const tools = [].concat(req.body.tools || []).filter((t) => TOOLS.includes(t));
            const input = { ...req.body, tools };
            const skill = await skills.create({ subject: req.viewer.subject, input });
            return res.redirect(303, `/skills/${skill.id}`);
        } catch (err) {
            if (err instanceof SkillError) return galleryPage(req, res, { error: err.message, status: err.status }).catch(next);
            return next(err);
        }
    });

    r.post('/skills/:id/versions', form, async (req, res, next) => {
        try {
            if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(`/skills/${req.params.id}`)}`);
            if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
            const tools = [].concat(req.body.tools || []).filter((t) => TOOLS.includes(t));
            await skills.addVersion({ subject: req.viewer.subject, id: req.params.id, input: { ...req.body, tools } });
            return res.redirect(303, `/skills/${req.params.id}`);
        } catch (err) {
            if (err instanceof SkillError) return detailPage(req, res, { error: err.message, status: err.status }).catch(next);
            return next(err);
        }
    });

    r.post('/skills/:id/rollback', form, async (req, res, next) => {
        try {
            if (!signedIn(req)) return res.status(401).type('text/plain').send('Sign in first.\n');
            if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
            await skills.rollback({ subject: req.viewer.subject, id: req.params.id, version: req.body.version });
            return res.redirect(303, `/skills/${req.params.id}`);
        } catch (err) {
            if (err instanceof SkillError) return detailPage(req, res, { error: err.message, status: err.status }).catch(next);
            return next(err);
        }
    });

    r.post('/skills/:id/audience', form, async (req, res, next) => {
        try {
            if (!signedIn(req)) return res.status(401).type('text/plain').send('Sign in first.\n');
            if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
            await skills.setAudience({ subject: req.viewer.subject, id: req.params.id, audience: req.body.audience });
            return res.redirect(303, `/skills/${req.params.id}`);
        } catch (err) {
            if (err instanceof SkillError) return detailPage(req, res, { error: err.message, status: err.status }).catch(next);
            return next(err);
        }
    });

    r.post('/skills/:id/members', form, async (req, res, next) => {
        try {
            if (!signedIn(req)) return res.status(401).type('text/plain').send('Sign in first.\n');
            if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
            await skills.addMember({ subject: req.viewer.subject, id: req.params.id, memberSubject: req.body.subject });
            return res.redirect(303, `/skills/${req.params.id}`);
        } catch (err) {
            if (err instanceof SkillError) return detailPage(req, res, { error: err.message, status: err.status }).catch(next);
            return next(err);
        }
    });

    r.post('/skills/:id/members/remove', form, async (req, res, next) => {
        try {
            if (!signedIn(req)) return res.status(401).type('text/plain').send('Sign in first.\n');
            if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
            await skills.removeMember({ subject: req.viewer.subject, id: req.params.id, memberSubject: req.body.subject });
            return res.redirect(303, `/skills/${req.params.id}`);
        } catch (err) {
            if (err instanceof SkillError) return detailPage(req, res, { error: err.message, status: err.status }).catch(next);
            return next(err);
        }
    });

    // The one page action that is not the owner's: add or remove a record from this person's sync.
    r.post('/skills/:id/add', form, async (req, res, next) => {
        try {
            if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(`/skills/${req.params.id}`)}`);
            if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
            const on = (await skills.assignments(req.viewer.subject)).some((a) => a.skill_id === req.params.id);
            if (on) await skills.unassign({ subject: req.viewer.subject, id: req.params.id });
            else await skills.assign({ subject: req.viewer.subject, id: req.params.id });
            return res.redirect(303, `/skills/${req.params.id}`);
        } catch (err) {
            if (err instanceof SkillError) return detailPage(req, res, { error: err.message, status: err.status }).catch(next);
            return next(err);
        }
    });

    return r;
}

module.exports = { createSkillPageRoutes };
