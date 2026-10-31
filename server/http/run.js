'use strict';
/**
 * Run on your machine (plan T16): a coding task started from any browser that runs on the person's own machine.
 *
 *   GET  /run                    the form, the person's projects and their recent tasks (a sign-in prompt for a guest)
 *   POST /run                    start one: a run_tasks row and an OpenVibe Run job for the person (server/domain/run-client.js)
 *   POST /run/project            create a project for the runs when the person has none they may run jobs in
 *   GET  /run/tasks/:id          one task: its attempts (the timeline), live while it runs, then the agents' summary,
 *                                the changed files and the patch
 *   GET  /run/tasks/:id/events   its live lines, proxied from Run's job stream (server-sent events)
 *   POST /run/tasks/:id/cancel   stop it
 *
 * Every task is its owner's alone (another person's is 404). Forms post only from this site. The job runs where Run
 * places it: on a machine the person added on openvibe.bot/machines, never anyone else's (contracts 0.161.0).
 */
const express = require('express');
const { serviceAuth, capabilities, http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { send } = require('../render/layout');
const { html, raw, esc } = require('../render/html');

const { parseArgs } = require('../../harness/job');
const { createRunTasks, TERMINAL, STATE_LABEL } = require('../domain/run-tasks');
const { createSessionLines } = require('../domain/session-lines');

const DELEGABLE = new Set(['owner', 'admin']);
const MACHINES_URL = 'https://openvibe.bot/machines';
const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The task's outcome in the words a person reads. */
const OUTCOME_TEXT = { done: 'Done', unfinished: "Didn't finish", stopped: 'Stopped by you' };

/** A repository URL as a heading: the host small, then owner/name, which may break after a slash but never mid-word. */
function repoName(url) {
    const [host, ...path] = String(url).replace(/^https:\/\//, '').split('/');
    if (!path.length) return host;
    return html`<small class="run-host">${host}/</small>${path.map((part, i) => html`${i ? raw('/<wbr>') : ''}${part}`)}`;
}

function createRunRoutes({ config, store, sso, harnesses, run, fetchImpl = globalThis.fetch, log = console, tasks = null, sessions = null, keys = null }) {
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
    // A task reads Run only as the 10-minute fallback; its state now arrives from run.job.* events.
    const taskStore = tasks || createRunTasks({ store, run, config, log });
    const sessionStore = sessions || createSessionLines({ store, config, log, media: require('../media').createMedia({ config, log }) });
    const { who, refresh } = taskStore;

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
<input type="hidden" name="prompt" value="${values && values.prompt || ''}">
<input type="hidden" name="repo" value="${values && values.repo || ''}">
<label class="run-field"><span>Project name</span><input name="name" value="My code" maxlength="80" required></label>
<button class="run-btn run-btn-primary" type="submit">Create the project</button></form>`}
<h2>Your tasks</h2>
${tasksHtml(recent)}`;
        return page(req, res, { title: 'Run on your machine', body }, status);
    }

    r.get('/run', (req, res) => runPage(req, res, { values: { prompt: String(req.query.prompt || '').slice(0, 16000), repo: String(req.query.repo || '').slice(0, 2000), agent: String(req.query.agent || '').slice(0, 100) } }));

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
            return runPage(req, res, { values: { prompt: String(req.body && req.body.prompt || '').slice(0, 16000), repo: String(req.body && req.body.repo || '').slice(0, 2000) }, error: `The project could not be created (${e.message}). Try again.`, status: 502 });
        }
        const prompt = String(req.body && req.body.prompt || '').slice(0, 16000);
        const repo = String(req.body && req.body.repo || '').slice(0, 2000);
        const query = new URLSearchParams();
        if (prompt) query.set('prompt', prompt);
        if (repo) query.set('repo', repo);
        const suffix = query.toString();
        return res.redirect(303, `/run${suffix ? `?${suffix}` : ''}`);
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
        const row = await taskStore.start({ subject: req.viewer.subject, project: values.project, args });
        return res.redirect(303, `/run/tasks/${row.id}`);
    });

    /** The end of a task: the verdict, what the agents said, the files and the patch. With the session on the page (`session`),
     *  its closing card already says how it ended and the agents' last words, so only a failure keeps its notice. */
    function resultHtml(row, { session = false } = {}) {
        const d = row.result || {};
        const files = Array.isArray(d.files) ? d.files : [];
        const push = d.push || null;
        const verdict = row.state !== 'succeeded'
            ? html`<p class="run-notice run-notice-error">${row.state === 'expired' ? 'No machine of yours took the task in time. Is it online on openvibe.bot/machines, with the Codes job runner?' : row.error || STATE_LABEL[row.state]}</p>`
            : d.ok ? html`<p class="run-notice run-notice-ok">The agents finished the task${d.agents && d.agents.length ? ` (${d.agents.join(' → ')})` : ''}.</p>`
                : html`<p class="run-notice run-notice-error">The task ended without success${d.error ? `: ${d.error}` : ''}.</p>`;
        const ended = !(session && row.state === 'succeeded' && d.ok);
        return html`<section class="run-result">${ended ? verdict : ''}
${d.summary && !session ? html`<h2>What the agent said</h2><pre tabindex="0" class="run-summary">${d.summary}</pre>` : ''}
${push ? (push.pushed ? html`<p>Pushed <a href="${push.branch_url}">${push.branch}</a>${push.pull_request ? html` · <a href="${push.pull_request}">pull request</a>` : ''}${push.pull_request_error ? html` · the pull request was not opened (${push.pull_request_error})` : ''}</p>` : html`<p class="muted">Not pushed: ${push.reason}</p>`) : ''}
${files.length ? html`<h2>Changed files</h2><table class="run-files"><tbody>${files.map((f) => html`<tr><td><code>${f.path}</code></td><td class="add">+${f.added == null ? '·' : f.added}</td><td class="del">−${f.removed == null ? '·' : f.removed}</td></tr>`)}</tbody></table>` : (row.state === 'succeeded' ? html`<p class="muted">No files changed.</p>` : '')}
${d.patch ? html`<h2>The patch${d.patch_truncated ? ' (cut)' : ''}</h2><pre tabindex="0" class="run-patch" data-patch>${d.patch}</pre>` : ''}
${typeof d.duration_ms === 'number' ? html`<p class="muted">${Math.round(d.duration_ms / 1000)} s on your machine${d.cost_usd ? ` · about $${Number(d.cost_usd).toFixed(4)} of model use on your own keys` : ''}</p>` : ''}
</section>`;
    }

    /** The task's timeline: every attempt and why it happened. The data-* hooks are for the design of stage C4. */
    async function timelineHtml(row) {
        const attempts = await taskStore.attempts.list(row.id);
        if (!attempts.length) return '';
        // The outcome in plain words: the label, and the note beside it — unless the note already says it
        // ("Done with proof: …" says "Done" already, so it is not said twice).
        const note = row.outcome_note || '';
        const label = row.outcome ? (OUTCOME_TEXT[row.outcome] || row.outcome) : '';
        const says = !!label && note.toLowerCase().startsWith(label.toLowerCase());
        const outcome = row.outcome
            ? html`<p class="run-outcome" data-outcome="${row.outcome}"><b>${says ? note : [label, note].filter(Boolean).join(' ')}</b></p>`
            : '';
        return html`<section class="run-timeline" data-timeline data-attempts="${attempts.length}">
<h2>The attempts</h2>
${row.placement_line ? html`<p class="run-placed" data-placement>Placed: ${row.placement_line}</p>` : ''}
<ol class="run-attempts">${attempts.map((a) => html`<li class="run-attempt" data-attempt="${a.n}" data-attempt-id="${a.id}" data-state="${a.state}" data-reason="${a.reason || ''}" data-kind="${a.kind || 'first'}" data-agent="${a.agent || ''}">
<p class="run-attempt-head"><b>Attempt ${a.n}</b>${a.agent ? html` · ${a.agent}` : ''} <span class="run-pill run-pill-${a.state}">${a.state}</span></p>
<p class="run-attempt-why" data-why>${a.why || ''}</p>
${a.reason ? html`<p class="run-attempt-end" data-end-why>${taskStore.attempts.wordsOf(a.reason)}</p>` : ''}
</li>`)}</ol>
${outcome}
</section>`;
    }

    /**
     * The task's proof (stage C8): the tests, the pages, the diff and the second model's opinion, each with what it
     * found. The outcome in plain words sits above it, so a person reads what was proved before the detail.
     */
    async function proofHtml(row) {
        const items = await taskStore.proof.list(row.id);
        if (!items.length) return '';
        const shown = taskStore.proof.present(items);
        return html`<section class="run-proof" data-proof data-items="${shown.length}">
<h2>The proof</h2>
<ul class="run-proof-items">${shown.map((i) => html`<li class="run-proof-item" data-proof-kind="${i.kind}" data-ok="${i.ok}" data-skipped="${i.skipped}">
<p class="run-proof-head"><b>${i.label}</b>${i.skipped ? html` <span class="run-pill">skipped</span>` : (i.ok ? html` <span class="run-pill run-pill-succeeded">passed</span>` : html` <span class="run-pill run-pill-failed">failed</span>`)}${i.family ? html` · ${i.family}` : ''}</p>
${i.summary ? html`<p class="run-proof-summary" data-proof-summary>${i.summary}</p>` : ''}
</li>`)}</ul>
</section>`;
    }

    r.get('/run/tasks/:id', async (req, res) => {
        if (!signedIn(req)) return res.redirect(302, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        let row = await own(req, req.params.id);
        if (!row) return page(req, res, { title: 'Not found', body: html`<h1>Not found</h1><p>No such task of yours. <a href="/run">Your tasks</a></p>` }, 404);
        row = await refresh(row);
        const live = !TERMINAL.has(row.state);
        // The agents' session (openvibe-shared/agent-session.js, js/run.js mounts it): live from the job's stream, and
        // after the end from codes_session_lines; a task from before this change falls back to the result's old log.
        const lines = live ? null : await sessionStore.linesForRow(row);
        const title = String(row.prompt || '').split('\n')[0].slice(0, 90);
        const session = lines && lines.length ? html`<section class="run-session" data-session data-title="${title}" data-state="${row.state}"><h2>The session</h2><div data-session-view></div><script type="application/json" data-session-log>${raw(JSON.stringify(lines).replace(/</g, '\\u003c'))}</script></section>` : '';
        const body = html`<p class="crumbs"><a href="/run">Run on your machine</a></p>
<h1 class="run-repo">${repoName(row.repo)}${row.ref ? html` <small>${row.ref}</small>` : ''}</h1>
<p><span class="run-pill run-pill-${row.state}" data-state>${STATE_LABEL[row.state] || row.state}</span>${row.agent ? html` <span class="run-pill">${row.agent}</span>` : ''}</p>
<pre tabindex="0" class="run-prompt">${row.prompt}</pre>
${await timelineHtml(row)}
${await proofHtml(row)}
${live ? html`<section class="run-live" data-events="/run/tasks/${row.id}/events" data-title="${title}" aria-live="polite"><h2>Live</h2><ol class="run-log" data-log></ol></section>
<form method="post" action="/run/tasks/${row.id}/cancel"><button class="run-btn" type="submit">Cancel</button></form>` : html`${session}${resultHtml(row, { session: !!(lines && lines.length) })}`}`;
        return page(req, res, { title: 'Task', body, sharedScripts: ['agent-session.js'] });
    });

    /**
     * The service half of session.json: a Network service token holding codes.task.read, acting for the person named
     * in X-OV-Subject. Unlike the task API's writes, a read here is not limited to the service that started the task:
     * the capability and the person are the grant.
     */
    async function serviceOwn(req, id) {
        if (!keys) return { status: 503, code: 'identity.unavailable', detail: 'the Network signing key is not available' };
        const header = String(req.headers.authorization || '');
        if (!header.startsWith('Bearer ')) return { status: 401, code: 'token.required', detail: 'codes.task.read needs a Network service token or a signed-in owner' };
        if (!keys.loaded()) await keys.ensure();
        const publicKey = keys.get();
        if (!publicKey) return { status: 503, code: 'identity.unavailable', detail: 'the Network signing key is not loaded yet' };
        const v = serviceAuth.verifyServiceToken(header.slice(7).trim(), { publicKey, issuer: config.networkIssuer, audience: config.serviceAudience });
        if (!v.ok) return { status: 401, code: v.code || 'token.invalid', detail: v.reason || 'the service token is invalid' };
        const sub = String(v.claims.sub || '');
        if (!sub.startsWith('svc:')) return { status: 403, code: 'capability.denied', detail: 'codes.task.read is for first-party services' };
        const decision = capabilities.check(v.claims, 'codes.task.read');
        if (!decision.allowed) return { status: 403, code: decision.code || 'capability.denied', detail: decision.reason || 'codes.task.read not granted' };
        const subject = String(req.get('X-OV-Subject') || '').trim();
        if (!USER.test(subject)) return { status: 422, code: 'subject.required', detail: 'name the person in X-OV-Subject (usr_…)' };
        if (!/^tsk_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id))) return { status: 404, code: 'codes.task_not_found', detail: 'no such task for this person' };
        const row = await db.maybe('SELECT * FROM run_tasks WHERE id = $1 AND subject = $2', [id, subject]);
        return row ? { row } : { status: 404, code: 'codes.task_not_found', detail: 'no such task for this person' };
    }

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
        // The bytes go to the browser unchanged, and the same frames become codes_session_lines as they stream.
        const attempts = await taskStore.attempts.list(row.id);
        const attemptN = attempts.length ? Number(attempts[attempts.length - 1].n) : null;
        const recorder = sessionStore.recorder(row.id, { attemptN, subject: row.subject });
        const decoder = new TextDecoder();
        try {
            for await (const chunk of resp.body) {
                if (!res.write(chunk)) await new Promise((ok) => res.once('drain', ok));
                try { await recorder.push(decoder.decode(chunk, { stream: true })); } catch (e) { log.warn(`[Codes] session ${row.id}: ${e.message}`); }
            }
        } catch { /* the browser left, or Run closed the stream */ }
        try { await recorder.push(decoder.decode()); await recorder.flush(); } catch (e) { log.warn(`[Codes] session ${row.id}: ${e.message}`); }
        // The stream's end is the machine's result arriving: fetch it once, finalize the row and back-fill the log.
        if (recorder.ended()) {
            try {
                const fresh = await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [row.id]);
                if (fresh) await taskStore.refresh(fresh, { force: true });
            } catch (e) { log.warn(`[Codes] task ${row.id}: ${e.message}`); }
        }
        res.end();
        return undefined;
    });

    /** Session replay: the same page's lines, after a seq, for the owner or a service with codes.task.read. */
    r.get('/run/tasks/:id/session.json', async (req, res) => {
        let row = null;
        if (signedIn(req)) {
            row = await own(req, req.params.id);
        } else {
            const out = await serviceOwn(req, req.params.id);
            if (!out.row) return http.sendProblem(res, out.status, out.code, { detail: out.detail, ctx: req.ov });
            row = out.row;
        }
        if (!row) return http.sendProblem(res, 404, 'codes.task_not_found', { detail: 'no such task of yours', ctx: req.ov });
        const raw = String(req.query.after == null ? '0' : req.query.after);
        const after = /^\d+$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isSafeInteger(after)) return http.sendProblem(res, 422, 'codes.after_invalid', { detail: 'after is a line sequence number (0 or more)', ctx: req.ov });
        const replay = await sessionStore.replay(row, { after, limit: 500 });
        res.set('Cache-Control', 'no-store');
        return res.json(replay);
    });

    r.post('/run/tasks/:id/cancel', form, async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Frun');
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        const row = await own(req, req.params.id);
        if (!row) return res.status(404).type('text/plain').send('No such task of yours.\n');
        // The running attempt stops: the outcome is "stopped" and nothing carries it on.
        try { await taskStore.stopTask(row); } catch (e) { log.warn(`[Codes] cancel ${row.id}: ${e.message}`); }
        return res.redirect(303, `/run/tasks/${row.id}`);
    });

    return r;
}

module.exports = { createRunRoutes, STATE_LABEL, TERMINAL, esc };
