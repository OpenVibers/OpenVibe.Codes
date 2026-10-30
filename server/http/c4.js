'use strict';

// Phone-first Codes workspace. Pages stay useful without JavaScript and link to existing task actions.
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
const stateLabel = (s) => ({ running: 'Running', queued: 'Queued', done: 'Done', succeeded: 'Done', failed: "Didn't finish", cancelled: 'Stopped by you' }[s] || s || 'Unknown');
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

function createC4Routes(ctx) {
    const r = asyncRouter();
    const { config, store, harnesses } = ctx;
    const db = store.db;
    const page = (req, res, title, body, extra = {}) => send(res, 200, { viewer: req.viewer, config, path: req.originalUrl, ...(title ? { title: `${title} · Codes` } : {}), css: ['css/c4.css'], scripts: /^\/tasks\/tsk_/.test(req.path) ? ['js/c4.js'] : [], body: raw(body), ...extra });
    const viewer = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const wrap = (current, content, signedIn = false) => `<div class="c4"><div class="c4-layout"><aside class="c4-side"><nav aria-label="Workspace">${LINKS.map(([label, href]) => `<a href="${href}"${current === href ? ' aria-current="page"' : ''}>${icon(LINKS.find((x) => x[0] === label)[2])}<span>${label}</span></a>`).join('')}</nav></aside><main class="c4-main">${content}</main></div><nav class="c4-mobile" aria-label="Workspace">${LINKS.slice(0,5).map(([label, href, svg]) => `<a href="${href}"${current === href ? ' aria-current="page"' : ''}>${icon(svg)}<span>${label}</span></a>`).join('')}</nav></div>`;
    const signIn = (req) => `<section class="c4-card c4-empty"><h2>Sign in to see your work</h2><p>Your tasks, machines and usage belong to your OpenVibe account.</p><a class="c4-button" href="/auth/login?next=${encodeURIComponent(req.originalUrl || '/')}">Sign in</a></section>`;
    async function ownTasks(req, limit = 100) {
        if (!viewer(req)) return [];
        return db.many('SELECT * FROM run_tasks WHERE subject = $1 ORDER BY created_at DESC LIMIT $2', [req.viewer.subject, limit]);
    }
    const taskHref = (row) => `/tasks/${encodeURIComponent(row.id)}`;
    const rowHtml = (row) => {
        const repo = repoDetails(row.repo);
        const attempts = Number(row.attempt_count || row.result?.attempts?.length || row.result?.attempts || 0);
        const meta = [repo?.label || 'Project not set', row.agent || 'Auto', age(row.created_at), money(row.result && row.result.cost), attempts > 1 ? `${attempts} attempts` : ''].filter(Boolean).map(esc).join(' · ');
        return `<a class="c4-task" href="${taskHref(row)}"><span class="c4-status-dot c4-${esc(row.state)}" aria-label="${esc(stateLabel(row.state))}"></span><span class="c4-task-title">${esc(row.prompt || repo?.label || 'Coding task')}</span><span class="c4-task-meta">${meta}</span></a>`;
    };
    const header = (title, desc = '') => `<div class="c4-title"><div><h1>${esc(title)}</h1>${desc ? `<p>${esc(desc)}</p>` : ''}</div></div>`;
    const stateChip = (state) => `<span class="c4-status c4-${esc(state)}">${esc(stateLabel(state))}</span>`;
    const taskChips = (row) => {
        const repo = repoDetails(row.repo);
        const chips = [repo ? `<a class="c4-chip" href="${esc(repo.href)}" rel="noopener noreferrer">${esc(repo.label)}</a>` : `<span class="c4-chip">Project not set</span>`, `<span class="c4-chip">${esc(row.ref || 'default branch')}</span>`, `<span class="c4-chip">${esc(row.agent || 'Auto')}</span>`, '<span class="c4-chip">Your computer</span>', `<span class="c4-chip">${esc(money(row.result && row.result.cost))}</span>`];
        return `<div class="c4-chips" aria-label="Task details">${chips.join('')}</div>`;
    };

    r.get('/', async (req, res) => {
        const rows = await ownTasks(req, 8);
        const signedIn = !!viewer(req);
        const content = `${header(signedIn ? 'Home' : 'Every coding agent. One place.', signedIn ? '' : 'Your keys, your machines. Tell an agent what to do and follow the work from your phone.')}
<section class="c4-card c4-composer"><form method="get" action="/run"><label for="c4-prompt">What should an agent do?</label><textarea id="c4-prompt" name="prompt" placeholder="Describe the change, question or fix" required></textarea><div class="c4-controls"><label>Project<input type="url" name="repo" placeholder="Paste a repository URL" autocomplete="url"></label><label>Agent <select name="agent"><option value="">Auto</option>${(harnesses?.list?.() || []).map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select></label><label>Machine <select name="machine"><option value="">Auto</option></select></label><label>Cost cap <select name="cap"><option>$1.00</option><option>$5.00</option></select></label><button class="c4-button" type="submit">Start a task</button></div></form></section>
<div class="c4-grid"><section class="c4-card"><div class="c4-card-head"><h2>Running</h2><a href="/tasks?state=running">All tasks</a></div>${rows.filter((x) => !['done','succeeded','failed','cancelled'].includes(x.state)).slice(0,4).map(rowHtml).join('') || '<div class="c4-emptyline">No tasks running yet. <a href="/#c4-prompt">Start a task</a></div>'}</section><section class="c4-card"><div class="c4-card-head"><h2>Needs you</h2><span class="c4-muted">Approvals and questions</span></div><div class="c4-emptyline">Nothing needs your attention. <a href="/tasks">View tasks</a></div></section></div>
<section class="c4-card"><div class="c4-card-head"><h2>Recent tasks</h2><a href="/tasks">View all</a></div>${rows.slice(0,5).map(rowHtml).join('') || '<div class="c4-emptyline">No tasks yet. <a href="/#c4-prompt">Start a task</a></div>'}</section>
${signedIn ? '' : `<section class="c4-reasons"><h2>Built for the way you work</h2><div class="c4-grid">${[['Any agent','Bring a key or plan. Auto picks a good fit and can hand over when one gets stuck.'],['Your computer or ours','Pair your computer with one command. A hosted sandbox is coming soon.'],['Proof you can inspect','See the changes, tests, screenshots and review before you approve.'],['A cost you can follow','Track task costs and plan limits. Set caps that stop with a wrap-up.']].map(([a,b]) => `<article><h3>${a}</h3><p>${b}</p></article>`).join('')}</div></section>`}`;
        page(req, res, null, wrap('/', content, signedIn), signedIn ? {} : { index: true, styles: [showcase.STYLESHEET], jsonLd: homeJsonLd(config) });
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
        const live = !['done','succeeded','failed','cancelled'].includes(row.state);
        const events = `/run/tasks/${encodeURIComponent(row.id)}/events`;
        const prompt = encodeURIComponent(row.prompt || '');
        const retry = `/run?prompt=${prompt}&repo=${encodeURIComponent(row.repo || '')}&agent=${encodeURIComponent(row.agent || '')}`;
        const switchAgent = `/run?prompt=${prompt}&repo=${encodeURIComponent(row.repo || '')}`;
        const resume = `${retry}`;
        const outcome = row.error ? `<div class="c4-outcome"><span>${stateChip(row.state)}</span><p>${esc(row.error)}</p><div class="c4-actions"><a class="c4-button" href="${retry}">Try again</a><a class="c4-button c4-button-light" href="${switchAgent}">Switch agent</a><a class="c4-button c4-button-light" href="/tasks">It's fine</a></div></div>` : '';
        const progress = live ? `<button class="c4-progress-toggle" type="button" aria-expanded="false" aria-controls="live-content"><span data-progress-title>Working on your task</span><span class="c4-progress-meta"><span data-progress-steps>0 steps</span> · <span data-progress-time>now</span></span><span aria-hidden="true">⌄</span></button>` : '';
        const content = `<section class="c4-card c4-task-detail">${outcome}<div class="c4-task-heading"><div class="c4-task-title-wrap"><h1 class="c4-brief" data-brief>${esc(row.prompt || 'Task')}</h1><button class="c4-brief-expand" type="button" hidden>Show the whole brief</button></div>${row.error ? '' : stateChip(row.state)}</div>${taskChips(row)}${progress}<nav class="c4-tabs" aria-label="Task details">${[['live','Live'],['changes','Changes'],['proof','Proof'],['pull-request','Pull request']].map(([id, label], i) => `<a href="#${id}" role="tab" aria-selected="${i === 0}" data-c4-tab="${id}">${label}</a>`).join('')}</nav><section id="live" class="c4-panel" role="tabpanel"><div id="live-content" class="c4-progress-content" data-c4-stream="${esc(events)}" data-task="${esc(row.id)}" data-started-at="${esc(row.started_at || row.created_at || '')}" data-live="${live ? 'true' : 'false'}"><div class="c4-progress-inner"><p>${live ? 'Connecting to the live task…' : 'This task has finished.'}</p><pre class="c4-log" aria-live="polite"></pre></div></div></section><section id="changes" class="c4-panel" role="tabpanel"><p>Changes from this task.</p><a href="/run/tasks/${encodeURIComponent(row.id)}">Open changes</a></section><section id="proof" class="c4-panel" role="tabpanel"><p>Test output and screenshots for this task.</p><a href="/run/tasks/${encodeURIComponent(row.id)}">Open task proof</a></section><section id="pull-request" class="c4-panel" role="tabpanel"><p>Pull request details will appear here.</p><a href="/run/tasks/${encodeURIComponent(row.id)}">Open task in Run</a></section><div class="c4-actions"><form method="post" action="/run/tasks/${encodeURIComponent(row.id)}/cancel"><button class="c4-button c4-button-light" ${live ? '' : 'disabled'}>Stop task</button></form><a class="c4-button" href="${resume}">Continue or switch agent in Run</a></div></section>`;
        page(req, res, 'Task', wrap('/tasks', content, true));
    });
    r.get('/agents', (req, res) => page(req, res, 'Agents', wrap('/agents', `${header('Agents')}${viewer(req) ? '<section id="connections" class="c4-card"><h2>Connections</h2><div class="c4-emptyline">No agent connections yet. <a class="c4-button" href="/agents#connections">Connect a key</a></div></section>' : signIn(req)}`, !!viewer(req))));
    r.get('/machines', (req, res) => page(req, res, 'Machines', wrap('/machines', `${header('Machines')}${viewer(req) ? '<section class="c4-card"><h2>Your machines</h2><div class="c4-emptyline">No paired computers yet. <a class="c4-button" href="/machines#pair">Pair this computer</a></div><div id="pair"><pre class="c4-code">curl -fsSL https://openvibe.bot/install.sh | sh -s -- --worker</pre></div></section>' : signIn(req)}`, !!viewer(req))));
    r.get('/usage', async (req, res) => {
        const rows = await ownTasks(req);
        page(req, res, 'Usage', wrap('/usage', `${header('Usage')}${viewer(req) ? `<section class="c4-card"><div class="c4-card-head"><h2>Recent task costs</h2><span>Last ${rows.length} tasks</span></div>${rows.map((x) => `<a class="c4-task c4-usage-row" href="${taskHref(x)}"><span class="c4-task-title">${esc(x.prompt || repoDetails(x.repo)?.label || 'Task')}</span><span class="c4-task-meta">${esc(x.agent || 'Auto')} · ${esc(stateLabel(x.state))}</span><b>${esc(money(x.result && x.result.cost))}</b></a>`).join('') || '<div class="c4-emptyline">No task usage yet. <a href="/#c4-prompt">Start a task</a></div>'}</section>` : signIn(req)}`, !!viewer(req)));
    });
    r.get('/settings', (req, res) => page(req, res, 'Settings', wrap('/settings', `${header('Settings')}${viewer(req) ? '<section class="c4-card"><h2>Safety</h2><div class="c4-safety" role="group" aria-label="Safety level"><label class="c4-safety-card"><input type="radio" name="safety" checked><span><b>Ask me</b><small>Approve commands as they come up.</small></span></label><label class="c4-safety-card"><input type="radio" name="safety"><span><b>Auto in the project</b><small>Run commands within the project automatically.</small></span></label><label class="c4-safety-card"><input type="radio" name="safety"><span><b>Full access</b><small>Let the agent use the whole computer.</small></span></label></div><p class="c4-muted">Arrives with connections.</p></section>' : signIn(req)}`, !!viewer(req))));
    return r;
}

module.exports = { createC4Routes };
