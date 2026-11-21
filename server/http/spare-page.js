'use strict';
/**
 * Settings → Spare usage (/settings/spare; plan §AD.37). What each coding agent's plan has left and when it resets, the
 * list of things worth doing with what would otherwise be lost, and when the list may start them. The same list is in
 * the API (/api/v1/me/spare), so openvibe.my, Actor, Watch and the SDK use it too.
 */
const { asyncRouter } = require('./router');
const { esc } = require('../render/html');

const SPT = /^spt_[0-9A-HJKMNP-TV-Z]{26}$/;
const STATE_WORDS = { queued: 'Waiting', running: 'Running', done: 'Done', failed: 'Did not finish', paused: 'Paused' };

/** "in 5 h", "in 40 min", "in 2 days". */
function inWords(at, now = Date.now()) {
    const ms = Date.parse(at || '') - now;
    if (!Number.isFinite(ms)) return '';
    if (ms <= 0) return 'now';
    const min = Math.round(ms / 60000);
    if (min < 90) return `in ${min} min`;
    const h = Math.round(min / 60);
    return h < 48 ? `in ${h} h` : `in ${Math.round(h / 24)} days`;
}

function meter(a, now) {
    const bars = (a.windows || []).map((w) => {
        const used = w.used_pct == null ? null : Math.max(0, Math.min(100, w.used_pct));
        const tone = used == null ? '' : used >= 95 ? ' is-full' : used >= 80 ? ' is-low' : '';
        return `<div class="sp-window${tone}"><div class="sp-wline"><span>${esc(w.name)}</span><span>${used == null ? 'unknown' : `${100 - Math.round(used)}% left`}${w.resets_at ? ` · resets ${esc(inWords(w.resets_at, now))}` : ''}</span></div>`
            + `<div class="sp-bar" role="meter" aria-label="${esc(`${a.name || a.agent} ${w.name}`)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${used == null ? 0 : Math.round(used)}"><span style="width:${used == null ? 0 : used}%"></span></div></div>`;
    }).join('');
    return `<li class="sp-agent${a.take ? ' is-taking' : ''}"><div class="sp-ahead"><strong>${esc(a.name || a.agent)}</strong>${a.take ? '<span class="sp-chip">Takes the next task</span>' : ''}</div>${bars || '<p class="c4-hint">No window reported yet: its computer reports with the next heartbeat.</p>'}${a.why ? `<p class="c4-hint">${esc(a.why)}</p>` : ''}</li>`;
}

