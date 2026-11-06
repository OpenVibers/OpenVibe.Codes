'use strict';

/**
 * The Knowledge page (Know K5): what a person's own coding runs taught them, and what their team shared.
 *
 * The rows live in Codes' own table (server/domain/knowledge.js). Every row is visible, editable, pinnable and
 * deletable here, with the run it came from; private by default, shareable with a team (a Network project the person
 * belongs to). The page is server-rendered and complete without JavaScript: the edit and share panels are details
 * elements, and every write is a same-origin form post that answers with a flash back to the tab it came from.
 *
 *   GET  /knowledge                    the page: all, lessons, facts, pinned, team
 *   POST /knowledge                    add a lesson or fact by hand
 *   POST /knowledge/:id/edit           its text and kind
 *   POST /knowledge/:id/pin            pin or unpin it
 *   POST /knowledge/:id/delete         the row, gone
 *   POST /knowledge/:id/share          share it with one of the person's teams
 *   POST /knowledge/:id/unshare        private again
 *
 * Secrets are scrubbed before the row is stored. Nothing here logs the text.
 */

const express = require('express');
const { esc } = require('../render/html');
const { asyncRouter } = require('./router');

const ID = /^kn_[0-9A-HJKMNP-TV-Z]{26}$/;
const TABS = [['all', 'All'], ['lessons', 'Lessons'], ['facts', 'Facts'], ['pinned', 'Pinned'], ['team', 'Team']];

