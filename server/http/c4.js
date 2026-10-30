'use strict';

/**
 * Phone-first Codes workspace (C4, finished in C4b). Pages stay useful without JavaScript: every panel is
 * server-rendered, and the script only adds the repository search and the fold-out proofs' details.
 *
 *   /                 the composer with the person's saved repositories and machines (last used first), running work
 *   /tasks, /tasks/:id  the person's tasks; a task's Live, Changes, Proof and Pull request panels are Codes' own
 *   /agents           the person's connections: their provider keys (they live in OpenVibe.AI), added, tested, removed
 *   /machines         their paired Node machines, their state, and Node's pairing flow with a one-time code
 *   /usage            what Codes knows: runs, minutes and tokens per day (no prices: Billing is Billing's)
 *   /settings         their choices, remembered per person (codes_user_settings)
 *
 * Every write is a form post from this site (Origin checked), every read is the signed-in person's own.
 */
const express = require('express');
const { send } = require('../render/layout');
const { raw, esc } = require('../render/html');
const { asyncRouter } = require('./router');
const showcase = require('openvibe-shared/showcase');
const { homeJsonLd } = require('./discovery');

const LINKS = [
    ['Home', '/', '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'],
    ['Tasks', '/tasks', '<path d="M8 6h12M8 12h12M8 18h12M3 6h.01M3 12h.01M3 18h.01"/>'],
    ['Agents', '/agents', '<circle cx="12" cy="8" r="3"/><path d="M5 20a7 7 0 0 1 14 0M12 2v3M3 8h3m12 0h3"/>'],
    ['Machines', '/machines', '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>'],
    ['Usage', '/usage', '<path d="M4 19V5m0 14h17M8 15v-4m5 4V7m5 8v-6"/>'],
    ['Settings', '/settings', '<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.7 1l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.7-1l-1.7.7-1.4-2.4 1.4-1.1a8 8 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.7.7a8 8 0 0 1 1.7-1l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.7 1l1.7-.7 1.4 2.4-1.4 1.1a8 8 0 0 1 0 2Z"/>'],
];
const stateLabel = (s) => ({ running: 'Running', queued: 'Queued', placed: 'On its way', done: 'Done', succeeded: 'Done', failed: "Didn't finish", cancelled: 'Stopped by you', expired: 'Expired' }[s] || s || 'Unknown');
const safeId = (s) => /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(s || ''));
const money = (n) => Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : '—';
const age = (value) => {
    const numeric = Number(value);
    const ms = Number.isFinite(numeric) && numeric > 0 ? numeric : new Date(value).getTime();
    if (!Number.isFinite(ms)) return '';
    const mins = Math.max(0, Math.floor((Date.now() - ms) / 60000));
    return mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.floor(mins / 60)}h ago` : `${Math.floor(mins / 1440)}d ago`;
};
const repoDetails = (repo) => {
    try {
        const url = new URL(String(repo || ''));
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        url.username = '';
        url.password = '';
        const parts = url.pathname.split('/').filter(Boolean);
        const label = parts.at(-1)?.replace(/\.git$/i, '') || url.hostname;
        return { label, href: url.toString() };
    } catch { return null; }
};
const icon = (path) => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const asObject = (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); return p && typeof p === 'object' && !Array.isArray(p) ? p : null; } catch { return null; } }
    return null;
};
const PROVIDER_NAMES = { anthropic: 'Anthropic', openai: 'OpenAI', deepseek: 'DeepSeek', minimax: 'MiniMax', openrouter: 'OpenRouter', custom: 'Custom (OpenAI-compatible)' };

function createC4Routes(ctx) {
    const r = asyncRouter();
    const { config, store, harnesses, tasks, sso, connections, machines, userSettings, github, usage } = ctx;
    const db = store.db;
    const form = express.urlencoded({ extended: false, limit: '16kb' });
    const page = (req, res, title, body, extra = {}) => {
        const wantsScript = req.path === '/' || /^\/tasks\/tsk_/.test(req.path) || /^\/(agents|machines)/.test(req.path);
        return send(res, 200, { viewer: req.viewer, config, path: req.originalUrl, ...(title ? { title: `${title} · Codes` } : {}), css: ['css/c4.css'], scripts: wantsScript ? ['js/c4.js'] : [], body: raw(body), ...extra });
    };
    const viewer = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const wrap = (current, content, signedIn = false) => `<div class="c4"><div class="c4-layout"><aside class="c4-side"><nav aria-label="Workspace">${LINKS.map(([label, href, svg]) => `<a href="${href}"${current === href ? ' aria-current="page"' : ''}>${icon(svg)}<span>${label}</span></a>`).join('')}</nav></aside><main class="c4-main">${content}</main></div><nav class="c4-mobile" aria-label="Workspace">${LINKS.slice(0, 5).map(([label, href, svg]) => `<a href="${href}"${current === href ? ' aria-current="page"' : ''}>${icon(svg)}<span>${label}</span></a>`).join('')}</nav></div>`;
    const signIn = (req) => `<section class="c4-card c4-empty"><h2>Sign in to see your work</h2><p>Your tasks, machines and usage belong to your OpenVibe account.</p><a class="c4-button" href="/auth/login?next=${encodeURIComponent(req.originalUrl || '/')}">Sign in</a></section>`;
    const sameOrigin = (req) => {
        const origin = req.get('origin');
        if (!origin) return true;
        try { return new URL(origin).origin === new URL(config.baseUrl).origin; } catch { return false; }
    };
    const flash = (req) => {
        const ok = String(req.query.ok || '').slice(0, 120);
        const error = String(req.query.error || '').slice(0, 200);
        return `${ok ? `<div class="notice c4-notice" role="status">${esc(ok)}</div>` : ''}${error ? `<div class="notice c4-notice c4-notice-bad" role="alert">${esc(error)}</div>` : ''}`;
    };
    const note = (text, kind = '') => `<div class="notice c4-notice${kind ? ` c4-notice-${kind}` : ''}" role="status">${text}</div>`;
    const pill = (text, kind = '') => `<span class="c4-pill${kind ? ` c4-pill-${kind}` : ''}">${esc(text)}</span>`;

    async function ownTasks(req, limit = 100) {
        if (!viewer(req)) return [];
        return db.many('SELECT * FROM run_tasks WHERE subject = $1 ORDER BY created_at DESC LIMIT $2', [req.viewer.subject, limit]);
    }
    /** The person's machines, read with their own token; a Network that does not answer is said, not hidden. */
    async function machinesOf(req, res = null) {
        if (!viewer(req)) return { ok: false, machines: [] };
        try {
            return await sso.asViewer(req, res, (token) => machines.list(token));
        } catch (e) {
            return { ok: false, machines: [], problem: { status: e && e.status, detail: 'your machines could not be read: sign in again' } };
        }
    }
    /** The person's own recent repositories (no GitHub call): what the pickers offer first. */
    async function recentRepos(req, limit = 8) {
        if (!viewer(req)) return [];
        try { return await github.recent(req.viewer.subject, limit); } catch { return []; }
    }
    /** The machines the person's tasks ran on, most recently first: the picker's order. */
    async function lastUsedMachines(req, limit = 20) {
        if (!viewer(req)) return [];
        try {
            const rows = await db.many(
                `SELECT a.machine, max(COALESCE(a.finished_at, a.started_at, a.created_at)) AS at
                   FROM codes_attempts a JOIN run_tasks t ON t.id = a.task_id
                  WHERE t.subject = $1 AND a.machine IS NOT NULL GROUP BY a.machine ORDER BY at DESC LIMIT $2`,
                [req.viewer.subject, limit],
            );
            return rows.map((r) => String(r.machine));
        } catch { return []; }
    }
    /**
     * The person's machines in the order they read: the ones their work ran on last come first, the ones never used
     * come after them. Their saved default is marked, not moved: the order the brief asks for is the order of use.
     */
    const orderMachines = (list, used) => {
        const rank = new Map(used.map((m, i) => [m, i]));
        const rankOf = (m) => (rank.has(m.id) ? rank.get(m.id) : rank.has(m.node_id) ? rank.get(m.node_id) : 1e6);
        return [...(list || [])].sort((a, b) => rankOf(a) - rankOf(b));
    };
    /** One machine as a picker option: its name, its state, and whether it is the person's saved default. */
    const machineOption = (m, settings) => {
        const saved = settings && settings.default_machine === m.id;
        const state = m.state === 'online' ? '' : m.state === 'revoked' ? ' (revoked)' : ' (seen before)';
        return `<option value="${esc(m.id)}"${saved ? ' selected' : ''}>${esc(m.name || m.node_id || m.id)}${state}${saved ? ' · your default' : ''}</option>`;
    };

    const taskHref = (row) => `/tasks/${encodeURIComponent(row.id)}`;
    const rowHtml = (row) => {
        const repo = repoDetails(row.repo);
        const attempts = Number(row.attempts_count || row.result?.attempts?.length || row.result?.attempts || 0);
        const meta = [repo?.label || 'Project not set', row.agent || 'Auto', age(row.created_at), attempts > 1 ? `${attempts} attempts` : ''].filter(Boolean).map(esc).join(' · ');
        return `<a class="c4-task" href="${taskHref(row)}"><span class="c4-status-dot c4-${esc(row.state)}" aria-label="${esc(stateLabel(row.state))}"></span><span class="c4-task-title">${esc(row.prompt || repo?.label || 'Coding task')}</span><span class="c4-task-meta">${meta}</span></a>`;
    };
    const header = (title, desc = '') => `<div class="c4-title"><div><h1>${esc(title)}</h1>${desc ? `<p>${esc(desc)}</p>` : ''}</div></div>`;
    const stateChip = (state) => `<span class="c4-status c4-${esc(state)}">${esc(stateLabel(state))}</span>`;
    const taskChips = (row, machineName = null) => {
        const repo = repoDetails(row.repo);
        const chips = [
            repo ? `<a class="c4-chip" href="${esc(repo.href)}" rel="noopener noreferrer">${esc(repo.label)}</a>` : '<span class="c4-chip">Project not set</span>',
            `<span class="c4-chip">${esc(row.ref || 'default branch')}</span>`,
            `<span class="c4-chip">${esc(row.agent || 'Auto')}</span>`,
            `<span class="c4-chip">${esc(machineName || 'Your computer')}</span>`,
            `<span class="c4-chip">${esc(money(row.result && row.result.cost_usd))}</span>`,
        ];
        return `<div class="c4-chips" aria-label="Task details">${chips.join('')}</div>`;
    };

    // ── The outcome row: one calm row, with pill actions ────────────────────────────────────────────────────────
    const outcomeRow = (row) => {
        const hasOutcome = row.outcome === 'unfinished' || Boolean(row.error);
        if (!hasOutcome) return '';
        const prompt = encodeURIComponent(row.prompt || '');
        const retry = `/run?prompt=${prompt}&repo=${encodeURIComponent(row.repo || '')}&agent=${encodeURIComponent(row.agent || '')}`;
        const switchAgent = `/run?prompt=${prompt}&repo=${encodeURIComponent(row.repo || '')}`;
        return `<div class="c4-outcome" data-c4-outcome><span class="c4-obadge" aria-hidden="true">${icon('<path d="m18 6-12 12M6 6l12 12"/>')}</span><div class="c4-outcome-copy"><b>Didn't finish</b><span data-outcome-reason>${esc(row.outcome_note || row.error || 'The task stopped before it was complete.')}</span></div><div class="c4-outcome-actions"><a class="c4-opill c4-opill-primary" href="${retry}">${icon('<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9a7 7 0 0 1 11.7-2L20 12M4 12l2.7 5a7 7 0 0 0 11.7-2"/>')}<span>Retry</span></a><a class="c4-opill" href="${switchAgent}">${icon('<path d="m16 3 4 4-4 4M4 7h16M8 21l-4-4 4-4m12 4H4"/>')}<span>Switch</span></a><a class="c4-opill" href="/tasks">${icon('<path d="m5 12 4 4L19 6"/>')}<span>Fine</span></a></div></div>`;
    };

    /** One proof line: a calm row that folds out to its detail. ok / skipped / failed is on the row itself. */
    const proofRow = (item) => {
        const state = item.skipped ? 'skip' : (item.ok ? 'ok' : 'bad');
        const word = item.skipped ? 'Skipped' : (item.ok ? 'Passed' : 'Failed');
        const detail = asObject(item.detail) || {};
        let body = '';
        if (item.kind === 'tests') {
            body = `${detail.command ? `<p class="c4-kv"><span>Command</span><code>${esc(detail.command)}</code></p>` : ''}${item.summary ? `<pre tabindex="0" class="c4-code c4-code-small">${esc(item.summary)}</pre>` : '<p class="c4-muted">No output was kept.</p>'}`;
        } else if (item.kind === 'screenshots') {
            const shots = Array.isArray(detail.shots) ? detail.shots : [];
            body = shots.length
                ? `<ul class="c4-shots">${shots.map((s) => {
                    const image = typeof s.data === 'string' && /^data:image\//.test(s.data) ? s.data : (typeof s.thumb === 'string' && /^data:image\//.test(s.thumb) ? s.thumb : null);
                    const label = `${s.route || '/'} at ${Number(s.width) || 0} px`;
                    const state = s.skipped ? 'Skipped' : (s.ok === false ? 'Failed' : 'Passed');
                    const tile = image
                        ? `<a class="c4-shot" href="${esc(image)}" target="_blank" rel="noopener"><img src="${esc(image)}" alt="${esc(label)}" loading="lazy" decoding="async"><span>${esc(label)}</span>${pill(state, s.ok === false ? 'bad' : 'ok')}</a>`
                        : `<span class="c4-shot c4-shot-ghost">${icon('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>')}<span>${esc(label)}</span>${pill(state, s.ok === false ? 'bad' : 'ok')}</span>`;
                    const why = [s.summary, s.overflow ? 'the page scrolls sideways at this width' : null, Array.isArray(s.errors) && s.errors.length ? `the page threw: ${s.errors[0]}` : null].filter(Boolean)[0];
                    return `<li>${tile}${why ? `<p class="c4-shot-why">${esc(why)}</p>` : ''}</li>`;
                }).join('')}</ul><p class="c4-hint">The pictures stay on the machine that took them${shots.some((s) => s && s.path) ? ' (kept there as PNG files)' : ''}; the row carries what each one found.</p>`
                : '<p class="c4-muted">No page was shot for this task.</p>';
        } else if (item.kind === 'diff') {
            const files = Array.isArray(detail.files) ? detail.files : [];
            body = `${detail.stats ? `<pre tabindex="0" class="c4-code c4-code-small">${esc(detail.stats)}</pre>` : ''}${files.length ? `<ul class="c4-filelist">${files.map((f) => `<li><code>${esc(f)}</code></li>`).join('')}</ul>` : ''}${!detail.stats && !files.length ? '<p class="c4-muted">The diff was not kept with the proof.</p>' : ''}`;
        } else if (item.kind === 'review') {
            body = `<p class="c4-kv"><span>Reviewer</span><b>${esc(item.family || 'another model')}</b></p>${item.summary ? `<p class="c4-review">${esc(item.summary)}</p>` : ''}`;
        } else {
            body = item.summary ? `<p class="c4-review">${esc(item.summary)}</p>` : '<p class="c4-muted">Nothing more was kept.</p>';
        }
        return `<li class="c4-fold-row"><details class="c4-fold"><summary><span class="c4-row-dot c4-dot-${state}" aria-hidden="true"></span><span class="c4-row-label">${esc(item.label || item.kind)}</span><span class="c4-row-note">${esc(item.summary || (item.skipped ? 'it could not run here' : ''))}</span>${pill(word, state === 'ok' ? 'ok' : state === 'skip' ? 'skip' : 'bad')}</summary><div class="c4-row-body">${body}</div></details></li>`;
    };

    /** The Changes panel: the changed files first, then the diff itself, folded out. */
    const changesPanel = (row) => {
        const result = asObject(row.result) || {};
        const files = Array.isArray(result.files) ? result.files.filter((f) => f && f.path) : [];
        const patch = typeof result.patch === 'string' ? result.patch : '';
        if (!files.length && !patch) {
            return `<p class="c4-muted">${['queued', 'placed', 'running'].includes(row.state) ? 'The changes appear here when the task ends.' : 'This task changed no files.'}</p>`;
        }
        const added = files.reduce((n, f) => n + (Number(f.added) || 0), 0);
        const removed = files.reduce((n, f) => n + (Number(f.removed) || 0), 0);
        return `<p class="c4-panel-lede">${files.length} file${files.length === 1 ? '' : 's'} changed · <span class="c4-add">+${added}</span> <span class="c4-del">−${removed}</span></p>
${files.length ? `<ul class="c4-filelist c4-filelist-counts">${files.map((f) => `<li><code>${esc(f.path)}</code><span class="c4-add">+${f.added == null ? '·' : esc(f.added)}</span><span class="c4-del">−${f.removed == null ? '·' : esc(f.removed)}</span></li>`).join('')}</ul>` : ''}
${patch ? `<details class="c4-fold c4-fold-wide"><summary><span class="c4-row-label">The diff</span><span class="c4-row-note">${result.patch_truncated ? 'cut to fit' : `${patch.split('\n').length} lines`}</span>${pill('Show', 'skill')}</summary><div class="c4-row-body"><pre tabindex="0" class="c4-diff">${esc(patch)}</pre></div></details>` : ''}`;
    };

    /** The Pull request panel: the link, its CI state and its merge state when the task opened one. */
    const pullRequestPanel = async (row) => {
        const result = asObject(row.result) || {};
        const push = asObject(result.push) || {};
        const href = typeof push.pull_request === 'string' ? push.pull_request : null;
        if (!href) {
            const why = push.pull_request_error
                ? `The pull request was not opened: ${esc(push.pull_request_error)}`
                : (push.pushed ? 'The branch was pushed, but no pull request was asked for.' : (!row.pull_request ? 'This task did not ask for a pull request.' : 'The task did not reach the push.'));
            const prompt = encodeURIComponent(row.prompt || '');
            return `<p class="c4-muted">${why}</p>${push.branch_url ? `<p class="c4-muted">Branch: <a href="${esc(push.branch_url)}" rel="noopener noreferrer">${esc(push.branch || 'the new branch')}</a></p>` : ''}<p><a class="c4-opill" href="/run?prompt=${prompt}&repo=${encodeURIComponent(row.repo || '')}&push=1&pull_request=1">${icon('<path d="M6 3v12a3 3 0 0 0 3 3h6"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/>')}<span>Start one with a pull request</span></a></p>`;
        }
        const pr = await github.pullRequest(href);
        const stateWord = pr.problem ? 'Not read' : (pr.state === 'merged' ? 'Merged' : pr.state === 'closed' ? 'Closed' : 'Open');
        const stateKind = pr.problem ? 'skip' : (pr.state === 'merged' ? 'ok' : pr.state === 'closed' ? 'bad' : 'open');
        return `<div class="c4-rows"><div class="c4-row c4-row-flat"><span class="c4-row-dot c4-dot-${stateKind}" aria-hidden="true"></span><span class="c4-row-label">Pull request #${esc(pr.number || '')}</span><span class="c4-row-note">${esc(pr.title || `${pr.owner || ''}/${pr.name || ''}`)}</span>${pill(stateWord, stateKind)}</div>
<div class="c4-pr-actions"><a class="c4-opill c4-opill-primary" href="${esc(href)}" rel="noopener noreferrer">${icon('<path d="M14 3h7v7M21 3l-9 9"/><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>')}<span>Open on GitHub</span></a>${pr.branch ? `<span class="c4-chip">${esc(pr.branch)} → ${esc(pr.base || 'base')}</span>` : ''}</div>
${pr.problem ? `<p class="c4-hint">${esc(pr.problem.detail)}</p>` : `<dl class="c4-facts"><div><dt>CI</dt><dd>${pill(pr.ci || 'No checks reported', pr.ci === 'Passed' ? 'ok' : pr.ci === 'Failed' || pr.ci === 'Errored' ? 'bad' : 'skip')}</dd></div><div><dt>Merge</dt><dd>${pill(pr.merge || 'Open', pr.state === 'merged' ? 'ok' : pr.merge === 'Has conflicts' ? 'bad' : 'skip')}</dd></div><div><dt>Checked</dt><dd>${esc(age(pr.checked_at))}</dd></div></dl>`}</div>`;
    };

    // ── Home ────────────────────────────────────────────────────────────────────────────────────────────────────
    r.get('/', async (req, res) => {
        const rows = await ownTasks(req, 8);
        const signedIn = !!viewer(req);
        const settings = signedIn ? await userSettings.get(req.viewer.subject) : null;
        const repos = signedIn ? await recentRepos(req) : [];
        const mine = signedIn ? await machinesOf(req, res) : { ok: false, machines: [] };
        const used = signedIn ? await lastUsedMachines(req) : [];
        const machineList = orderMachines(mine.machines, used);
        const agentOptions = (harnesses?.list?.() || []).map((a) => `<option value="${esc(a.id)}"${settings && settings.default_agent === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
        const machineOptions = machineList.map((m) => machineOption(m, settings)).join('');
        const saved = repos.map((repo) => `<a class="c4-chip" href="/?repo=${encodeURIComponent(repo.url)}#c4-prompt" data-c4-saved-repo="${esc(repo.url)}">${icon('<path d="M4 4h16v16l-8-4-8 4z"/>')}${esc(repo.full_name)}</a>`).join('');
        const content = `${header(signedIn ? 'Home' : 'Every coding agent. One place.', signedIn ? '' : 'Your keys, your machines. Tell an agent what to do and follow the work from your phone.')}
<section class="c4-card c4-composer"><form method="post" action="/start"><label for="c4-prompt">What should an agent do?</label><textarea id="c4-prompt" name="prompt" placeholder="Describe the change, question or fix" required></textarea><div class="c4-controls"><label class="c4-field-repo">Project<input type="url" name="repo" value="${esc(String(req.query.repo || ''))}" placeholder="Paste a repository URL" autocomplete="url" list="c4-repo-options" data-c4-repo-search data-c4-repo-url="/api/v1/me/repos"><datalist id="c4-repo-options">${repos.map((repo) => `<option value="${esc(repo.url)}">${esc(repo.full_name)}</option>`).join('')}</datalist></label><label>Agent <select name="agent"><option value="">Auto</option>${agentOptions}</select></label><label>Machine <select name="machine"><option value="">Auto</option>${machineOptions}</select></label><label>Cost cap <select name="cap"><option>$1.00</option><option>$5.00</option></select></label><button class="c4-button" type="submit">Start a task</button></div><p class="c4-hint">Run places the task on one of your own machines; the machine and agent you pick are saved as your defaults.<span class="c4-hint-status" data-c4-repo-status role="status"></span></p>${saved ? `<div class="c4-chips c4-saved" aria-label="Saved repositories">${saved}</div>` : ''}</form></section>
<div class="c4-grid"><section class="c4-card"><div class="c4-card-head"><h2>Running</h2><a href="/tasks?state=running">All tasks</a></div>${rows.filter((x) => !['done', 'succeeded', 'failed', 'cancelled'].includes(x.state)).slice(0, 4).map(rowHtml).join('') || '<div class="c4-emptyline">No tasks running yet. <a href="/#c4-prompt">Start a task</a></div>'}</section><section class="c4-card"><div class="c4-card-head"><h2>Needs you</h2><span class="c4-muted">Approvals and questions</span></div><div class="c4-emptyline">Nothing needs your attention. <a href="/tasks">View tasks</a></div></section></div>
<section class="c4-card"><div class="c4-card-head"><h2>Recent tasks</h2><a href="/tasks">View all</a></div>${rows.slice(0, 5).map(rowHtml).join('') || '<div class="c4-emptyline">No tasks yet. <a href="/#c4-prompt">Start a task</a></div>'}</section>
${signedIn && !mine.ok && mine.problem ? note(`Your machines could not be read, so the machine picker has only Auto. ${esc(mine.problem.detail || '')}`, 'bad') : ''}
${signedIn ? '' : `<section class="c4-reasons"><h2>Built for the way you work</h2><div class="c4-grid">${[['Any agent', 'Bring a key or plan. Auto picks a good fit and can hand over when one gets stuck.'], ['Your computer or ours', 'Pair your computer with one command. A hosted sandbox is coming soon.'], ['Proof you can inspect', 'See the changes, tests, screenshots and review before you approve.'], ['A cost you can follow', 'Track task costs and plan limits. Set caps that stop with a wrap-up.']].map(([a, b]) => `<article><h3>${a}</h3><p>${b}</p></article>`).join('')}</div></section>`}`;
        page(req, res, null, wrap('/', content, signedIn), signedIn ? {} : { index: true, styles: [showcase.STYLESHEET], jsonLd: homeJsonLd(config) });
    });

    /**
     * The composer's first step: the pickers are saved for this person, then Run's own form opens with the task
     * prefilled. Saving is best effort — a picker that cannot be saved must not stop the task.
     */
    r.post('/start', form, async (req, res) => {
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        const b = req.body || {};
        if (viewer(req) && (b.machine || b.agent)) {
            try {
                await userSettings.save(req.viewer.subject, {
                    ...(b.machine ? { default_machine: b.machine } : {}),
                    ...(b.agent ? { default_agent: b.agent } : {}),
                });
            } catch (e) { /* a picker that cannot be saved does not stop the task */ }
        }
        const q = new URLSearchParams();
        for (const key of ['prompt', 'repo', 'agent']) if (b[key]) q.set(key, String(b[key]).slice(0, key === 'prompt' ? 16000 : 300));
        return res.redirect(303, `/run${q.toString() ? `?${q}` : ''}`);
    });

    r.get('/tasks', async (req, res) => {
        const rows = await ownTasks(req);
        const q = String(req.query.q || '').toLowerCase();
        const filtered = rows.filter((x) => `${x.prompt} ${repoDetails(x.repo)?.label || ''} ${x.agent}`.toLowerCase().includes(q));
        const isDone = (x) => ['done', 'succeeded', 'cancelled'].includes(x.state);
        const groups = [
            ['Running', filtered.filter((x) => !isDone(x) && x.state !== 'failed')],
            ['Needs you', []],
            ['Done', filtered.filter(isDone)],
            ["Didn't finish", filtered.filter((x) => x.state === 'failed')],
        ];
        const taskList = filtered.length ? groups.filter(([, items]) => items.length).map(([label, items]) => `<section class="c4-card"><div class="c4-card-head"><h2>${label}</h2></div>${items.map(rowHtml).join('')}</section>`).join('') : `<div class="c4-card c4-emptyline">${q ? 'No matching tasks.' : 'No tasks yet.'} <a href="${q ? '/tasks' : '/#c4-prompt'}">${q ? 'Clear search' : 'Start a task'}</a></div>`;
        const content = `${header('Tasks')}${viewer(req) ? `<form class="c4-search" method="get"><label for="task-search">Search your tasks</label><input id="task-search" name="q" value="${esc(q)}" placeholder="Search by task, project or agent"><button class="c4-button c4-button-light">Search</button></form>${taskList}` : signIn(req)}`;
        page(req, res, 'Tasks', wrap('/tasks', content, !!viewer(req)));
    });

    r.get('/tasks/:id', async (req, res) => {
        if (!viewer(req)) return page(req, res, 'Task', wrap('/tasks', `${header('Task')}${signIn(req)}`));
        if (!safeId(req.params.id)) return res.status(404).send('Not found');
        const row = await db.maybe('SELECT * FROM run_tasks WHERE id = $1 AND subject = $2', [req.params.id, req.viewer.subject]);
        if (!row) return res.status(404).send('Not found');
        const live = ['queued', 'placed', 'running'].includes(row.state);
        const attempts = tasks?.attempts ? await tasks.attempts.list(row.id) : [];
        const attemptItems = attempts.map((attempt) => {
            const item = tasks.attempts.present(attempt);
            return `<li class="c4-attempt" data-attempt-n="${Number(item.n)}">Attempt ${Number(item.n)} · ${esc(item.agent || 'Auto')} · ${esc(item.end_why || item.state || 'Queued')}</li>`;
        }).join('');
        // The machine the task ran on, in the person's own words when their list knows it: never a bare principal id.
        let machineName = attempts.map((a) => a.machine).filter(Boolean).at(-1) || null;
        if (machineName) {
            const known = await machinesOf(req, res);
            const hit = (known.machines || []).find((m) => m.id === machineName || m.node_id === machineName);
            machineName = hit ? (hit.name || hit.node_id || 'Your machine') : (/^nod_/.test(machineName) ? 'Your machine' : machineName);
        }
        const taskApi = `/api/v1/tasks/${encodeURIComponent(row.id)}`;
        const events = `${taskApi}/events`;
        const prompt = encodeURIComponent(row.prompt || '');
        const retry = `/run?prompt=${prompt}&repo=${encodeURIComponent(row.repo || '')}&agent=${encodeURIComponent(row.agent || '')}`;
        const switchAgent = `/run?prompt=${prompt}&repo=${encodeURIComponent(row.repo || '')}`;
        const progress = live ? `<button class="c4-progress-toggle" type="button" aria-expanded="false" aria-controls="live-content"><span data-progress-title>Working on your task</span><span class="c4-progress-meta"><span data-progress-steps>0 steps</span> · <span data-progress-time>now</span></span><span aria-hidden="true">⌄</span></button>` : '';
        const proofItems = tasks?.proof ? tasks.proof.present(await tasks.proof.list(row.id)) : [];
        const resultNow = asObject(row.result) || {};
        const hasChanges = (Array.isArray(resultNow.files) && resultNow.files.length > 0) || typeof resultNow.patch === 'string';
        // A finished task opens on what it proved; a running one opens on its live lines.
        const preferredTab = live ? 'live' : (proofItems.length ? 'proof' : (hasChanges ? 'changes' : 'live'));
        const proofPanel = proofItems.length
            ? `<ul class="c4-rows">${proofItems.map(proofRow).join('')}</ul><p class="c4-hint">Proof, not promises: the tests the change reached, the pages it touched, the diff, and a second model's opinion.</p>`
            : `<p class="c4-muted">${live ? 'The proof is collected when the task ends: its tests, its pages, its diff and a second opinion.' : 'This task has no proof: it ended before proof was collected.'}</p>`;
        const prPanel = await pullRequestPanel(row);
        const content = `<section class="c4-card c4-task-detail" data-task-api="${esc(taskApi)}" data-retry-url="${esc(retry)}" data-switch-url="${esc(switchAgent)}">${outcomeRow(row)}<div class="c4-task-heading"><div class="c4-task-title-wrap"><h1 class="c4-brief" data-brief>${esc(row.prompt || 'Task')}</h1><button class="c4-brief-expand" type="button" hidden>Show the whole brief</button></div>${row.outcome === 'unfinished' || row.error ? '' : stateChip(row.state)}</div>${taskChips(row, machineName)}${progress}<nav class="c4-tabs" aria-label="Task details">${[['live', 'Live'], ['changes', 'Changes'], ['proof', 'Proof'], ['pull-request', 'Pull request']].map(([id, label]) => `<a href="#${id}" role="tab" aria-selected="${id === preferredTab}" data-c4-tab="${id}">${label}</a>`).join('')}</nav><section id="live" class="c4-panel" role="tabpanel"><div id="live-content" class="c4-progress-content" data-c4-stream="${esc(events)}" data-task="${esc(row.id)}" data-started-at="${esc(row.started_at || row.created_at || '')}" data-live="${live ? 'true' : 'false'}"><div class="c4-progress-inner"><p data-live-label>${live ? 'Connecting to the live task…' : 'This task has finished.'}</p><ol class="c4-attempts" data-c4-attempts aria-live="polite">${attemptItems}</ol><pre class="c4-log" data-task-log aria-live="polite" hidden></pre></div></div></section><section id="changes" class="c4-panel" role="tabpanel">${changesPanel(row)}</section><section id="proof" class="c4-panel" role="tabpanel">${proofPanel}</section><section id="pull-request" class="c4-panel" role="tabpanel">${prPanel}</section>${live ? `<div class="c4-actions"><form method="post" action="/run/tasks/${encodeURIComponent(row.id)}/cancel"><button class="c4-button c4-button-light">Stop task</button></form></div>` : ''}</section>`;
        page(req, res, 'Task', wrap('/tasks', content, true));
    });

    // ── Agents: the person's connections (keys live in OpenVibe.AI) ────────────────────────────────────────────
    const connectionsCard = async (req) => {
        let list = { keys: [], plans: [] };
        let problem = null;
        try { list = await connections.list(req.viewer.subject); } catch (e) {
            problem = { status: e && e.status, detail: (e && e.message) || 'the connections could not be read' };
        }
        const now = Date.now();
        const rows = (list.keys || []).map((k) => `<li class="c4-row c4-row-flat"><span class="c4-row-dot c4-dot-ok" aria-hidden="true"></span><span class="c4-row-label">${esc(PROVIDER_NAMES[k.provider] || k.provider)}</span><span class="c4-row-note">${esc(k.hint || 'key stored')}${k.budget_usd_per_day != null ? ` · cap $${Number(k.budget_usd_per_day).toFixed(2)} a day` : ''}${k.last_used_at ? ` · last used ${esc(age(k.last_used_at))}` : ''}</span><span class="c4-inline-actions"><form method="post" action="/agents/connections/${esc(k.provider)}/test"><button class="c4-opill" type="submit">Test</button></form><form method="post" action="/agents/connections/${esc(k.provider)}/remove"><button class="c4-opill c4-opill-quiet" type="submit">Remove</button></form></span></li>`).join('');
        const plans = (list.plans || []).map((p) => `<li class="c4-row c4-row-flat"><span class="c4-row-dot c4-dot-skip" aria-hidden="true"></span><span class="c4-row-label">${esc(p.label || p.provider || 'a plan')}</span><span class="c4-row-note">on ${esc(p.machine || 'your machine')}</span>${pill('On your machine', 'skip')}</li>`).join('');
        return `<section class="c4-card" id="connections"><div class="c4-card-head"><h2>Connections</h2><span class="c4-muted">Keys live in OpenVibe.AI, never here</span></div>
${problem ? note(`Your connections could not be read: ${esc(problem.detail)}`, 'bad') : ''}
${rows || plans ? `<ul class="c4-rows">${rows}${plans}</ul>` : `<div class="c4-emptyline">No provider keys yet. Add one below and the router can use it, and so can a task.</div>`}
<h3 class="c4-subhead">Add or replace a key</h3>
<form class="c4-form" method="post" action="/agents/connections">
  <label>Provider <select name="provider">${connections.PROVIDERS.map((p) => `<option value="${esc(p)}">${esc(PROVIDER_NAMES[p] || p)}</option>`).join('')}</select></label>
  <label>Key <input type="password" name="key" required minlength="8" maxlength="400" autocomplete="off" spellcheck="false" placeholder="sk-…"></label>
  <label>Base URL <input type="url" name="base_url" placeholder="Only for a custom provider" autocomplete="off"></label>
  <label>Daily cap <input type="number" name="budget_usd_per_day" min="0" step="0.01" placeholder="Optional, in dollars"></label>
  <button class="c4-button" type="submit">Save the key</button>
</form>
<p class="c4-hint">The key is forwarded to OpenVibe.AI and sealed there; Codes keeps only the four-character hint. Test sends one tiny request with your key.</p>
</section>`;
    };

    r.get('/agents', async (req, res) => {
        const content = `${header('Agents', 'The agents your tasks can run, and the keys behind them.')}${viewer(req) ? `${flash(req)}${await connectionsCard(req)}` : signIn(req)}`;
        page(req, res, 'Agents', wrap('/agents', content, !!viewer(req)));
    });
    r.post('/agents/connections', form, async (req, res) => {
        if (!viewer(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent('/agents')}`);
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        const b = req.body || {};
        try {
            const out = await connections.put(req.viewer.subject, b.provider, {
                key: b.key, ...(b.base_url ? { base_url: b.base_url } : {}),
                ...(b.budget_usd_per_day ? { budget_usd_per_day: b.budget_usd_per_day } : {}),
            });
            return res.redirect(303, `/agents?ok=${encodeURIComponent(`Saved the ${PROVIDER_NAMES[out.provider] || out.provider} key`)}`);
        } catch (e) {
            return res.redirect(303, `/agents?error=${encodeURIComponent(String((e && e.message) || 'the key was refused').slice(0, 180))}`);
        }
    });
    r.post('/agents/connections/:provider/test', form, async (req, res) => {
        if (!viewer(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent('/agents')}`);
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        try {
            const out = await connections.test(req.viewer.subject, req.params.provider);
            const word = out.ok ? `The ${PROVIDER_NAMES[req.params.provider] || req.params.provider} key works` : `The key did not work: ${out.detail}`;
            return res.redirect(303, `/agents?${out.ok ? 'ok' : 'error'}=${encodeURIComponent(String(word).slice(0, 180))}`);
        } catch (e) {
            return res.redirect(303, `/agents?error=${encodeURIComponent(String((e && e.message) || 'the key could not be tested').slice(0, 180))}`);
        }
    });
    r.post('/agents/connections/:provider/remove', form, async (req, res) => {
        if (!viewer(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent('/agents')}`);
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        try {
            const gone = await connections.remove(req.viewer.subject, req.params.provider);
            return res.redirect(303, `/agents?${gone ? 'ok' : 'error'}=${encodeURIComponent(gone ? `Forgot the ${PROVIDER_NAMES[req.params.provider] || req.params.provider} key` : 'There was no key for that provider')}`);
        } catch (e) {
            return res.redirect(303, `/agents?error=${encodeURIComponent(String((e && e.message) || 'the key could not be forgotten').slice(0, 180))}`);
        }
    });

    // ── Machines: Node's pairing flow with a one-time code, and each machine's state ───────────────────────────
    const CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
    const normaliseCode = (s) => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/[ILO]/g, (c) => ({ I: '1', L: '1', O: '0' }[c]));
    r.get('/machines', async (req, res) => {
        const mine = viewer(req) ? await machinesOf(req, res) : { ok: false, machines: [] };
        const raw = normaliseCode(req.query.code);
        const badCode = raw.length > 0 && !CODE_SHAPE.test(raw);
        const code = CODE_SHAPE.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4)}` : '';
        const list = (mine.machines || []).map((m) => {
            const kind = m.state === 'online' ? 'ok' : m.state === 'revoked' ? 'bad' : 'skip';
            return `<li class="c4-row c4-row-flat"><span class="c4-row-dot c4-dot-${kind}" aria-hidden="true"></span><span class="c4-row-label">${esc(m.name || m.node_id || m.id)}</span><span class="c4-row-note">${esc(machines.STATE_WORD[m.state] || m.state)}${m.last_seen_at ? ` · seen ${esc(age(m.last_seen_at))}` : ' · never seen'}${m.paired_for && m.paired_for.service ? ` · paired for ${esc(m.paired_for.service)}` : ''}</span>${m.state === 'revoked' ? pill('Revoked', 'bad') : `<form method="post" action="/machines/${esc(m.id)}/revoke"><button class="c4-opill c4-opill-quiet" type="submit">Revoke</button></form>`}</li>`;
        }).join('');
        const pairCard = `<section class="c4-card" id="pair"><div class="c4-card-head"><h2>Pair a machine</h2><span class="c4-muted">One command, one code</span></div>
<ol class="c4-steps">
<li><b>Get a one-time code</b> on <a href="https://openvibe.bot/machines">openvibe.bot/machines</a>. It lasts ten minutes and works once.</li>
<li><b>Run the installer on the machine</b>, with the code it gives you: <code class="c4-code-inline">curl -fsSL https://openvibe.bot/install | sh -s -- --worker</code></li>
<li><b>It pairs itself</b>, then appears here as Online. A machine runs your jobs and nobody else's.</li>
</ol>
<form class="c4-form c4-form-inline" method="get" action="/machines">
  <label>Have a code? <input name="code" value="${esc(String(req.query.code || ''))}" placeholder="ABCD-1234" inputmode="text" autocomplete="off" spellcheck="false" maxlength="12"></label>
  <button class="c4-button" type="submit">Show the command</button>
</form>
${badCode ? note('a pairing code is 8 letters and digits, like ABCD-1234', 'bad') : ''}
${code ? `<div class="c4-pair-command"><p class="c4-kv"><span>On the machine</span><code class="c4-code-inline">sudo openvibe-node pair ${esc(code)} --network https://openvibe.network</code></p><p class="c4-kv"><span>Or with the installer</span><code class="c4-code-inline">curl -fsSL https://openvibe.bot/install | sh -s -- --network https://openvibe.network --pairing <span class="c4-note-inline">pair_… from openvibe.bot</span> --code ${esc(code)} --worker</code></p><p class="c4-hint">The code is the one openvibe.bot gave you for this machine; Codes never mints it. Reload this page once the installer says it is paired.</p></div>` : ''}
</section>`;
        const content = `${header('Machines', 'Your own computers, paired with your account.')}${viewer(req) ? `${flash(req)}<section class="c4-card"><div class="c4-card-head"><h2>Your machines</h2><span class="c4-muted">${(mine.machines || []).length} paired</span></div>${mine.ok ? (list ? `<ul class="c4-rows">${list}</ul>` : '<div class="c4-emptyline">No paired computers yet. Pair one below and it shows up here.</div>') : note(`Your machines could not be read. ${esc((mine.problem && mine.problem.detail) || 'Sign in again.')}`, 'bad')}</section>${pairCard}` : signIn(req)}`;
        page(req, res, 'Machines', wrap('/machines', content, !!viewer(req)));
    });
    r.post('/machines/:id/revoke', form, async (req, res) => {
        if (!viewer(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent('/machines')}`);
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        try {
            const out = await sso.asViewer(req, res, (token) => machines.revoke(token, req.params.id));
            return res.redirect(303, `/machines?${out.ok ? 'ok' : 'error'}=${encodeURIComponent(out.ok ? 'The machine is revoked: it can no longer run your work' : (out.problem && out.problem.detail) || 'the machine could not be revoked')}`);
        } catch (e) {
            return res.redirect(303, `/machines?error=${encodeURIComponent(String((e && e.message) || 'the machine could not be revoked').slice(0, 180))}`);
        }
    });

    // ── Usage: what Codes knows, and no prices it does not know ────────────────────────────────────────────────
    r.get('/usage', async (req, res) => {
        let report = { days: [], totals: { runs: 0, attempts: 0, minutes: 0, tokens: 0 }, window: 14 };
        if (viewer(req)) report = await usage.daily(req.viewer.subject, { days: 14 });
        const rows = report.days.map((d) => `<tr><td>${esc(d.day)}</td><td>${d.runs}</td><td>${d.attempts}</td><td>${d.minutes} min</td><td>${d.tokens.toLocaleString('en-US')}</td></tr>`).join('');
        const content = `${header('Usage', `The last ${report.window} days of your tasks.`)}${viewer(req) ? `<section class="c4-card"><div class="c4-card-head"><h2>Runs, minutes and tokens</h2><span class="c4-muted">Totals below</span></div>
${report.days.length ? `<div class="table-wrap" tabindex="0" role="region" aria-label="Usage by day"><table class="c4-table"><thead><tr><th scope="col">Day</th><th scope="col">Runs</th><th scope="col">Attempts</th><th scope="col">Minutes</th><th scope="col">Tokens</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><th scope="row">Total</th><td>${report.totals.runs}</td><td>${report.totals.attempts}</td><td>${report.totals.minutes} min</td><td>${report.totals.tokens.toLocaleString('en-US')}</td></tr></tfoot></table></div>` : '<div class="c4-emptyline">No usage yet. <a href="/#c4-prompt">Start a task</a> and its runs, minutes and tokens appear here.</div>'}
<p class="c4-hint">Runs are tasks, attempts are the tries inside them, minutes are the time an attempt was running, and tokens are what its session reported.</p>
</section>
<section class="c4-card"><div class="c4-card-head"><h2>Money</h2></div><p class="c4-muted">No prices are shown here. Money for model use belongs to OpenVibe.Billing, whose per-person usage read is not one Codes may make, so Codes shows what it knows — runs, minutes and tokens — and adds no ledger of its own.</p></section>` : signIn(req)}`;
        page(req, res, 'Usage', wrap('/usage', content, !!viewer(req)));
    });

    // ── Settings: remembered per person ────────────────────────────────────────────────────────────────────────
    const SAFETY_OPTIONS = [
        ['ask', 'Ask me', 'Approve commands as they come up.'],
        ['project', 'Auto in the project', 'Run commands within the project automatically.'],
        ['full', 'Full access', 'Let the agent use the whole computer.'],
    ];
    r.get('/settings', async (req, res) => {
        const settings = viewer(req) ? await userSettings.get(req.viewer.subject) : null;
        const mine = viewer(req) ? await machinesOf(req, res) : { machines: [] };
        const used = viewer(req) ? await lastUsedMachines(req) : [];
        const agentOptions = (harnesses?.list?.() || []).map((a) => `<option value="${esc(a.id)}"${settings && settings.default_agent === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
        // The same order the Home picker shows: the machines their work ran on last come first.
        const machineOptions = orderMachines((mine.machines || []).filter((m) => m.state !== 'revoked'), used).map((m) => machineOption(m, settings)).join('');
        const content = `${header('Settings', 'Your choices, remembered for your account.')}${viewer(req) ? `${flash(req)}<section class="c4-card"><form class="c4-form" method="post" action="/settings">
<div class="c4-form-grid">
<label>Default agent <select name="default_agent"><option value="">Auto</option>${agentOptions}</select></label>
<label>Default machine <select name="default_machine"><option value="">Auto</option>${machineOptions}</select></label>
</div>
<h3 class="c4-subhead">Notifications</h3>
<div class="c4-checks">
  <label class="c4-check"><input type="checkbox" name="notify_done" value="1"${settings.notify_done ? ' checked' : ''}><span><b>A task finishes</b><small>Tell me when it ends, with its outcome.</small></span></label>
  <label class="c4-check"><input type="checkbox" name="notify_needs" value="1"${settings.notify_needs ? ' checked' : ''}><span><b>A task needs me</b><small>Approvals, questions and a task that stopped.</small></span></label>
</div>
<h3 class="c4-subhead">Safety</h3>
<div class="c4-safety" role="group" aria-label="Safety level">${SAFETY_OPTIONS.map(([value, title, desc]) => `<label class="c4-safety-card"><input type="radio" name="safety" value="${value}"${settings.safety === value ? ' checked' : ''}><span><b>${title}</b><small>${desc}</small></span></label>`).join('')}</div>
<button class="c4-button" type="submit">Save settings</button>
</form></section>` : signIn(req)}`;
        page(req, res, 'Settings', wrap('/settings', content, !!viewer(req)));
    });
    r.post('/settings', form, async (req, res) => {
        if (!viewer(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent('/settings')}`);
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        const b = req.body || {};
        try {
            await userSettings.save(req.viewer.subject, {
                default_agent: b.default_agent === undefined ? undefined : b.default_agent,
                default_machine: b.default_machine === undefined ? undefined : b.default_machine,
                notify_done: b.notify_done === '1',
                notify_needs: b.notify_needs === '1',
                ...(b.safety ? { safety: b.safety } : {}),
            });
            return res.redirect(303, '/settings?ok=Settings%20saved');
        } catch (e) {
            return res.redirect(303, `/settings?error=${encodeURIComponent(String((e && e.message) || 'the settings could not be saved').slice(0, 180))}`);
        }
    });

    return r;
}

module.exports = { createC4Routes };
