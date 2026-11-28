'use strict';
/**
 * Loops (/loops; plan §AD.37, OpenVibe Loop; the owner, 2026-11-21: "a way better system more modular shared universal
 * as a product offering for openvibe and interconnected with codes actor"): the front door for evergreen checks. A loop
 * measures a product with real tools, fixes what matters most, proves the fix and opens a pull request, on the time the
 * person's coding-agent plans would otherwise lose (spare usage, domain/spare.js), then comes back for the next window.
 *
 * One page for everyone: the six loops and how they run (public, indexable); signed in, the person's loops with their
 * state and last run, starting one, and turning spare usage on. Every change posts to the spare list's own handlers
 * (http/spare-page.js) with back=/loops, so there is one set of rules for the list.
 */
const { asyncRouter } = require('./router');
const { esc, raw } = require('../render/html');
const { LOOPS } = require('../domain/loops');

const GLYPH = { accessibility: 'eye', security: 'shield', latency: 'gauge', tests: 'flask', docs: 'book', dependencies: 'box' };
const STATE = { queued: 'Waits for spare time', running: 'Running now', done: 'Done', failed: 'Did not finish', paused: 'Paused' };
const LEAD = 'Checks that keep your product right after it ships. Each loop measures with real tools, fixes what matters most, proves the fix and opens a pull request for you.';

const glyph = (name) => `<i data-ov-icon="${esc(name)}" aria-hidden="true"></i>`;
/** A repository as people say it: owner/name for GitHub, the address otherwise. */
const repoName = (repo) => String(repo || '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');

/** The loop a spare task is (its title is "<Name> loop"), with the live site its brief names. */
function loopOf(task) {
    const loop = LOOPS.find((l) => task.title === `${l.name} loop`);
    if (!loop) return null;
    const m = /\(live at (https:\/\/[^\s)]+)\)/.exec(String(task.prompt || ''));
    return { loop, site: m ? m[1] : null };
}

/** The six loops as tiles; with `pick`, each is a radio of the start form. */
function tiles(pick) {
    return `<div class="lp-tiles"${pick ? ' role="radiogroup" aria-label="Which loop"' : ''}>${LOOPS.map((l, i) => {
        const inner = `<span class="lp-glyph">${glyph(GLYPH[l.id] || 'check')}</span><span class="lp-tname">${esc(l.name)}</span><small>${esc(l.what)}</small>`;
        return pick
            ? `<label class="lp-tile"><input type="radio" name="loop" value="${esc(l.id)}"${i === 0 ? ' checked' : ''}>${inner}</label>`
            : `<div class="lp-tile">${inner}</div>`;
    }).join('')}</div>`;
}

const HOW = `<section class="c4-card lp-how" aria-labelledby="lp-how"><h2 id="lp-how">${glyph('list')}How a loop runs</h2><ol class="lp-steps">
<li>${glyph('hourglass')}<span><strong>On time you would lose</strong><small>When one of your coding agents (Claude Code, Codex, any you use) has plan time left just before it resets and is not busy, it takes the next loop.</small></span></li>
<li>${glyph('computer')}<span><strong>On your own computer</strong><small>Through OpenVibe Link, with your agent's own sign-in. No key leaves your machine.</small></span></li>
<li>${glyph('branch')}<span><strong>Ends in a pull request</strong><small>Each finding with its evidence, the check before and after, and screenshots at phone and desktop sizes. You review it; nothing merges by itself. A run that finds nothing changes nothing.</small></span></li>
</ol><p class="c4-hint">The same loops are in the API (<code>GET /api/v1/me/spare/loops</code>, <code>POST /api/v1/me/spare/tasks { loop, repo, site }</code>), so Actor, openvibe.my and the SDK start them too.</p></section>`;

/** The page a visitor (and the Markdown twin, llms-full.txt) gets: the six loops and how they run. */
function publicView() {
    return {
        agent: true, index: true, title: 'Loops', description: LEAD,
        body: raw(`<h1>Loops</h1><p class="lead">${esc(LEAD)}</p><h2>Six loops</h2><ul>${LOOPS.map((l) => `<li><strong>${esc(l.name)}</strong>: ${esc(l.what)}</li>`).join('')}</ul>${HOW}`),
    };
}