const dayOf = (value) => {
    const ms = Date.parse(String(value || ''));
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'today';
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + (sameYear ? '' : ', ' + d.getFullYear());
};
const agoOf = (value) => {
    const ms = Date.parse(String(value || ''));
    if (!Number.isFinite(ms)) return '';
    const mins = Math.max(0, Math.floor((Date.now() - ms) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    if (mins < 1440) return `${Math.floor(mins / 60)} h ago`;
    return `${Math.floor(mins / 1440)} d ago`;
};

function createKnowledgeRoutes(ctx, kit) {
    const { page, wrap, header, pill, flash, sameOrigin, viewer, form, signIn, note } = kit;
    const { knowledge } = ctx;
    const router = asyncRouter();

    const back = (req, res, fallback, ok, error) => {
        const asked = String((req.body && req.body.tab) || req.query.tab || '');
        const tab = TABS.some(([id]) => id === asked) ? asked : fallback;
        const target = `/knowledge?tab=${encodeURIComponent(tab)}`;
        if (error) return res.redirect(303, `${target}&error=${encodeURIComponent(String(error).slice(0, 180))}`);
        return res.redirect(303, `${target}&ok=${encodeURIComponent(String(ok).slice(0, 140))}`);
    };

    const teamsOf = async (req, res) => {
        try {
            return await ctx.sso.asViewer(req, res, (token) => knowledge.projectsOf(token));
        } catch {
            return [];
        }
    };

    async function rowsOf(req, res) {
        let teams = [];
        try {
            teams = await ctx.sso.asViewer(req, res, (token) => knowledge.teamIdsOf(token));
        } catch { /* private rows only */ }
        const rows = await knowledge.list({ subject: req.viewer.subject, teamIds: teams, limit: 500 });
        return { rows, teams };
    }

    const matches = (tab) => (row) => tab === 'all' ? true
        : tab === 'lessons' ? row.kind === 'lesson'
            : tab === 'facts' ? row.kind === 'fact'
                : tab === 'pinned' ? !!row.pinned
                    : row.visibility === 'team';

    function addForm(teams) {
        return `<details class="c4-more kn-add"><summary>Add a lesson or a fact</summary><div class="c4-more-body">
<form class="c4-form" method="post" action="/knowledge">
<input type="hidden" name="tab" value="all">
<label>What should the next run know?<textarea name="text" rows="3" maxlength="2000" required placeholder="The home test pins the sc-navbar markup (test/home.test.js)."></textarea></label>
<div class="c4-form-row">
<label>Kind<select name="kind"><option value="lesson">lesson</option><option value="fact">fact</option></select></label>
<label>Repository <span class="c4-muted">(optional)</span><input name="repo" maxlength="300" placeholder="OpenVibers/OpenVibe.Codes"></label>
</div>
${teams.length ? `<label>Share with <select name="team_id"><option value="">Just me</option>${teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></label>` : '<p class="c4-hint">Private to you. Share it with a team once you belong to one.</p>'}
<button class="c4-button" type="submit">Remember this</button>
</form></div></details>`;
    }

    function rowHtml(row, { mine, teams, tab }) {
        const team = row.team_id ? teams.find((t) => t.id === row.team_id) : null;
        // The repository is where a lesson applies, said with the source line rather than floating in the head.
        const where = row.repo ? ` · <span class="kn-repo">${esc(String(row.repo).replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, ''))}</span>` : '';
        const source = row.source_task
            ? `<p class="kn-source">From <a href="/tasks/${esc(row.source_task)}">the run that learned it</a>${row.source_agent ? ` · ${esc(row.source_agent)}` : ''}${where}</p>`
            : `<p class="kn-source">Added by you${where}</p>`;
        const shared = row.visibility === 'team'
            ? pill(`Shared${team ? ` with ${team.name}` : ''}`, 'ok')
            : pill('Private');
        const actions = mine ? `<div class="kn-actions">
<form method="post" action="/knowledge/${esc(row.id)}/pin"><input type="hidden" name="tab" value="${esc(tab)}"><input type="hidden" name="pinned" value="${row.pinned ? '0' : '1'}"><button class="c4-button c4-button-light" type="submit">${row.pinned ? 'Unpin' : 'Pin'}</button></form>
<details class="c4-more"><summary>Edit</summary><div class="c4-more-body">
<form class="c4-form" method="post" action="/knowledge/${esc(row.id)}/edit">
<input type="hidden" name="tab" value="${esc(tab)}">
<label>Text<textarea name="text" rows="3" maxlength="2000" required>${esc(row.text)}</textarea></label>
<label>Kind<select name="kind"><option value="lesson"${row.kind === 'lesson' ? ' selected' : ''}>Lesson</option><option value="fact"${row.kind === 'fact' ? ' selected' : ''}>Fact</option></select></label>
<button class="c4-button" type="submit">Save</button>
</form></div></details>
${row.visibility === 'team' ? `<form method="post" action="/knowledge/${esc(row.id)}/unshare"><input type="hidden" name="tab" value="${esc(tab)}"><button class="c4-button c4-button-light" type="submit">Make private</button></form>`
        : (teams.length ? `<details class="c4-more"><summary>Share</summary><div class="c4-more-body"><form class="c4-form" method="post" action="/knowledge/${esc(row.id)}/share"><input type="hidden" name="tab" value="${esc(tab)}"><label>Team<select name="team_id">${teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></label><button class="c4-button" type="submit">Share with this team</button></form></div></details>`
            : '<span class="c4-hint">No team to share with yet.</span>')}
<details class="c4-more kn-delete"><summary>Delete</summary><div class="c4-more-body"><p class="kn-confirm">Delete this ${row.kind === 'fact' ? 'fact' : 'lesson'}? Runs stop recalling it, and it cannot be brought back.</p><form method="post" action="/knowledge/${esc(row.id)}/delete"><input type="hidden" name="tab" value="${esc(tab)}"><button class="c4-button c4-button-danger" type="submit">Delete it</button></form></div></details>
</div>` : `<p class="kn-team-note">${row.visibility === 'team' ? 'Shared with your team.' : ''} Only ${mine ? 'you' : 'its owner'} can edit it.</p>`;
        return `<article class="c4-card kn-row${row.pinned ? ' is-pinned' : ''}">
<div class="kn-row-head">${pill(row.kind === 'fact' ? 'Fact' : 'Lesson')}${row.pinned ? pill('Pinned', 'pinned') : ''}${shared}</div>
<p class="kn-text">${esc(row.text)}</p>
<p class="kn-meta">${esc(dayOf(row.last_seen_at))}${row.seen > 1 ? ` · seen ${row.seen} times` : ''}${row.redacted ? ' · secrets removed' : ''}</p>
${source}${actions}
</article>`;
    }

    async function knowledgePage(req, res) {
        const title = 'Knowledge';
        const head = header(title, 'What your runs learned, ready for the next one. Private until you share it.');
        if (!viewer(req)) return page(req, res, title, wrap(head + signIn(req)));
        const asked = String(req.query.tab || '');
        const tab = TABS.some(([id]) => id === asked) ? asked : 'all';
        let rows = [];
        let teams = [];
        let problem = null;
        try {
            const out = await rowsOf(req, res);
            rows = out.rows;
            teams = await teamsOf(req, res);
        } catch (e) {
            problem = e;
        }
        const mine = rows.filter((r) => r.subject === req.viewer.subject);
        const counts = {
            all: rows.length,
            lessons: rows.filter((r) => r.kind === 'lesson').length,
            facts: rows.filter((r) => r.kind === 'fact').length,
            pinned: rows.filter((r) => r.pinned).length,
            team: rows.filter((r) => r.visibility === 'team').length,
        };
        const shown = rows.filter(matches(tab));
        const tabs = `<nav class="c4-tabs" aria-label="Knowledge">${TABS.map(([id, label]) => {
            const n = counts[id];
            return `<a href="/knowledge?tab=${id}"${id === tab ? ' aria-current="page"' : ''}>${esc(`${label} (${n})`)}</a>`;
        }).join('')}</nav>`;
        const summary = `<div class="kn-summary"><div><strong>${mine.length}</strong><span>yours</span></div><div><strong>${counts.pinned}</strong><span>pinned</span></div><div><strong>${counts.team}</strong><span>shared</span></div></div>`;
        const empty = `<section class="c4-card c4-empty"><h2>${tab === 'all' ? 'Nothing learned yet' : 'Nothing here yet'}</h2><p>Run a task and Codes stores what it learned: what failed and why, the repository's commands, its traps. Every row is yours to edit, pin or delete.</p><p class="c4-hint">The first run has nothing to recall; the second one starts with it.</p></section>`;
        const content = `${head}${flash(req)}${problem ? note('Your knowledge could not be read right now. Try again in a moment.', 'bad') : ''}
${summary}
<p class="c4-hint">Private to you by default. Share a row with a team and its members can read it in their own runs; only you can edit or delete it.</p>
${addForm(teams)}
${tabs}
<div class="kn-list">${shown.length ? shown.map((row) => rowHtml(row, { mine: row.subject === req.viewer.subject, teams, tab })).join('') : empty}</div>`;
        return page(req, res, title, wrap(content));
    }

    router.get('/knowledge', knowledgePage);

    router.post('/knowledge', form, async (req, res) => {
        if (!viewer(req)) return res.redirect(303, '/auth/login?next=%2Fknowledge');
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        const b = req.body || {};
        try {
            const teams = await teamsOf(req, res);
            const teamId = b.team_id ? String(b.team_id) : '';
            if (teamId && !teams.some((t) => t.id === teamId)) throw Object.assign(new Error('you are not a member of that team'), { status: 403 });
            const out = await knowledge.remember({
                subject: req.viewer.subject, kind: b.kind, text: b.text, repo: b.repo || null,
                teamId: teamId || null, visibility: teamId ? 'team' : 'private',
            });
            return back(req, res, 'all', out.created ? 'Remembered.' : 'That was already here; it now counts one more sighting.');
        } catch (e) {
            return back(req, res, 'all', '', e.message || 'That row could not be saved.');
        }
    });

    router.post('/knowledge/:id/edit', form, async (req, res) => {
        if (!viewer(req)) return res.redirect(303, '/auth/login?next=%2Fknowledge');
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        if (!ID.test(String(req.params.id || ''))) return back(req, res, 'all', '', 'There is no such row.');
        try {
            const row = await knowledge.edit({ subject: req.viewer.subject, id: req.params.id, text: req.body.text, kind: req.body.kind });
            if (!row) return back(req, res, 'all', '', 'There is no such row of yours.');
            return back(req, res, 'all', 'Saved.');
        } catch (e) {
            return back(req, res, 'all', '', e.message || 'That row could not be saved.');
        }
    });

    router.post('/knowledge/:id/pin', form, async (req, res) => {
        if (!viewer(req)) return res.redirect(303, '/auth/login?next=%2Fknowledge');
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        if (!ID.test(String(req.params.id || ''))) return back(req, res, 'all', '', 'There is no such row.');
        const pinned = String((req.body && req.body.pinned) || '') === '1';
        const row = await knowledge.pin({ subject: req.viewer.subject, id: req.params.id, pinned });
        return back(req, res, String((req.body && req.body.tab) || 'all'), row ? (pinned ? 'Pinned.' : 'Unpinned.') : '');
    });

    router.post('/knowledge/:id/delete', form, async (req, res) => {
        if (!viewer(req)) return res.redirect(303, '/auth/login?next=%2Fknowledge');
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        if (!ID.test(String(req.params.id || ''))) return back(req, res, 'all', '', 'There is no such row.');
        const row = await knowledge.remove({ subject: req.viewer.subject, id: req.params.id });
        return back(req, res, 'all', row ? 'Deleted.' : '', row ? '' : 'There is no such row of yours.');
    });

    router.post('/knowledge/:id/share', form, async (req, res) => {
        if (!viewer(req)) return res.redirect(303, '/auth/login?next=%2Fknowledge');
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        if (!ID.test(String(req.params.id || ''))) return back(req, res, 'all', '', 'There is no such row.');
        const teamId = String((req.body && req.body.team_id) || '');
        try {
            const teams = await teamsOf(req, res);
            if (!teams.some((t) => t.id === teamId)) throw new Error('you are not a member of that team');
            const row = await knowledge.share({ subject: req.viewer.subject, id: req.params.id, teamId });
            return back(req, res, 'all', row ? 'Shared with your team.' : '', row ? '' : 'There is no such row of yours.');
        } catch (e) {
            return back(req, res, 'all', '', e.message || 'That row could not be shared.');
        }
    });

    router.post('/knowledge/:id/unshare', form, async (req, res) => {
        if (!viewer(req)) return res.redirect(303, '/auth/login?next=%2Fknowledge');
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        if (!ID.test(String(req.params.id || ''))) return back(req, res, 'all', '', 'There is no such row.');
        const row = await knowledge.unshare({ subject: req.viewer.subject, id: req.params.id });
        return back(req, res, 'all', row ? 'Private again.' : '', row ? '' : 'There is no such row of yours.');
    });

    return router;
}

module.exports = { createKnowledgeRoutes, TABS, dayOf, agoOf };
