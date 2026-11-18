'use strict';

/**
 * The guided setup (owner 2026-11-03: "a guided setup which is intuitive and very user friendly for the user to configure
 * their API keys, accounts, harnesses, etc."): /setup, one page of six steps (your agent home since 2026-11-17), each read live from where it lives —
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
const ovkKit = require('openvibe-shared/kit');
const { readiness, optionAttrs, SETUP } = require('../domain/readiness');
const { CONDUCTOR_AGENTS, AGENT_NAMES } = require('../domain/conductor-failover');

const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

function createSetupRoutes(ctx, kit) {
    const { page, wrap, pill, flash, sameOrigin, viewer, form, signIn, note, machinesOf, computeOf, usageMeter, SAFETY_OPTIONS = [], YOUR_AI, PROVIDER_NAMES = {} } = kit;
    const { store, fleet, harnesses, connections, sso, forge, userSettings, homes } = ctx;
    const db = store.db;
    const r = asyncRouter();

    // A command to type on the machine: it wraps on a phone (never a page wider than the screen), and Copy copies it.
    const command = (text, label) => `<div class="c4-setup-cmd"><span class="c4-setup-cmd-label">${esc(label)}</span><div class="c4-setup-cmd-box"><code tabindex="0">${esc(text)}</code><button type="button" class="c4-setup-copy" data-c4-copy>Copy</button></div></div>`;

    /** Everything the page says, read once per view. */
    async function readAll(req, res) {
        const subject = req.viewer.subject;
        const machineList = await machinesOf(req, res);
        const compute = await computeOf(req, res);
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
        try { git = forge && forge.enabled ? await forge.repos({ subject, username: req.viewer.username || '' }) : null; } catch { git = null; }
        const settings = await userSettings.get(subject);
        const saved = !!(await db.maybe('SELECT 1 AS one FROM codes_user_settings WHERE subject = $1', [subject]));
        const home = homes ? await homes.get(subject).catch(() => null) : null;
        return { machines: machineList, compute, rows, fleetProblem, keys, git, settings, saved, home };
    }

    function stepsOf(d) {
        const live = (d.machines.machines || []).filter((m) => m.state !== 'revoked');
        const online = (d.compute.candidates || []).filter((m) => m.status === 'ready');
        const ready = d.rows.filter((x) => x.state === 'ok' || x.state === 'low');
        const credentials = (d.keys && d.keys.credentials) || [];
        return [
            { id: 'machine', title: 'Pick where it runs', short: 'Runs on', done: online.length > 0, warn: !online.length && live.length > 0, required: true },
            { id: 'agents', title: 'Your agents', short: 'Agents', done: ready.length > 0, required: true },
            { id: 'home', title: 'Your agent home', short: 'Home', done: !!(d.home && d.home.saved && Object.keys(d.home.applied || {}).length), optional: true },
            { id: 'keys', title: 'Your AI keys', short: 'AI keys', done: credentials.some((k) => k.status !== 'failing'), optional: true },
            { id: 'accounts', title: 'Your accounts', short: 'Accounts', done: !!(d.git && d.git.length), optional: true },
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
        const sources = d.compute.sources || [];
        const sourceRows = sources.map((s) => `<li class="c4-row c4-row-flat"><span class="c4-row-dot${s.status === 'ready' ? ' c4-dot-ok' : ''}" aria-hidden="true"></span><span class="c4-row-label">${esc(s.name)}</span><span class="c4-row-note">${s.status === 'ready' ? 'Ready' : s.status === 'coming_soon' ? 'Coming soon' : 'Unavailable'}${s.price && s.price.amount_usd != null ? ` · $${esc(s.price.amount_usd)}/${esc(s.price.unit)}` : ''}${s.reason ? ` · ${esc(s.reason)}` : ''}</span></li>`).join('');
        const problem = d.machines.ok === false && d.machines.problem ? note(esc(d.machines.problem.detail || 'Your machines could not be read.'), 'bad') : '';
        const how = `<ol class="c4-setup-how">
<li><b>Get a one-time code</b> on <a href="https://openvibe.my/#machines" rel="noopener">openvibe.my</a>. It lasts ten minutes.</li>
<li><b>Run the installer on that computer</b> and give it the code:${command('curl -fsSL https://openvibe.link/install | sh -s -- --worker', 'On the machine')}</li>
<li><b>It pairs itself</b> and shows up here as Online. It runs your work and nobody else's.</li></ol>`;
        return `${problem}${d.compute.ok === false && d.compute.problem ? note(esc(d.compute.problem.detail), 'bad') : ''}<p class="c4-hint">Choose a place for your work. Link checks readiness before a task can start. Rentals need a live price and a spending limit.</p>${sourceRows ? `<ul class="c4-rows">${sourceRows}</ul>` : ''}${how}
<div class="c4-setup-actions"><a class="c4-button${list.length ? ' c4-button-light' : ''}" href="https://openvibe.my/#machines">${list.length ? 'Manage machines' : 'I have a code'}</a><a class="c4-opill" href="/setup#step-machine">Check again</a></div>`;
    }

    // 2026-11-16: an agent signs in from here, on the machine you choose, in your own sandbox there (runner 0.10.0, Link
    // v0.72.0): the agent's own sign-in runs on the machine, its link opens here, and the code it shows goes back from
    // here. The commands stay folded away for a terminal.
    const SIGN_IN_HERE = new Set(['claude-code', 'codex', 'opencode', 'command-code']);
    function signInHere(id, name, st, machines) {
        const live = machines.filter((m) => m.id && m.state !== 'revoked').sort((a, b) => (b.state === 'online') - (a.state === 'online'));
        if (!SIGN_IN_HERE.has(id) || !live.length) return '';
        const chips = live.map((m, i) => `<button type="button" class="c4-signin-machine${i === 0 ? ' is-on' : ''}" data-c4-signin-machine="${esc(m.id)}" aria-pressed="${i === 0 ? 'true' : 'false'}"><span class="c4-signin-dot${m.state === 'online' ? ' is-online' : ''}" aria-hidden="true"></span>${esc(m.name || 'A machine')}</button>`).join('');
        return `<div class="c4-signin" data-c4-signin="${esc(id)}" data-name="${esc(name)}">
<div class="c4-signin-row">${live.length > 1 ? `<div class="c4-signin-machines" role="group" aria-label="Which machine">${chips}</div>` : `<span class="c4-signin-on">On ${esc(live[0].name || 'your machine')}</span><span hidden>${chips}</span>`}
<button type="button" class="c4-button c4-signin-start" data-c4-signin-start>${st === 'absent' ? 'Install and sign in' : 'Sign in'}</button></div>
<div class="c4-signin-live" hidden>
<ol class="c4-signin-steps"><li data-step="start">Starting on your machine</li><li data-step="link">Open the sign-in page</li><li data-step="code">Paste the code it shows</li><li data-step="done">Signed in</li></ol>
<p class="c4-signin-say" aria-live="polite"></p>
<a class="c4-button c4-signin-link" data-c4-signin-link target="_blank" rel="noopener" hidden>Open the sign-in page</a>
<form class="c4-signin-code" data-c4-signin-code hidden><label>The code the page shows<input name="code" autocomplete="one-time-code" spellcheck="false" required></label><button class="c4-button" type="submit">Send</button></form>
</div></div>`;
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
            const here = (st === 'absent' || st === 'login') ? signInHere(id, name, st, (d.machines && d.machines.machines) || []) : '';
            if (here) {
                help = `<div class="c4-setup-agent-help">${here}${how && (how.install || how.signIn) ? `<details class="c4-signin-terminal"><summary>Or in a terminal on the machine</summary>${how.install && st === 'absent' ? command(how.install, '1 · Install') : ''}${how.signIn ? command(how.signIn, `${st === 'absent' ? '2' : '1'} · Sign in`) : ''}</details>` : ''}</div>`;
            } else if (st === 'absent' || st === 'login') {
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

    // 2026-11-17 (plan §AD.22): your agent home. One description of what your agents need on a machine (tools pinned
    // with mise, the agent CLIs, git's name, your repositories), saved here and set up on the machine you pick by a
    // Codes job in your sandbox there: Link does it, nobody logs in. Setting it up again only fetches what is there.
    const HOME_AGENTS = [['claude-code', 'Claude Code'], ['codex', 'Codex'], ['opencode', 'OpenCode'], ['command-code', 'Command Code']];
    function homeBody(d) {
        if (!homes) return '';
        const h = d.home || { spec: { tools: {}, agents: ['claude-code'], repos: [], git: null }, applied: {}, saved: false };
        const s = h.spec || {};
        const live = ((d.machines && d.machines.machines) || []).filter((m) => m.id && m.state !== 'revoked').sort((a, b) => (b.state === 'online') - (a.state === 'online'));
        const tools = Object.entries(s.tools || {}).map(([k, v]) => `${k} ${v}`).join(', ');
        const chosen = new Set(s.agents || []);
        const agents = HOME_AGENTS.map(([id, name]) => `<button type="button" class="c4-signin-machine c4-home-agent${chosen.has(id) ? ' is-on' : ''}" data-c4-home-agent="${esc(id)}" aria-pressed="${chosen.has(id)}">${esc(name)}</button>`).join('');
        const where = Object.values(h.applied || {}).map((a) => {
            const m = live.find((x) => a && x.id === a.machine);
            return `<li><span class="c4-signin-dot is-online" aria-hidden="true"></span>${esc((m && m.name) || (a && a.name) || 'A machine')} <span class="c4-hint">set up ${esc(String((a && a.at) || '').slice(0, 10))}</span></li>`;
        }).join('');
        const chips = live.map((m, i) => `<button type="button" class="c4-signin-machine${i === 0 ? ' is-on' : ''}" data-c4-home-machine="${esc(m.id)}" aria-pressed="${i === 0}"><span class="c4-signin-dot${m.state === 'online' ? ' is-online' : ''}" aria-hidden="true"></span>${esc(m.name || 'Your machine')}</button>`).join('');
        return `<form class="c4-form c4-home" data-c4-home>
<label class="c4-home-wide">Your repositories<textarea name="repos" rows="4" spellcheck="false" autocapitalize="off" placeholder="OpenVibers/OpenVibe.Live&#10;https://git.openvibe.codes/you/site">${esc((s.repos || []).join('\n'))}</textarea><span class="c4-hint">One a line: owner/name for GitHub, or the https address. They are cloned once and fetched after.</span></label>
<div class="c4-form-grid">
<label>Tools<input name="tools" value="${esc(tools)}" spellcheck="false" autocapitalize="off" placeholder="node 24.19.0, go 1.27.1, rust 1.96.0"><span class="c4-hint">Pinned with mise, in your home only.</span></label>
<div class="c4-home-field"><span class="c4-home-label" id="c4-home-agents">Agents</span><div class="c4-signin-machines" role="group" aria-labelledby="c4-home-agents">${agents}</div></div>
<label>Git name<input name="git_name" value="${esc((s.git && s.git.name) || '')}" autocomplete="name"></label>
<label>Git email<input name="git_email" type="email" value="${esc((s.git && s.git.email) || '')}" autocomplete="email"></label>
</div>
${where ? `<ul class="c4-home-where" aria-label="Set up on">${where}</ul>` : ''}
<div class="c4-signin-row">${live.length ? `<div class="c4-signin-machines" role="group" aria-label="Which machine">${chips}</div>` : '<span class="c4-hint">Pair a machine first (step 1); the home is kept until then.</span>'}
<button type="submit" class="c4-button" data-c4-home-go>${live.length ? (where ? 'Save and set up again' : 'Save and set up') : 'Save'}</button></div>
<div class="c4-signin-live c4-home-live" hidden><p class="c4-signin-say" aria-live="polite"></p><ol class="c4-home-log"></ol></div>
</form>`;
    }

    function keysBody(d) {
        const list = (d.keys && d.keys.credentials) || [];
        const rows = list.map((k) => `<li class="c4-row c4-row-flat"><span class="c4-row-dot${k.status === 'ok' ? ' c4-dot-ok' : k.status === 'failing' ? ' c4-dot-bad' : ''}" aria-hidden="true"></span><span class="c4-row-label">${esc(PROVIDER_NAMES[k.provider] || k.provider)}</span><span class="c4-row-note">…${esc(k.hint || '????')}</span>${k.status === 'ok' ? pill('Working', 'ok') : k.status === 'failing' ? pill('Not working', 'bad') : pill('Not tested', 'skip')}</li>`).join('');
        return `<p class="c4-hint">Only for agents and models you pay for by use (DeepSeek, OpenAI, Anthropic, Google and more). An agent signed in with a plan needs no key. Keys live on Your AI, sealed, and every OpenVibe site uses the same ones.</p>
${rows ? `<ul class="c4-rows">${rows}</ul>` : d.keys ? ovkKit.empty({ icon: 'key', title: 'No keys yet', text: 'Keys are optional: add one on Your AI and the agents can use models paid by use.' }) : ovkKit.empty({ icon: 'key', title: 'Your keys could not be read just now', text: 'Try again in a minute, or open Your AI to check them.' })}
<div class="c4-setup-actions"><a class="c4-button${rows ? ' c4-button-light' : ''}" href="${esc(YOUR_AI)}" rel="noopener">${rows ? 'Manage keys' : 'Add a key'} ${ovkKit.icon('open')}</a></div>`;
    }

    function accountsBody(d) {
        if (!forge || !forge.enabled) return '<p class="c4-hint">OpenVibe Git opens here once Codes can reach it. Your tasks can already work on any GitHub or OpenVibe Git repository you can reach.</p>';
        return d.git && d.git.length
            ? `<ul class="c4-rows"><li class="c4-row c4-row-flat"><span class="c4-row-dot c4-dot-ok" aria-hidden="true"></span><span class="c4-row-label">OpenVibe Git</span><span class="c4-row-note">${d.git.length} ${d.git.length === 1 ? 'repository' : 'repositories'} in your name</span>${pill('Ready', 'ok')}</li></ul><div class="c4-setup-actions"><a class="c4-opill" href="/git">Your repositories</a></div>`
            : '<p class="c4-hint">Codes makes repositories on OpenVibe Git in your name with your OpenVibe account, and your tasks push their branches there. Nothing to link.</p><div class="c4-setup-actions"><a class="c4-button c4-button-light" href="/git">Make a repository</a></div>';
    }

    function choicesBody(d, machines, pickedMachine = '') {
        const s = d.settings;
        const ready = readiness(d.rows);
        const offers = (harnesses && harnesses.list ? harnesses.list() : []).filter((a) => a && a.id);
        const agentOption = (id, name, selected) => `<option value="${esc(id)}"${selected ? ' selected' : ''}${optionAttrs(ready.get(id))}>${esc(name)}</option>`;
        const agents = offers.map((a) => agentOption(a.id, a.name || a.id, s.default_agent === a.id)).join('');
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
<div data-ov-machines data-needs="worker" data-name="default_machine" data-auto-label="Auto" data-value="${esc(pickedMachine || s.default_machine || '')}"></div>
</div>
<h3 class="c4-subhead">When your orchestrator's agent runs low</h3>
<p class="c4-hint">Your orchestrator runs Claude Code. When it nears a usage limit, the next turn moves to the first fallback with room, and comes back once the window frees.</p>
<div class="c4-fallbacks">${[0, 1, 2].map(fallbackRow).join('')}</div>
<div class="c4-form-grid"><label>Switch at <select name="conductor_switch_pct">${[70, 80, 85, 90, 95].map((v) => `<option value="${v}"${pct === v ? ' selected' : ''}>${v}% of a window</option>`).join('')}</select></label></div>
<h3 class="c4-subhead">Safety</h3>
<div class="c4-safety" role="group" aria-label="Safety level">${SAFETY_OPTIONS.map(([value, title, desc]) => `<label class="c4-safety-card"><input type="radio" name="safety" value="${esc(value)}"${s.safety === value ? ' checked' : ''}><span><b>${esc(title)}</b><small>${esc(desc)}</small></span></label>`).join('')}</div>
<div class="c4-setup-actions"><button class="c4-button" type="submit">Save my choices</button><a class="c4-opill" href="/settings">All settings</a></div>
</form>`;
    }

    r.get('/setup', async (req, res) => {
        if (!viewer(req)) return page(req, res, 'Set up Codes', wrap(`<div class="c4-title"><div><h1>Set up Codes</h1><p>Your machine, your agents, your home, your keys: six short steps.</p></div></div>${signIn(req)}`));
        const d = await readAll(req, res);
        const steps = stepsOf(d);
        const next = (steps.find((s) => !s.done && s.required) || steps.find((s) => !s.done && !s.optional) || {}).id || null;
        const done = steps.filter((s) => s.done).length;
        const requiredLeft = steps.filter((s) => s.required && !s.done).length;
        const pctDone = Math.round((done / steps.length) * 100);
        const subs = {
            machine: 'Your Link machines, OpenVibe cloud, Exchange rentals and community machines.',
            agents: 'The coding agents on it, signed in with your own plans.',
            home: 'Tools, agents and repositories, set up on your machine by Link.',
            keys: 'Keys for the models you pay for by use.',
            accounts: 'Where your work is pushed.',
            choices: 'What Codes uses when you do not say.',
        };
        const bodies = { machine: machineBody(d), agents: agentsBody(d), home: homeBody(d), keys: keysBody(d), accounts: accountsBody(d), choices: choicesBody(d, d.machines, String(req.query.machine || '')) };
        const nav = steps.map((s, i) => `<li><a class="c4-setup-chip${s.done ? ' is-done' : ''}${s.id === next ? ' is-next' : ''}" href="#step-${s.id}"><span class="c4-setup-chip-n" aria-hidden="true">${s.done ? CHECK : i + 1}</span>${esc(s.short)}<span class="c4-sr-only">${s.done ? ', done' : s.optional ? ', optional' : ''}</span></a></li>`).join('');
        const ready = requiredLeft === 0
            ? `<section class="c4-card c4-setup-ready"><h2>You are set</h2><p>Your machine, an agent and your choices are in place.${steps.some((s) => s.optional && !s.done) ? ' The optional steps can wait.' : ''}</p><div class="c4-setup-actions"><a class="c4-button" href="/">Start a task</a><a class="c4-opill" href="/conductor">Start your orchestrator</a></div></section>`
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
