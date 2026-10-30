'use strict';
/**
 * Run on your machine (plan T16): a coding task started from any browser that runs on the person's own machine.
 *
 *   GET  /run                    the form, the person's projects and their recent tasks (a sign-in prompt for a guest)
 *   POST /run                    start one: a run_tasks row and an OpenVibe Run job for the person (server/domain/run-client.js)
 *   POST /run/project            create a project for the runs when the person has none they may run jobs in
 *   GET  /run/tasks/:id          one task: live while it runs, then the agents' summary, the changed files and the patch
 *   GET  /run/tasks/:id/events   its live lines, proxied from Run's job stream (server-sent events)
 *   POST /run/tasks/:id/cancel   stop it
 *
 * Every task is its owner's alone (another person's is 404). Forms post only from this site. The job runs where Run
 * places it: on a machine the person added on openvibe.bot/machines, never anyone else's (contracts 0.161.0).
 */
const express = require('express');
const { asyncRouter } = require('./router');
const { send } = require('../render/layout');
const { html, raw, esc } = require('../render/html');

const { parseArgs } = require('../../harness/job');
const { createRunTasks, TERMINAL, STATE_LABEL } = require('../domain/run-tasks');

const DELEGABLE = new Set(['owner', 'admin']);
const MACHINES_URL = 'https://openvibe.bot/machines';

