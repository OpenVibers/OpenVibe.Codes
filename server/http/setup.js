'use strict';

/**
 * The guided setup (owner 2026-11-03: "a guided setup which is intuitive and very user friendly for the user to configure
 * their API keys, accounts, harnesses, etc."): /setup, one page of five steps, each read live from where it lives —
 *
 *   1 Your machine      paired and online (Network, with the person's token)
 *   2 Your agents       installed and signed in on it, with what each has left (the fleet, read from Bot now)
 *   3 Your AI keys      optional: keys on Your AI (OpenVibe.AI) for the agents and models paid by use
 *   4 Your accounts     optional: OpenVibe Git, linked once
 *   5 Your choices      the default agent and machine, the conductor's fallbacks and its switch point, the safety level
 *
 * Nothing is stored about the setup itself: a step is done when the thing it sets up is there, so the page is right
 * however the person got there. Every step is on the page at once (nothing folded away); the first that needs the
 * person is marked Next. The pickers say what each choice is ready for (domain/readiness.js), and Shared's ov-forms.js
 * draws them as OpenVibe's own select.
 *
 *   GET  /setup             the page
 *   POST /setup/choices     step 5's form → codes_user_settings, back to /setup#step-choices
 *   setupProgress(req)      what the home page's "Finish setting up" card says (database reads only)
 */

const { asyncRouter } = require('./router');
const { esc } = require('../render/html');
const { readiness, optionAttrs, SETUP } = require('../domain/readiness');
const { CONDUCTOR_AGENTS, AGENT_NAMES } = require('../domain/conductor-failover');

const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

