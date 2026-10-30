'use strict';

// Phone-first Codes workspace. It reads the task rows already owned by the signed-in person; pages remain useful
// without JavaScript and link into the existing /run forms/actions where that API is available.
const express = require('express');
const { send } = require('../render/layout');
const { html, raw, esc } = require('../render/html');
const { asyncRouter } = require('./router');
const showcase = require('openvibe-shared/showcase');
const { homeJsonLd } = require('./discovery');

const LINKS = [['Home','/'],['Tasks','/tasks'],['Agents','/agents'],['Machines','/machines'],['Usage','/usage'],['Settings','/settings']];
const stateLabel = (s) => ({ running: 'Running', queued: 'Queued', done: 'Done', succeeded: 'Done', failed: "Didn't finish", cancelled: 'Stopped by you' }[s] || s || 'Unknown');
const safeId = (s) => /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(s || ''));
const money = (n) => Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : '—';

function createC4Routes(ctx) {
    const r = asyncRouter();
    const { config, store, harnesses } = ctx;
    const db = store.db;
    const page = (req, res, title, body, extra = {}) => send(res, 200, { viewer: req.viewer, config, path: req.originalUrl, ...(title ? { title: `${title} · Codes` } : {}), css: ['css/c4.css'], scripts: ['js/c4.js'], body: raw(body), ...extra });
    const viewer = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const wrap = (current, content, signedIn = false) => `<div class="c4"><header class="c4-head"><a class="c4-brand" href="/">OpenVibe<span>.Codes</span></a><span class="c4-head-note">Your coding workspace</span>${signedIn ? '' : '<a class="c4-signin" href="/auth/login">Sign in</a>'}</header><div class="c4-layout"><aside class="c4-side"><nav aria-label="Workspace">${LINKS.map(([label, href]) => `<a href="${href}"${current === href ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav></aside><main class="c4-main">${content}</main></div><nav class="c4-mobile" aria-label="Workspace">${LINKS.slice(0,5).map(([label, href]) => `<a href="${href}"${current === href ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav></div>`;
    const signIn = (req) => `<section class="c4-card c4-empty"><h2>Sign in to see your work</h2><p>Your tasks, machines and usage belong to your OpenVibe account.</p><a class="c4-button" href="/auth/login?next=${encodeURIComponent(req.originalUrl || '/')}">Sign in</a></section>`;
    async function ownTasks(req, limit = 100) {
        if (!viewer(req)) return [];
        return db.many('SELECT * FROM run_tasks WHERE subject = $1 ORDER BY created_at DESC LIMIT $2', [req.viewer.subject, limit]);
    }
    const taskHref = (row) => `/tasks/${encodeURIComponent(row.id)}`;
    const rowHtml = (row) => `<a class="c4-task" href="${taskHref(row)}"><span class="c4-status c4-${esc(row.state)}">${esc(stateLabel(row.state))}</span><span class="c4-task-title">${esc(row.prompt || row.repo || 'Coding task')}</span><span class="c4-task-meta">${esc(row.repo || 'Project not set')} · ${esc(row.agent || 'Auto')} · ${esc(row.ref || 'default branch')}</span><span class="c4-task-arrow" aria-hidden="true">→</span></a>`;
    const header = (title, desc = '') => `<div class="c4-title"><div><p class="c4-kicker">OPENVIBE.CODES</p><h1>${esc(title)}</h1>${desc ? `<p>${esc(desc)}</p>` : ''}</div></div>`;

    r.get('/', async (req, res) => {
        const rows = await ownTasks(req, 8);
        const content = `${header('Every coding agent. One place.', 'Your keys, your machines. Tell an agent what to do and follow the work from your phone.')}
<section class="c4-card c4-composer"><form method="get" action="/run"><label for="c4-prompt">What should an agent do?</label><textarea id="c4-prompt" name="prompt" placeholder="Describe the change, question or fix" required></textarea><div class="c4-controls"><label>Project <select name="project"><option>Choose in Run</option></select></label><label>Agent <select name="agent"><option value="">Auto</option>${(harnesses?.list?.() || []).map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select></label><label>Machine <select name="machine"><option>Auto</option></select></label><label>Cost cap <select name="cap"><option>$1.00</option><option>$5.00</option></select></label><button class="c4-button" type="submit">Start a task</button></div><p class="c4-muted">Projects and task launch are handled by Run on your machine. <a href="/run">Open Run</a></p></form></section>
<div class="c4-grid"><section class="c4-card"><div class="c4-card-head"><h2>Needs you</h2><span class="c4-muted">Approvals and questions</span></div><div class="c4-emptyline">Nothing needs your attention</div></section><section class="c4-card"><div class="c4-card-head"><h2>Running</h2><a href="/tasks?state=running">All tasks</a></div>${rows.filter((x) => !['done','succeeded','failed','cancelled'].includes(x.state)).slice(0,4).map(rowHtml).join('') || '<div class="c4-emptyline">No tasks running yet</div>'}</section></div>
<section class="c4-card"><div class="c4-card-head"><h2>Recent tasks</h2><a href="/tasks">View all</a></div>${rows.slice(0,5).map(rowHtml).join('') || '<div class="c4-emptyline">Your completed tasks will appear here.</div>'}</section>
<section class="c4-reasons"><h2>Built for the way you work</h2><div class="c4-grid">${[['Any agent','Bring a key or plan. Auto picks a good fit and can hand over when one gets stuck.'],['Your computer or ours','Pair your computer with one command. A hosted sandbox is coming soon.'],['Proof you can inspect','See the changes, tests, screenshots and review before you approve.'],['A cost you can follow','Track task costs and plan limits. Set caps that stop with a wrap-up.']].map(([a,b]) => `<article><h3>${a}</h3><p>${b}</p></article>`).join('')}</div></section>`;
        page(req, res, null, wrap('/', content, !!viewer(req)), { index: true, styles: [showcase.STYLESHEET], jsonLd: homeJsonLd(config) });
    });
    r.get('/tasks', async (req, res) => {
        const rows = await ownTasks(req);
        const q = String(req.query.q || '').toLowerCase();
        const filtered = rows.filter((x) => `${x.prompt} ${x.repo} ${x.agent}`.toLowerCase().includes(q));
        const isDone = (x) => ['done', 'succeeded', 'cancelled'].includes(x.state);
        const groups = [
            ['Running', filtered.filter((x) => !isDone(x) && x.state !== 'failed')],
            ['Needs you', []],
            ['Done', filtered.filter((x) => isDone(x))],
            ["Didn't finish", filtered.filter((x) => x.state === 'failed')],
        ];
        const content = `${header('Tasks', 'Each task keeps its attempts and outcome together.')}${viewer(req) ? `<form class="c4-search" method="get"><label for="task-search">Search your tasks</label><input id="task-search" name="q" value="${esc(q)}" placeholder="Search by task, project or agent"><button class="c4-button c4-button-light">Search</button></form>${groups.map(([label, items]) => `<section class="c4-card"><div class="c4-card-head"><h2>${label}</h2></div>${items.map(rowHtml).join('') || `<div class="c4-emptyline">${label === 'Needs you' ? 'No approvals or questions waiting.' : `No ${label.toLowerCase()} tasks.`}</div>`}</section>`).join('')}` : signIn(req)}`;
        page(req, res, 'Tasks', wrap('/tasks', content, !!viewer(req)));
    });
    r.get('/tasks/:id', async (req, res) => {
        if (!viewer(req)) return page(req, res, 'Task', wrap('/tasks', `${header('Task', 'Sign in to see this task and its updates.')}${signIn(req)}`));
        if (!safeId(req.params.id)) return res.status(404).send('Not found');
        const row = await db.maybe('SELECT * FROM run_tasks WHERE id = $1 AND subject = $2', [req.params.id, req.viewer.subject]);
        if (!row) return res.status(404).send('Not found');
        const live = !['done','succeeded','failed','cancelled'].includes(row.state);
        const events = `/run/tasks/${encodeURIComponent(row.id)}/events`;
        const prompt = encodeURIComponent(row.prompt || '');
        const retry = `/run?prompt=${prompt}`;
        const resume = `${retry}&agent=${encodeURIComponent(row.agent || '')}`;
        const content = `${header(row.prompt || 'Task', `${row.repo || 'Project not set'} · ${row.ref || 'default branch'}`)}<section class="c4-card"><div class="c4-card-head"><span class="c4-status c4-${esc(row.state)}">${esc(stateLabel(row.state))}</span><span>${esc(row.agent || 'Auto')} · ${esc(money(row.result && row.result.cost))}</span></div><p class="c4-muted">Task ${esc(row.id)}</p>${row.error ? `<div class="c4-outcome"><b>Didn't finish</b><p>${esc(row.error)}</p><div class="c4-actions"><a class="c4-button" href="${retry}">Try again</a><a class="c4-button c4-button-light" href="${retry}">Switch agent</a><a class="c4-button c4-button-light" href="/tasks">It's fine</a></div></div>` : ''}<nav class="c4-tabs" aria-label="Task details"><a href="#live">Live</a><a href="#changes">Changes</a><a href="#proof">Proof</a><a href="#pull-request">Pull request</a></nav><details open id="live" class="c4-detail"><summary>Live · Timeline and updates</summary><div data-c4-stream="${esc(events)}" data-task="${esc(row.id)}"><p>${live ? 'Connecting to the live task…' : 'This task has finished.'}</p><pre class="c4-log" aria-live="polite"></pre></div></details><details id="changes" class="c4-detail"><summary>Changes</summary><p>Open the complete task result and diff in the current Run view.</p><a href="/run/tasks/${encodeURIComponent(row.id)}">Open changes</a></details><details id="proof" class="c4-detail"><summary>Proof</summary><p>Test output, screenshots and the second agent review appear here when available.</p><a href="/run/tasks/${encodeURIComponent(row.id)}">Open task proof</a></details><details id="pull-request" class="c4-detail"><summary>Pull request</summary><p>Pull request details are not available for this task yet.</p></details><div class="c4-actions"><form method="post" action="/run/tasks/${encodeURIComponent(row.id)}/cancel"><button class="c4-button c4-button-light" ${live ? '' : 'disabled'}>Stop task</button></form><a class="c4-button" href="${resume}">Continue or switch agent in Run</a></div></section>`;
        page(req, res, 'Task', wrap('/tasks', content, true));
    });
    r.get('/agents', (req, res) => page(req, res, 'Agents', wrap('/agents', `${header('Agents', 'Connect a key or plan and choose how Auto should hand work between agents.')}${viewer(req) ? '<section class="c4-card"><div class="c4-card-head"><h2>Connections</h2><span class="c4-muted">Stored in OpenVibe’s sealed vault</span></div><div class="c4-emptyline">No connection details are available yet. Connection management will appear when the vault integration is ready.</div></section>' : signIn(req)}<section class="c4-card"><h2>Auto preferences</h2><p>Choose an agent order for quick fixes, standard changes, hard tasks, design and research.</p><div class="c4-emptyline">No routing preferences configured.</div></section>`, !!viewer(req))));
    r.get('/machines', (req, res) => page(req, res, 'Machines', wrap('/machines', `${header('Machines', 'Choose where your tasks run.')}${viewer(req) ? '<section class="c4-card"><div class="c4-card-head"><h2>Your machines</h2><span class="c4-status">Node pairing</span></div><p>Pair a computer to run agents close to your code.</p><pre class="c4-code">curl -fsSL https://openvibe.bot/install.sh | sh -s -- --worker</pre><a href="https://openvibe.bot/machines">Manage machine pairing</a></section>' : signIn(req)}<section class="c4-card"><h2>OpenVibe sandbox</h2><div class="c4-emptyline">Hosted sandbox is not available yet.</div></section>`, !!viewer(req))));
    r.get('/usage', async (req, res) => {
        const rows = await ownTasks(req);
        page(req, res, 'Usage', wrap('/usage', `${header('Usage', 'See what each task used and where your budget goes.')}${viewer(req) ? `<section class="c4-card"><div class="c4-card-head"><h2>Recent task costs</h2><span>Last ${rows.length} tasks</span></div>${rows.map((x) => `<div class="c4-task"><span class="c4-task-title">${esc(x.prompt || x.repo)}</span><span class="c4-task-meta">${esc(x.agent || 'Auto')} · ${esc(stateLabel(x.state))}</span><b>${esc(money(x.result && x.result.cost))}</b></div>`).join('') || '<div class="c4-emptyline">Usage will appear after your first task.</div>'}<p class="c4-muted">Connection balances, daily spend and billing caps are not available until billing is connected.</p></section>` : signIn(req)}`, !!viewer(req)));
    });
    r.get('/settings', (req, res) => page(req, res, 'Settings', wrap('/settings', `${header('Settings', 'Set how much freedom an agent has and how long your work stays available.')}${viewer(req) ? '<section class="c4-card"><h2>Safety</h2><form class="c4-settings"><label><input type="radio" name="safety" checked disabled> Ask me before commands outside the project</label><label><input type="radio" name="safety" disabled> Auto in the project</label><label><input type="radio" name="safety" disabled> Full access</label><p class="c4-muted">Safety preferences will be saved here when task controls are available.</p></form></section><section class="c4-card"><h2>Defaults and data</h2><div class="c4-emptyline">Notifications, retention and export settings are not available yet.</div></section>' : signIn(req)}`, !!viewer(req))));
    return r;
}

module.exports = { createC4Routes };