function createSparePage(ctx, { page, wrap, header, flash, sameOrigin, viewer, form, signIn }) {
    const r = asyncRouter();
    const { spare, harnesses, config, sso } = ctx;

    /** The project the list's tasks run in: the person's first one they may run jobs in, read with their token. */
    async function projectOf(req, res) {
        if (!sso || !config || !config.networkInternalUrl) return null;
        try {
            return await sso.asViewer(req, res, async (token) => {
                const out = await fetch(`${config.networkInternalUrl}/api/v1/projects`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
                if (!out.ok) return null;
                const p = ((await out.json()).projects || []).find((x) => ['owner', 'admin'].includes(x.role) && !x.archived_at);
                return p ? p.id : null;
            });
        } catch { return null; }
    }

    r.get('/settings/spare', async (req, res) => {
        if (!viewer(req)) return page(req, res, 'Spare usage', wrap(`${header('Spare usage')}${signIn(req)}`));
        const v = await spare.view(req.viewer.subject);
        const s = v.settings;
        const now = Date.now();
        const agentOptions = ['any', ...((harnesses && harnesses.list ? harnesses.list() : []).map((a) => a.id))];
        const names = new Map((harnesses && harnesses.list ? harnesses.list() : []).map((a) => [a.id, a.name || a.id]));
        const taskRow = (t) => `<li class="sp-task is-${esc(t.state)}"><div class="sp-tmain"><strong>${esc(t.title)}</strong><span class="c4-hint">${esc(STATE_WORDS[t.state] || t.state)} · ${esc(t.agent === 'any' ? 'any agent' : names.get(t.agent) || t.agent)} · priority ${t.priority}${t.repeat ? ' · comes back after each run' : ''}${t.repo ? ` · ${esc(t.repo)}` : ''}${t.runs ? ` · ran ${t.runs}×` : ''}</span>${t.note ? `<span class="c4-hint">${esc(t.note)}</span>` : ''}${t.task_id ? `<a href="/tasks/${esc(t.task_id)}">Its last run</a>` : ''}</div>`
            + `<form method="post" action="/settings/spare/tasks/${esc(t.id)}" class="sp-tact">${t.state === 'running' ? '' : t.state === 'paused' || t.state === 'done' || t.state === 'failed' ? '<button class="c4-button c4-button-light" name="do" value="queue">Queue it</button>' : '<button class="c4-button c4-button-light" name="do" value="pause">Pause</button>'}<button class="c4-button c4-button-light" name="do" value="remove">Remove</button></form></li>`;
        const content = `${header('Spare usage', 'Your plans reset on their own clock. What is left before a reset is lost: give it a list, and your agents use it up.')}${flash(req)}
<section class="c4-card"><h3 class="c4-subhead">What your agents have left</h3>
<ul class="sp-agents">${v.agents.length ? v.agents.map((a) => meter(a, now)).join('') : '<li class="c4-hint">Nothing reported yet. Sign your coding agents in on a computer with OpenVibe Link, and their windows show here.</li>'}</ul></section>
<section class="c4-card"><h3 class="c4-subhead">When the list may run</h3>
<form method="post" action="/settings/spare" class="sp-form">
<label class="c4-check"><input type="checkbox" name="enabled" value="true"${s.enabled ? ' checked' : ''}><span><b>Use spare usage on this list</b><small>An agent whose plan resets soon with time left, and that is not busy, works through the list below.</small></span></label>
<div class="sp-grid">
<label>Resets within <span class="sp-num"><input type="number" name="reset_within_hours" min="1" max="168" value="${s.reset_within_hours}" inputmode="numeric"> h</span></label>
<label>At least left <span class="sp-num"><input type="number" name="min_left_pct" min="1" max="100" value="${s.min_left_pct}" inputmode="numeric"> %</span></label>
<label>Keep back for you <span class="sp-num"><input type="number" name="keep_pct" min="0" max="50" value="${s.keep_pct}" inputmode="numeric"> %</span></label>
<label>At most at once <span class="sp-num"><input type="number" name="max_running" min="1" max="4" value="${s.max_running}" inputmode="numeric"></span></label>
</div>
<p class="c4-hint">An agent takes a task only when it is not working on anything of yours. Each task is an ordinary Codes task: its approvals and pull request are yours as always. The same list is in the API: <code>GET /api/v1/me/spare</code>.</p>
<div class="mp-savebar"><button class="c4-button" type="submit">Save</button></div></form></section>
<section class="c4-card"><h3 class="c4-subhead">The list</h3>
<ul class="sp-tasks">${v.tasks.length ? v.tasks.map(taskRow).join('') : '<li class="c4-hint">Nothing yet. Good spare-time work: tests for an untested module, accessibility fixes, docs that lag the code, a refactor you keep putting off.</li>'}</ul>
<form method="post" action="/settings/spare/tasks" class="sp-add">
<label>What to do <textarea name="prompt" rows="3" maxlength="8000" required placeholder="Add tests for server/domain/fleet.js and fix what they find."></textarea></label>
<label>Short name <input name="title" maxlength="120" placeholder="Fleet tests" autocomplete="off"></label>
<label>Repository <input name="repo" maxlength="300" required placeholder="owner/name or https://…" autocomplete="off" spellcheck="false"></label>
<label>Agent <select name="agent">${agentOptions.map((id) => `<option value="${esc(id)}">${esc(id === 'any' ? 'Any with time left' : names.get(id) || id)}</option>`).join('')}</select></label>
<label>Priority <select name="priority">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}"${n === 3 ? ' selected' : ''}>${n}${n === 1 ? ' (first)' : n === 5 ? ' (last)' : ''}</option>`).join('')}</select></label>
<label class="c4-check"><input type="checkbox" name="repeat" value="true"><span><b>Put it back on the list after each run</b><small>For chores worth repeating: tests, docs, an accessibility sweep.</small></span></label>
<div class="mp-savebar"><button class="c4-button" type="submit">Add to the list</button></div></form></section>`;
        page(req, res, 'Spare usage', wrap(content));
    });

    r.post('/settings/spare', form, async (req, res) => {
        if (!viewer(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent('/settings/spare')}`);
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        const b = req.body || {};
        try {
            await spare.saveSettings(req.viewer.subject, { ...b, enabled: b.enabled === 'true' }, { project: await projectOf(req, res) });
            return res.redirect(303, '/settings/spare?ok=Saved');
        } catch (e) {
            return res.redirect(303, `/settings/spare?error=${encodeURIComponent(String((e && e.message) || 'not saved').slice(0, 180))}`);
        }
    });
    r.post('/settings/spare/tasks', form, async (req, res) => {
        if (!viewer(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent('/settings/spare')}`);
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        try {
            await spare.add(req.viewer.subject, req.body || {});
            return res.redirect(303, '/settings/spare?ok=Added%20to%20the%20list');
        } catch (e) {
            return res.redirect(303, `/settings/spare?error=${encodeURIComponent(String((e && e.message) || 'not added').slice(0, 180))}`);
        }
    });
    r.post('/settings/spare/tasks/:id', form, async (req, res) => {
        if (!viewer(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent('/settings/spare')}`);
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        if (!SPT.test(req.params.id)) return res.redirect(303, '/settings/spare?error=No%20such%20task');
        const what = String((req.body || {}).do || '');
        try {
            if (what === 'remove') await spare.remove(req.viewer.subject, req.params.id);
            else await spare.update(req.viewer.subject, req.params.id, { state: what === 'pause' ? 'paused' : 'queued' });
            return res.redirect(303, '/settings/spare');
        } catch (e) {
            return res.redirect(303, `/settings/spare?error=${encodeURIComponent(String((e && e.message) || 'not changed').slice(0, 180))}`);
        }
    });
    return r;
}

module.exports = { createSparePage, inWords };