function createSetupRoutes(ctx, kit) {
    const { page, wrap, pill, flash, sameOrigin, viewer, form, signIn, note, machinesOf, usageMeter, SAFETY_OPTIONS = [], YOUR_AI, PROVIDER_NAMES = {} } = kit;
    const { store, fleet, harnesses, connections, sso, forge, userSettings } = ctx;
    const db = store.db;
    const r = asyncRouter();

    const command = (text, label) => `<div class="c4-setup-cmd"><span class="c4-setup-cmd-label">${esc(label)}</span><code tabindex="0">${esc(text)}</code></div>`;

    /** Everything the page says, read once per view. */
    async function readAll(req, res) {
        const subject = req.viewer.subject;
        const machineList = await machinesOf(req, res);
        let fleetProblem = null;
        if (fleet) {
            try {
                const out = await sso.asViewer(req, res, (token) => fleet.refresh(subject, token));
                if (out && out.problem) fleetProblem = out.problem;
            } catch (e) { fleetProblem = { detail: String((e && e.message) || 'the fleet could not be read').slice(0, 200) }; }
        }
        const rows = fleet ? await fleet.agents(subject, harnesses).catch(() => []) : [];
        let keys = null;
        try { keys = connections ? await sso.asViewer(req, res, (token) => connections.mine(token)) : null; } catch { keys = null; }
        let git = null;
        try { git = forge && forge.enabled ? await forge.link(subject) : null; } catch { git = null; }
        const settings = await userSettings.get(subject);
        const saved = !!(await db.maybe('SELECT 1 AS one FROM codes_user_settings WHERE subject = $1', [subject]));
        return { machines: machineList, rows, fleetProblem, keys, git, settings, saved };
    }

    function stepsOf(d) {
        const live = (d.machines.machines || []).filter((m) => m.state !== 'revoked');
        const online = live.filter((m) => m.state === 'online');
        const ready = d.rows.filter((x) => x.state === 'ok' || x.state === 'low');
        const credentials = (d.keys && d.keys.credentials) || [];
        return [
            { id: 'machine', title: 'Your machine', short: 'Machine', done: online.length > 0, warn: !online.length && live.length > 0, required: true },
            { id: 'agents', title: 'Your agents', short: 'Agents', done: ready.length > 0, required: true },
            { id: 'keys', title: 'Your AI keys', short: 'AI keys', done: credentials.some((k) => k.status !== 'failing'), optional: true },
            { id: 'accounts', title: 'Your accounts', short: 'Accounts', done: !!d.git, optional: true },
            { id: 'choices', title: 'Your choices', short: 'Choices', done: d.saved, required: true },
        ];
    }

    function stepCard(step, n, next, body, sub) {
        const state = step.done ? pill('Done', 'ok') : step.id === next ? pill('Next', 'open') : step.optional ? pill('Optional', 'skip') : pill('To do', 'skip');
        return `<section class="c4-card c4-setup-step${step.done ? ' is-done' : ''}${step.id === next ? ' is-next' : ''}" id="step-${step.id}" aria-labelledby="step-${step.id}-h">
<div class="c4-setup-step-head"><span class="c4-setup-n" aria-hidden="true">${step.done ? CHECK : n}</span><div class="c4-setup-step-title"><h2 id="step-${step.id}-h">${esc(step.title)}</h2><p>${sub}</p></div>${state}</div>
<div class="c4-setup-body">${body}</div></section>`;
    }

    function machineBody(d) {
        const list = (d.machines.machines || []).filter((m) => m.state !== 'revoked');
        const rows = list.map((m) => `<li class="c4-row c4-row-flat"><span class="c4-row-dot c4-dot-${m.state === 'online' ? 'ok' : 'skip'}" aria-hidden="true"></span><span class="c4-row-label">${esc(m.name || m.node_id || m.id)}</span><span class="c4-row-note">${m.state === 'online' ? 'Online: ready for your work' : 'Offline: start it, and it comes back here'}</span></li>`).join('');
        const problem = d.machines.ok === false && d.machines.problem ? note(esc(d.machines.problem.detail || 'Your machines could not be read.'), 'bad') : '';
        const how = `<ol class="c4-setup-how">
<li><b>Get a one-time code</b> on <a href="https://openvibe.bot/machines" rel="noopener">openvibe.bot/machines</a>. It lasts ten minutes.</li>
<li><b>Run the installer on that computer</b> and give it the code:${command('curl -fsSL https://openvibe.bot/install | sh -s -- --worker', 'On the machine')}</li>
<li><b>It pairs itself</b> and shows up here as Online. It runs your work and nobody else's.</li></ol>`;
        return `${problem}${rows ? `<ul class="c4-rows">${rows}</ul>` : ''}${list.length ? `<details class="c4-setup-more"><summary>Pair another machine</summary>${how}</details>` : how}
<div class="c4-setup-actions"><a class="c4-button${list.length ? ' c4-button-light' : ''}" href="/machines#pair">${list.length ? 'Manage machines' : 'I have a code'}</a><a class="c4-opill" href="/setup#step-machine">Check again</a></div>`;
    }

    function agentsBody(d) {
        const by = new Map(d.rows.map((x) => [x.agent, x]));
        const ids = [...new Set([...Object.keys(SETUP), ...d.rows.map((x) => x.agent)])];
        const items = ids.map((id) => {
            const row = by.get(id);
            const how = SETUP[id] || null;
            const name = (row && row.name) || (how && how.name) || id;
            const st = row ? row.state : 'absent';
            const word = { ok: ['Ready', 'ok'], low: ['Nearly full', 'skip'], limited: ['Full for now', 'bad'], empty: ['Out of credit', 'bad'], login: ['Sign in', 'bad'], absent: ['Not installed', 'skip'], unknown: ['No reading', 'skip'] }[st] || ['No reading', 'skip'];
            const meters = row && row.windows && row.windows.length ? `<div class="c4-fleet-windows">${row.windows.map(usageMeter).join('')}</div>` : '';
            let help = '';
            if (st === 'absent' || st === 'login') {
                help = how && how.install
                    ? `<div class="c4-setup-agent-help">${st === 'absent' ? command(how.install, '1 · Install') : ''}${command(how.signIn, `${st === 'absent' ? '2' : '1'} · Sign in`)}${how.signInNote ? `<p class="c4-hint">Run it ${esc(how.signInNote)}, on the machine, as you. It uses ${esc(how.plan)}.</p>` : `<p class="c4-hint">On the machine, as you. It uses ${esc(how.plan)}.</p>`}</div>`
                    : `<div class="c4-setup-agent-help"><p class="c4-hint">Install it and sign in on the machine${how && how.docs ? ` (<a href="${esc(how.docs)}" rel="noopener">its guide</a>)` : ''}; Codes sees it on the machine's next heartbeat.</p></div>`;
            }
            return `<li class="c4-row c4-fleet-row c4-setup-agent" id="agent-${esc(id)}"><span class="c4-row-dot${st === 'ok' ? ' c4-dot-ok' : st === 'login' || st === 'limited' || st === 'empty' ? ' c4-dot-bad' : ''}" aria-hidden="true"></span><span class="c4-row-label">${esc(name)}</span><span class="c4-row-note">${esc(how ? how.plan : 'on your machine')}</span>${pill(word[0], word[1])}${meters}${help}</li>`;
        }).join('');
        const problem = d.fleetProblem ? note(`Your machines' agents could not be read just now: ${esc(d.fleetProblem.detail || 'Bot did not answer')}. The last reading is below.`, 'bad') : '';
        return `${problem}<p class="c4-hint">One signed-in agent is enough to start; two let your conductor carry on when one runs out (step 5).</p><ul class="c4-rows c4-fleet">${items}</ul>
<div class="c4-setup-actions"><a class="c4-opill" href="/setup#step-agents">Check again</a><a class="c4-opill" href="/agents">All agents and their usage</a></div>`;
    }

    function keysBody(d) {
        const list = (d.keys && d.keys.credentials) || [];
        const rows = list.map((k) => `<li class="c4-row c4-row-flat"><span class="c4-row-dot${k.status === 'ok' ? ' c4-dot-ok' : k.status === 'failing' ? ' c4-dot-bad' : ''}" aria-hidden="true"></span><span class="c4-row-label">${esc(PROVIDER_NAMES[k.provider] || k.provider)}</span><span class="c4-row-note">…${esc(k.hint || '????')}</span>${k.status === 'ok' ? pill('Working', 'ok') : k.status === 'failing' ? pill('Not working', 'bad') : pill('Not tested', 'skip')}</li>`).join('');
        return `<p class="c4-hint">Only for agents and models you pay for by use (DeepSeek, OpenAI, Anthropic, Google and more). An agent signed in with a plan needs no key. Keys live on Your AI, sealed, and every OpenVibe site uses the same ones.</p>
${rows ? `<ul class="c4-rows">${rows}</ul>` : d.keys ? '<div class="c4-emptyline">No keys yet.</div>' : '<div class="c4-emptyline">Your keys could not be read just now.</div>'}
<div class="c4-setup-actions"><a class="c4-button${rows ? ' c4-button-light' : ''}" href="${esc(YOUR_AI)}" rel="noopener">${rows ? 'Manage keys' : 'Add a key'} ↗</a></div>`;
    }

    function accountsBody(d) {
        if (!forge || !forge.enabled) return '<p class="c4-hint">OpenVibe Git opens here once it trusts Codes. Your tasks can already work on any GitHub or OpenVibe Git repository you can reach.</p>';
        return d.git
            ? `<ul class="c4-rows"><li class="c4-row c4-row-flat"><span class="c4-row-dot c4-dot-ok" aria-hidden="true"></span><span class="c4-row-label">OpenVibe Git</span><span class="c4-row-note">Linked as ${esc(d.git.forge_user || 'you')}</span>${pill('Linked', 'ok')}</li></ul><div class="c4-setup-actions"><a class="c4-opill" href="/git">Your repositories</a></div>`
            : `<p class="c4-hint">Link OpenVibe Git once, and Codes can make repositories in your name and push your tasks' branches there. It is one consent with your OpenVibe account.</p><div class="c4-setup-actions"><a class="c4-button c4-button-light" href="/git/connect">Link OpenVibe Git</a></div>`;
    }

    function choicesBody(d, machines) {
        const s = d.settings;
        const ready = readiness(d.rows);
        const offers = (harnesses && harnesses.list ? harnesses.list() : []).filter((a) => a && a.id);
        const agentOption = (id, name, selected) => `<option value="${esc(id)}"${selected ? ' selected' : ''}${optionAttrs(ready.get(id))}>${esc(name)}</option>`;
        const agents = offers.map((a) => agentOption(a.id, a.name || a.id, s.default_agent === a.id)).join('');
        const machineOptions = (machines.machines || []).filter((m) => m.state !== 'revoked').map((m) => `<option value="${esc(m.node_id || m.id)}"${s.default_machine && (s.default_machine === m.node_id || s.default_machine === m.id) ? ' selected' : ''} data-state="${m.state === 'online' ? 'ok' : 'off'}" data-badge="${m.state === 'online' ? 'Online' : 'Offline'}">${esc(m.name || m.node_id || m.id)}</option>`).join('');
        const fallbacks = s.conductor_fallbacks || [];
        const fallbackRow = (i) => {
            const f = fallbacks[i] || { agent: '', model: '' };
            const options = CONDUCTOR_AGENTS.filter((a) => a !== 'claude-code').map((a) => agentOption(a, AGENT_NAMES[a], f.agent === a)).join('');
            return `<div class="c4-fallback"><span class="c4-fallback-n" aria-hidden="true">${i + 1}</span><label>Fallback ${i + 1} <select name="fallback_agent_${i + 1}" data-ov-title="Fallback ${i + 1}"><option value="">None</option>${options}</select></label><label>Model <input name="fallback_model_${i + 1}" value="${esc(f.model || '')}" placeholder="its default" autocomplete="off" spellcheck="false" maxlength="100"></label></div>`;
        };
        const pct = s.conductor_switch_pct || 90;
        return `<form class="c4-form" method="post" action="/setup/choices">
<div class="c4-form-grid">
<label>Default agent <select name="default_agent" data-ov-title="Default agent"><option value="" data-desc="Codes picks the agent with room for each task">Auto</option>${agents}</select></label>
<label>Default machine <select name="default_machine" data-ov-title="Default machine"><option value="" data-desc="Your machine with room, else OpenVibe's">Auto</option>${machineOptions}</select></label>
</div>
<h3 class="c4-subhead">When your conductor's agent runs low</h3>
<p class="c4-hint">Your conductor runs Claude Code. When it nears a usage limit, the next turn moves to the first fallback with room, and comes back once the window frees.</p>
<div class="c4-fallbacks">${[0, 1, 2].map(fallbackRow).join('')}</div>
<div class="c4-form-grid"><label>Switch at <select name="conductor_switch_pct">${[70, 80, 85, 90, 95].map((v) => `<option value="${v}"${pct === v ? ' selected' : ''}>${v}% of a window</option>`).join('')}</select></label></div>
<h3 class="c4-subhead">Safety</h3>
<div class="c4-safety" role="group" aria-label="Safety level">${SAFETY_OPTIONS.map(([value, title, desc]) => `<label class="c4-safety-card"><input type="radio" name="safety" value="${esc(value)}"${s.safety === value ? ' checked' : ''}><span><b>${esc(title)}</b><small>${esc(desc)}</small></span></label>`).join('')}</div>
<div class="c4-setup-actions"><button class="c4-button" type="submit">Save my choices</button><a class="c4-opill" href="/settings">All settings</a></div>
</form>`;
    }

    r.get('/setup', async (req, res) => {
        if (!viewer(req)) return page(req, res, 'Set up Codes', wrap(`<div class="c4-title"><div><h1>Set up Codes</h1><p>Your machine, your agents, your keys: five short steps.</p></div></div>${signIn(req)}`));
        const d = await readAll(req, res);
        const steps = stepsOf(d);
        const next = (steps.find((s) => !s.done && s.required) || steps.find((s) => !s.done && !s.optional) || {}).id || null;
        const done = steps.filter((s) => s.done).length;
        const requiredLeft = steps.filter((s) => s.required && !s.done).length;
        const pctDone = Math.round((done / steps.length) * 100);
        const subs = {
            machine: 'Where your agents run: one of your own computers, paired once.',
            agents: 'The coding agents on it, signed in with your own plans.',
            keys: 'Keys for the models you pay for by use.',
            accounts: 'Where your work is pushed.',
            choices: 'What Codes uses when you do not say.',
        };
        const bodies = { machine: machineBody(d), agents: agentsBody(d), keys: keysBody(d), accounts: accountsBody(d), choices: choicesBody(d, d.machines) };
        const nav = steps.map((s, i) => `<li><a class="c4-setup-chip${s.done ? ' is-done' : ''}${s.id === next ? ' is-next' : ''}" href="#step-${s.id}"><span class="c4-setup-chip-n" aria-hidden="true">${s.done ? CHECK : i + 1}</span>${esc(s.short)}<span class="c4-sr-only">${s.done ? ', done' : s.optional ? ', optional' : ''}</span></a></li>`).join('');
        const ready = requiredLeft === 0
            ? `<section class="c4-card c4-setup-ready"><h2>You are set</h2><p>Your machine, an agent and your choices are in place.${steps.some((s) => s.optional && !s.done) ? ' The optional steps can wait.' : ''}</p><div class="c4-setup-actions"><a class="c4-button" href="/">Start a task</a><a class="c4-opill" href="/conductor">Start your conductor</a></div></section>`
            : '';
        const content = `<div class="c4-setup">
<div class="c4-setup-head"><div class="c4-title"><div><h1>Set up Codes</h1><p>${requiredLeft ? `${requiredLeft} step${requiredLeft === 1 ? '' : 's'} left before your first task.` : 'Everything your tasks need is ready.'} Each step checks itself; come back any time.</p></div></div>
<div class="c4-setup-progress"><div class="c4-setup-bar" role="progressbar" aria-label="Setup" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${done}"><span style="width:${pctDone}%"></span></div><span class="c4-setup-count">${done} of ${steps.length} done</span></div>
<nav aria-label="Setup steps"><ol class="c4-setup-nav">${nav}</ol></nav></div>
${flash(req)}${ready}${steps.map((s, i) => stepCard(s, i + 1, next, bodies[s.id], subs[s.id])).join('')}</div>`;
        page(req, res, 'Set up Codes', wrap(content));
    });

    r.post('/setup/choices', form, async (req, res) => {
        if (!viewer(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent('/setup')}`);
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        const b = req.body || {};
        try {
            await userSettings.save(req.viewer.subject, {
                default_agent: b.default_agent === undefined ? undefined : b.default_agent,
                default_machine: b.default_machine === undefined ? undefined : b.default_machine,
                ...(b.safety ? { safety: b.safety } : {}),
                ...(b.fallback_agent_1 !== undefined ? {
                    conductor_fallbacks: [1, 2, 3].map((n) => ({ agent: b[`fallback_agent_${n}`] || '', model: b[`fallback_model_${n}`] || '' })).filter((f) => f.agent),
                } : {}),
                ...(b.conductor_switch_pct !== undefined ? { conductor_switch_pct: b.conductor_switch_pct } : {}),
            });
            return res.redirect(303, '/setup?ok=Your%20choices%20are%20saved#step-choices');
        } catch (e) {
            return res.redirect(303, `/setup?error=${encodeURIComponent(String((e && e.message) || 'your choices could not be saved').slice(0, 180))}#step-choices`);
        }
    });

    /**
     * The home page's card: how far the person is, from the database alone (the stored fleet and settings; no call to
     * Network or Bot on the home page). null when the setup needs nothing more.
     */
    r.setupProgress = async (req) => {
        if (!viewer(req)) return null;
        const subject = req.viewer.subject;
        const latest = fleet ? await fleet.latest(subject).catch(() => ({ machines: [] })) : { machines: [] };
        const rows = fleet ? await fleet.agents(subject, harnesses).catch(() => []) : [];
        const saved = !!(await db.maybe('SELECT 1 AS one FROM codes_user_settings WHERE subject = $1', [subject]));
        const steps = [
            { title: 'Your machine', done: (latest.machines || []).length > 0 },
            { title: 'Your agents', done: rows.some((x) => x.state === 'ok' || x.state === 'low') },
            { title: 'Your choices', done: saved },
        ];
        const left = steps.filter((s) => !s.done);
        return left.length ? { done: steps.length - left.length, of: steps.length, next: left[0].title } : null;
    };

    return r;
}

module.exports = { createSetupRoutes };
