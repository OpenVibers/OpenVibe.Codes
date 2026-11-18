'use strict';

/**
 * Settings → Coding agents (/settings/agents; 2026-11-18, the owner: "make harness more easily configurable"). One fold
 * per agent, grouped (on your computers, ACP agents, API models): code mode, the model and reasoning it starts on, and
 * standing instructions for every task it takes. The same map is in GET/PUT /api/v1/me/settings (harness_prefs), so any
 * OpenVibe site can set an agent up the same way. Each fold says how code mode reaches that agent (harness/code-mode.js
 * PLANS), and what its machines report about it.
 */
const { asyncRouter } = require('./router');
const { esc } = require('../render/html');
const prefsOf = require('../domain/harness-prefs');
const codeMode = require('../../harness/code-mode');

const CLI_IDS = new Set(['claude-code', 'claude-other', 'codex', 'opencode', 'command-code', 'minimax-code', 'muse', 'aider']);
const API_IDS = new Set(['deepseek', 'openvibe-ai', 'openai-compatible']);
const MODE_WORDS = { '': 'Your default', strict: 'Scripts only', beside: 'Scripts beside its own tools', off: 'Off' };
const VIA_WORDS = {
    claude: 'Strict works: its own file and shell tools turn off, and the work goes through scripts.',
    opencode: 'Strict works: its own tools are denied in the project\'s OpenCode config while it runs.',
    codex: 'Beside its own tools: Codex stops working with its shell off, so scripts come in addition.',
    'mcp-json': 'Beside its own tools: the scripts server comes through the project\'s .mcp.json while it runs.',
    acp: 'Beside its own tools: the scripts server comes when the session starts.',
    loop: 'Strict works: the script tool is the only one offered.',
    own: 'Has its own code mode (run_code), always on.',
};

function effortsFor(id) {
    try {
        const engine = require(`../../engine/adapters/${id}`);
        const a = Object.values(engine).find((x) => x && typeof x === 'object' && x.id === id);
        return (a && Array.isArray(a.effortLevels) ? a.effortLevels : []).filter((e) => /^[a-z][a-z0-9-]{0,15}$/.test(e));
    } catch { return []; }
}