/** A repository URL as a heading: the host small, then owner/name, which may break after a slash but never mid-word. */
function repoName(url) {
    const [host, ...path] = String(url).replace(/^https:\/\//, '').split('/');
    if (!path.length) return host;
    return html`<small class="run-host">${host}/</small>${path.map((part, i) => html`${i ? raw('/<wbr>') : ''}${part}`)}`;
}

function createRunRoutes({ config, store, sso, harnesses, run, fetchImpl = globalThis.fetch, log = console }) {
    const r = asyncRouter();
    const db = store.db;
    const form = express.urlencoded({ extended: false, limit: '32kb' });
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, scripts: ['js/run.js'], css: ['css/run.css'], ...o });
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const sameOrigin = (req) => {
        const origin = req.get('origin');
        if (!origin) return true;
        try { return new URL(origin).origin === new URL(config.baseUrl).origin; } catch { return false; }
    };

    /** The person's projects they may run jobs in (owner or admin, not archived), from Network with their own token. */
    async function projectsOf(req, res) {
        const list = await sso.asViewer(req, res, async (token) => {
            const out = await fetchImpl(`${config.networkInternalUrl}/api/v1/projects`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
            if (out.status === 401) { const e = new Error('expired'); e.status = 401; throw e; }
            if (!out.ok) throw new Error(`Network answered ${out.status} for the projects`);
            return (await out.json()).projects || [];
        });
        return list.filter((p) => DELEGABLE.has(p.role) && !p.archived_at).map((p) => ({ id: p.id, name: p.name }));
    }

    const own = async (req, id) => {
        if (!/^tsk_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id))) return null;
        const row = await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [id]);
        return row && row.subject === req.viewer.subject ? row : null;
    };
    // A task not yet ended asks Run where its job is; an ended job's result is kept on the row (domain/run-tasks).
    const tasks = createRunTasks({ store, run, config, log });
    const { who, refresh } = tasks;

    function formHtml({ projects, values = {}, error = null }) {
        const agents = harnesses.list();
        const opt = (v, label, sel) => html`<option value="${v}"${sel ? raw(' selected') : ''}>${label}</option>`;
        return html`<form class="run-card run-form" method="post" action="/run">
${error ? html`<p class="run-notice run-notice-error" role="alert">${error}</p>` : ''}
<label class="run-field"><span>Repository</span><input name="repo" type="url" required placeholder="https://github.com/you/project" value="${values.repo || ''}" autocomplete="off" spellcheck="false"></label>
<label class="run-field"><span>Branch <small>(optional: the default branch)</small></span><input name="ref" value="${values.ref || ''}" autocomplete="off" spellcheck="false" placeholder="main"></label>
<label class="run-field"><span>What should the agent do?</span><textarea name="prompt" rows="5" required maxlength="16000" placeholder="Add a test for the date parser and fix what it finds">${values.prompt || ''}</textarea></label>
<div class="run-field-row">
<label class="run-field"><span>Agent</span><select name="agent">${opt('', 'Any: the best fit, with hand-offs', !values.agent)}${agents.map((a) => opt(a.id, a.name, values.agent === a.id))}</select></label>
<label class="run-field"><span>It may</span><select name="permission">${opt('edit', 'Edit files', values.permission !== 'full')}${opt('full', 'Run anything (tests, installs)', values.permission === 'full')}</select></label>
<label class="run-field"><span>Project</span><select name="project">${projects.map((p) => opt(p.id, p.name, values.project === p.id))}</select></label>
</div>
<label class="run-check"><input type="checkbox" name="push" value="1"${values.push ? raw(' checked') : ''}> Push the change to a new branch <small>(GitHub; needs GITHUB_TOKEN on your machine; never the branch it started from)</small></label>
<label class="run-check"><input type="checkbox" name="pull_request" value="1"${values.pull_request ? raw(' checked') : ''}> and open a pull request</label>
<button class="run-btn run-btn-primary" type="submit">Start on my machine</button>
</form>`;
    }

    function tasksHtml(rows) {
        if (!rows.length) return html`<p class="muted">No tasks yet.</p>`;
        return html`<ul class="run-tasks">${rows.map((t) => html`<li><a href="/run/tasks/${t.id}"><span class="run-pill run-pill-${t.state}">${STATE_LABEL[t.state] || t.state}</span> <b>${repoName(t.repo)}</b> <span class="muted">${t.prompt.split('\n')[0].slice(0, 90)}</span></a></li>`)}</ul>`;
    }

    async function runPage(req, res, { values, error, status = 200 } = {}) {
        if (!signedIn(req)) {
            return page(req, res, {
                title: 'Run on your machine', index: true,
                body: html`<h1>Run a coding task on your own machine</h1>
<p class="lead">Start a task from any browser, your phone included, and your own computer does the work: the agents and keys you already have, in a sandbox, with nothing to host. You watch it live here and get the changes back as a patch, a branch or a pull request.</p>
<ol class="run-steps"><li>Add your computer on <a href="${MACHINES_URL}">openvibe.bot/machines</a>: one command, which installs OpenVibe Node with its job worker.</li><li>Sign in here and describe the task.</li><li>Your machine clones the repository, runs the agent and sends the result back.</li></ol>
<p><a class="run-btn run-btn-primary" href="/auth/login?next=%2Frun">Sign in to start</a></p>`,
            });
        }
        const [projects, recent] = await Promise.all([
            projectsOf(req, res),
            db.many('SELECT id, repo, prompt, state, created_at FROM run_tasks WHERE subject = $1 ORDER BY created_at DESC LIMIT 20', [req.viewer.subject]),
        ]);
        const body = html`<h1>Run on your machine</h1>
<p class="lead">The task runs on a machine you added on <a href="${MACHINES_URL}">openvibe.bot/machines</a>, in its job sandbox, with the agents and keys installed there. Nobody else's machine ever gets it.</p>
${projects.length ? formHtml({ projects, values, error }) : html`<form class="run-card" method="post" action="/run/project">
${error ? html`<p class="run-notice run-notice-error" role="alert">${error}</p>` : ''}
<h2>One thing first: a project</h2><p class="muted">Runs belong to a project on OpenVibe (that is where their usage is counted). You have none you can run jobs in yet.</p>
<label class="run-field"><span>Project name</span><input name="name" value="My code" maxlength="80" required></label>
<button class="run-btn run-btn-primary" type="submit">Create the project</button></form>`}
<h2>Your tasks</h2>
${tasksHtml(recent)}`;
        return page(req, res, { title: 'Run on your machine', body }, status);
    }

    r.get('/run', (req, res) => runPage(req, res));

    r.post('/run/project', form, async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Frun');
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        const name = String((req.body && req.body.name) || '').trim().slice(0, 80) || 'My code';
        try {
            await sso.asViewer(req, res, async (token) => {
                const out = await fetchImpl(`${config.networkInternalUrl}/api/v1/projects`, {
                    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify({ name }), signal: AbortSignal.timeout(8000),
                });
                if (out.status === 401) { const e = new Error('expired'); e.status = 401; throw e; }
                if (!out.ok) throw new Error(`Network answered ${out.status}`);
            });
        } catch (e) {
            return runPage(req, res, { error: `The project could not be created (${e.message}). Try again.`, status: 502 });
        }
        return res.redirect(303, '/run');
    });

    r.post('/run', form, async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Frun');
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        const b = req.body || {};
        const values = {
            repo: String(b.repo || '').trim(), ref: String(b.ref || '').trim(), prompt: String(b.prompt || ''),
            agent: String(b.agent || '').trim(), permission: b.permission === 'full' ? 'full' : 'edit', project: String(b.project || ''),
            push: b.push === '1', pull_request: b.push === '1' && b.pull_request === '1',
        };
        let args;
        try {
            if (values.agent && !harnesses.list().some((a) => a.id === values.agent)) throw new Error('choose an agent from the list');
            args = parseArgs(JSON.stringify({
                repo: values.repo, ref: values.ref || null, prompt: values.prompt, agent: values.agent || null, permission: values.permission,
                ...(values.push ? { push: { pull_request: values.pull_request } } : {}),
            }));
        } catch (e) {
            return runPage(req, res, { values, error: `Check the form: ${e.message}.`, status: 422 });
        }
        const projects = await projectsOf(req, res);
        if (!projects.some((p) => p.id === values.project)) return runPage(req, res, { values, error: 'Choose one of your projects.', status: 422 });
        const row = await tasks.start({ subject: req.viewer.subject, project: values.project, args });
        return res.redirect(303, `/run/tasks/${row.id}`);
    });

    function resultHtml(row) {
        const d = row.result || {};
        const files = Array.isArray(d.files) ? d.files : [];
        const push = d.push || null;
        const verdict = row.state !== 'succeeded'
            ? html`<p class="run-notice run-notice-error">${row.state === 'expired' ? 'No machine of yours took the task in time. Is it online on openvibe.bot/machines, with the Codes job runner?' : row.error || STATE_LABEL[row.state]}</p>`
            : d.ok ? html`<p class="run-notice run-notice-ok">The agents finished the task${d.agents && d.agents.length ? ` (${d.agents.join(' → ')})` : ''}.</p>`
                : html`<p class="run-notice run-notice-error">The task ended without success${d.error ? `: ${d.error}` : ''}.</p>`;
        return html`<section class="run-result">${verdict}
${d.outcome ? html`<p class="run-outcome"><strong>${d.outcome}</strong>${Array.isArray(d.remaining) && d.remaining.length ? html` · Still to do: ${d.remaining.join(', ')}` : ''}</p>` : ''}
${Array.isArray(d.proof) ? html`<section class="run-proof"><h2>Proof</h2><ul>${d.proof.map((item) => html`<li><span class="run-proof-state">${item.passed ? '✓' : '○'}</span> <strong>${item.label}</strong>${item.width ? html` · ${item.width}px` : ''}${item.command ? html` <code>${item.command}</code>` : ''}${item.family ? html` · reviewed by ${item.family}: ${item.verdict || 'no verdict'}` : ''}${item.path ? html` · <code>${item.path}</code>` : ''}${item.stats ? html`<pre>${item.stats}</pre>` : ''}${item.summary ? html`<p>${item.summary}</p>` : ''}</li>`)}</ul></section>` : ''}
${d.summary ? html`<h2>What the agent said</h2><pre tabindex="0" class="run-summary">${d.summary}</pre>` : ''}
${push ? (push.pushed ? html`<p>Pushed <a href="${push.branch_url}">${push.branch}</a>${push.pull_request ? html` · <a href="${push.pull_request}">pull request</a>` : ''}${push.pull_request_error ? html` · the pull request was not opened (${push.pull_request_error})` : ''}</p>` : html`<p class="muted">Not pushed: ${push.reason}</p>`) : ''}
${files.length ? html`<h2>Changed files</h2><table class="run-files"><tbody>${files.map((f) => html`<tr><td><code>${f.path}</code></td><td class="add">+${f.added == null ? '·' : f.added}</td><td class="del">−${f.removed == null ? '·' : f.removed}</td></tr>`)}</tbody></table>` : (row.state === 'succeeded' ? html`<p class="muted">No files changed.</p>` : '')}
${d.patch ? html`<h2>The patch${d.patch_truncated ? ' (cut)' : ''}</h2><pre tabindex="0" class="run-patch" data-patch>${d.patch}</pre>` : ''}
${typeof d.duration_ms === 'number' ? html`<p class="muted">${Math.round(d.duration_ms / 1000)} s on your machine${d.cost_usd ? ` · about $${Number(d.cost_usd).toFixed(4)} of model use on your own keys` : ''}</p>` : ''}
</section>`;
    }

    r.get('/run/tasks/:id', async (req, res) => {
        if (!signedIn(req)) return res.redirect(302, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        let row = await own(req, req.params.id);
        if (!row) return page(req, res, { title: 'Not found', body: html`<h1>Not found</h1><p>No such task of yours. <a href="/run">Your tasks</a></p>` }, 404);
        row = await refresh(row);
        const live = !TERMINAL.has(row.state);
        const body = html`<p class="crumbs"><a href="/run">Run on your machine</a></p>
<h1 class="run-repo">${repoName(row.repo)}${row.ref ? html` <small>${row.ref}</small>` : ''}</h1>
<p><span class="run-pill run-pill-${row.state}" data-state>${STATE_LABEL[row.state] || row.state}</span>${row.agent ? html` <span class="run-pill">${row.agent}</span>` : ''}</p>
<pre tabindex="0" class="run-prompt">${row.prompt}</pre>
${live ? html`<section class="run-live" data-events="/run/tasks/${row.id}/events" aria-live="polite"><h2>Live</h2><ol class="run-log" data-log></ol></section>
<form method="post" action="/run/tasks/${row.id}/cancel"><button class="run-btn" type="submit">Cancel</button></form>` : resultHtml(row)}`;
        return page(req, res, { title: 'Task', body });
    });

    r.get('/run/tasks/:id/events', async (req, res) => {
        if (!signedIn(req)) return res.status(401).end();
        const row = await own(req, req.params.id);
        if (!row || !row.job_id) return res.status(404).end();
        let url;
        try { url = await run.streamUrl(row.job_id, who(row)); } catch (e) { return res.status(e.status === 404 ? 404 : 503).end(); }
        const upstream = new AbortController();
        req.on('close', () => upstream.abort());
        let resp;
        try {
            resp = await fetchImpl(url, { headers: { Accept: 'text/event-stream' }, signal: upstream.signal });
        } catch { return res.status(503).end(); }
        if (!resp.ok || !resp.body) return res.status(resp.status === 404 ? 404 : 503).end();
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
        try {
            for await (const chunk of resp.body) { if (!res.write(chunk)) await new Promise((ok) => res.once('drain', ok)); }
        } catch { /* the browser left, or Run closed the stream */ }
        res.end();
        return undefined;
    });

    r.post('/run/tasks/:id/cancel', form, async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Frun');
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        const row = await own(req, req.params.id);
        if (!row) return res.status(404).type('text/plain').send('No such task of yours.\n');
        if (row.job_id && !TERMINAL.has(row.state)) {
            try { await run.cancel(row.job_id, who(row)); } catch (e) { log.warn(`[Codes] cancel ${row.id}: ${e.message}`); }
        }
        return res.redirect(303, `/run/tasks/${row.id}`);
    });

    return r;
}

module.exports = { createRunRoutes, STATE_LABEL, TERMINAL, esc };