function createLoopsPage(ctx, { page, wrap, header, flash, viewer }) {
    const r = asyncRouter();
    const { spare } = ctx;

    r.get('/loops', async (req, res) => {
        const extra = { index: true, description: LEAD };
        if (!viewer(req) || !spare) {
            const body = `${header('Loops', LEAD)}<section class="c4-card" aria-labelledby="lp-six"><h2 id="lp-six">${glyph('infinity')}Six loops</h2>${tiles(false)}</section>${HOW}`
                + `<section class="c4-card c4-empty"><h2>Start a loop on your own repository</h2><p>Loops run on your coding agents' spare time, through your OpenVibe account.</p><a class="c4-button" href="/auth/login?next=${encodeURIComponent('/loops')}">Sign in</a></section>`;
            return page(req, res, 'Loops', wrap(body), extra);
        }
        const v = await spare.view(req.viewer.subject);
        const mine = v.tasks.map((t) => ({ t, l: loopOf(t) })).filter((x) => x.l);
        const off = !v.settings.enabled;
        const s = v.settings;
        const switchOn = off
            ? `<section class="c4-card lp-off" role="status"><div class="lp-offline">${glyph('hourglass')}<span><strong>Spare usage is off</strong><small>Loops wait for it: turn it on and your agents work through your loops before their plans reset.</small></span></div>`
                + `<form method="post" action="/settings/spare"><input type="hidden" name="back" value="/loops"><input type="hidden" name="enabled" value="true">`
                + ['reset_within_hours', 'min_left_pct', 'keep_pct', 'max_running'].map((k) => `<input type="hidden" name="${k}" value="${esc(String(s[k]))}">`).join('')
                + '<button class="c4-button" type="submit">Turn on spare usage</button> <a class="c4-link" href="/settings/spare">Settings</a></form></section>'
            : '';
        const row = ({ t, l }) => `<li class="lp-row is-${esc(t.state)}"><span class="lp-glyph">${glyph(GLYPH[l.loop.id] || 'check')}</span>`
            + `<div class="lp-rmain"><strong>${esc(l.loop.name)}</strong><span class="c4-hint">${esc(repoName(t.repo))}${l.site ? ` · ${esc(l.site.replace(/^https:\/\//, ''))}` : ''}</span>`
            + `<span class="lp-meta"><span class="lp-state">${esc(STATE[t.state] || t.state)}</span>${t.runs ? `<span>ran ${t.runs}×</span>` : ''}${t.task_id ? `<a href="/tasks/${esc(t.task_id)}">The last run</a>` : ''}</span></div>`
            + `<form method="post" action="/settings/spare/tasks/${esc(t.id)}" class="lp-act"><input type="hidden" name="back" value="/loops">`
            + (t.state === 'running' ? '' : t.state === 'queued'
                ? `<button class="c4-button c4-button-light" name="do" value="pause">${glyph('pause')}Pause</button>`
                : `<button class="c4-button c4-button-light" name="do" value="queue">${glyph('play')}Queue it</button>`)
            + `<button class="c4-button c4-button-light" name="do" value="remove" aria-label="Remove the ${esc(l.loop.name)} loop">${glyph('trash')}</button></form></li>`;
        const body = `${header('Loops', LEAD)}${flash(req)}${switchOn}
<section class="c4-card" aria-labelledby="lp-mine"><h2 id="lp-mine">${glyph('infinity')}Your loops</h2>${mine.length
        ? `<ul class="lp-rows">${mine.map(row).join('')}</ul>`
        : '<p class="c4-hint">None yet. Start one below: it waits for your agents\' spare time, then opens a pull request.</p>'}</section>
<section class="c4-card" aria-labelledby="lp-start"><h2 id="lp-start">${glyph('play')}Start a loop</h2>
<form method="post" action="/settings/spare/loops" class="sp-add lp-start"><input type="hidden" name="back" value="/loops">${tiles(true)}
<label>Repository <input name="repo" maxlength="300" required placeholder="owner/name or https://…" autocomplete="off" spellcheck="false"></label>
<label>Live site <span class="c4-hint">optional: where the checks look</span><input name="site" type="url" maxlength="300" placeholder="https://…" autocomplete="off"></label>
<div class="mp-savebar"><button class="c4-button" type="submit">Start the loop</button></div></form></section>${HOW}`;
        return page(req, res, 'Loops', wrap(body), extra);
    });
    return r;
}

module.exports = { createLoopsPage, publicView, loopOf, LEAD };