function createAgentSettings(ctx, { page, wrap, header, flash, sameOrigin, viewer, form, signIn }) {
    const r = asyncRouter();
    const { userSettings, harnesses, fleet } = ctx;

    r.get('/settings/agents', async (req, res) => {
        if (!viewer(req)) return page(req, res, 'Coding agents', wrap(`${header('Coding agents')}${signIn(req)}`));
        const settings = await userSettings.get(req.viewer.subject);
        const prefs = settings.harness_prefs || {};
        const rows = fleet ? await fleet.agents(req.viewer.subject, harnesses).catch(() => []) : [];
        const state = new Map(rows.map((x) => [x.agent, x]));
        const list = (harnesses && harnesses.list ? harnesses.list() : []).filter((a) => !(harnesses.isOff && harnesses.isOff(a.id)));
        const group = (a) => (CLI_IDS.has(a.id) ? 'cli' : API_IDS.has(a.id) ? 'api' : 'acp');
        const fold = (a) => {
            const p = prefs[a.id] || {};
            const plan = codeMode.planFor(a.id, group(a) === 'cli' ? null : group(a));
            const efforts = effortsFor(a.id);
            const fl = state.get(a.id);
            const seen = fl ? (fl.state === 'ok' ? 'Ready on your computer' : fl.state === 'login' ? 'Installed, not signed in' : fl.state === 'absent' ? 'Not installed on your computer' : fl.state === 'limited' ? 'Its plan window is full' : fl.state === 'low' ? 'Its plan window is nearly full' : '') : '';
            const summary = [p.code_mode ? MODE_WORDS[p.code_mode] : '', p.model ? p.model : '', p.effort ? `${p.effort} reasoning` : '', p.instructions ? 'instructions' : ''].filter(Boolean).join(' · ') || 'Its own defaults';
            const modes = plan.via === 'own' || !plan.via ? ['']
                : plan.strict ? ['', 'strict', 'beside', 'off'] : ['', 'beside', 'off'];
            const cmField = plan.via === 'own' || !plan.via
                ? `<p class="c4-hint">${esc(plan.via === 'own' ? VIA_WORDS.own : plan.note || 'Code mode does not apply to it.')}</p>`
                : `<label>Code mode <select name="p_${esc(a.id)}_code_mode">${modes.map((m) => `<option value="${m}"${(p.code_mode || '') === m ? ' selected' : ''}>${esc(MODE_WORDS[m])}${m === '' ? ` (${settings.code_mode ? 'on' : 'off'})` : ''}</option>`).join('')}</select></label>
<p class="c4-hint">${esc(VIA_WORDS[plan.via] || '')}</p>`;
            return `<details class="mp-role ag-fold" id="agent-${esc(a.id)}"${p && Object.keys(p).length ? ' open' : ''}>
<summary class="mp-role-h"><div><h3>${esc(a.name || a.id)}</h3><p>${esc(summary)}${seen ? ` · ${esc(seen)}` : ''}</p></div></summary>
<div class="mp-fields">${cmField}
<label class="mp-model">Model <input name="p_${esc(a.id)}_model" value="${esc(p.model || '')}" maxlength="100" placeholder="Its own default" autocomplete="off" spellcheck="false"></label>
${efforts.length ? `<label>Reasoning <select name="p_${esc(a.id)}_effort"><option value="">Its own default</option>${efforts.map((e) => `<option value="${esc(e)}"${p.effort === e ? ' selected' : ''}>${esc(e)}</option>`).join('')}</select></label>` : ''}
</div>
<label class="ag-instructions">Standing instructions <small>Added to every task it takes (${prefsOf.MAX_INSTRUCTIONS} characters at most).</small>
<textarea name="p_${esc(a.id)}_instructions" rows="3" maxlength="${prefsOf.MAX_INSTRUCTIONS}" placeholder="For example: run the tests before you finish; keep commits small.">${esc(p.instructions || '')}</textarea></label>
</details>`;
        };
        const section = (title, line, items) => (items.length ? `<h3 class="c4-subhead">${esc(title)}</h3><p class="c4-hint">${esc(line)}</p>${items.map(fold).join('\n')}` : '');
        const all = list;
        const content = `${header('Coding agents', 'How each agent works for you: code mode, the model it starts on, and what it should always remember.')}${flash(req)}
<section class="c4-card"><form method="post" action="/settings/agents" class="ag-form">
<p class="c4-hint">A task that picks its own model or reasoning keeps it. Your default for code mode is the switch on <a href="/settings">Settings</a> (${settings.code_mode ? 'on' : 'off'} now). The same settings are in the API: <code>PUT /api/v1/me/settings</code> with <code>harness_prefs</code>.</p>
${section('On your computers', 'Coding agents your machines run, signed in with your own plans.', all.filter((a) => group(a) === 'cli'))}
${section('Agent Client Protocol agents', 'Agents Codes talks to over ACP, each with your own sign-in on the machine.', all.filter((a) => group(a) === 'acp'))}
${section('API models', 'Codes\' own agent loop over an API: the free AI, DeepSeek, or your own model.', all.filter((a) => group(a) === 'api'))}
<div class="mp-savebar"><button class="c4-button" type="submit">Save agents</button></div>
</form></section>`;
        page(req, res, 'Coding agents', wrap(content));
    });

    r.post('/settings/agents', form, async (req, res) => {
        if (!viewer(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent('/settings/agents')}`);
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        const b = req.body || {};
        const patch = {};
        for (const a of (harnesses && harnesses.list ? harnesses.list() : [])) {
            const k = (f) => `p_${a.id}_${f}`;
            if (![k('code_mode'), k('model'), k('effort'), k('instructions')].some((f) => b[f] !== undefined)) continue;
            patch[a.id] = { code_mode: b[k('code_mode')] || null, model: b[k('model')] || null, effort: b[k('effort')] || null, instructions: b[k('instructions')] || null };
        }
        try {
            await userSettings.save(req.viewer.subject, { harness_prefs: patch });
            return res.redirect(303, '/settings/agents?ok=Agents%20saved');
        } catch (e) {
            return res.redirect(303, `/settings/agents?error=${encodeURIComponent(String((e && e.message) || 'the agents could not be saved').slice(0, 180))}`);
        }
    });
    return r;
}

module.exports = { createAgentSettings, effortsFor };
