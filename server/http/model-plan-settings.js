'use strict';

const { asyncRouter } = require('./router');
const { esc } = require('../render/html');
const { EFFORTS } = require('../../engine/model-plan');

const ROLE_ORDER = ['planner', 'builder', 'reviewer', 'verifier'];

function createModelPlanSettings(ctx, { page, wrap, header, flash, sameOrigin, viewer, form, signIn }) {
    const r = asyncRouter();
    const { modelPlans, aiCatalog } = ctx;
    const url = (project, message, value) => `/settings/model-plan?${new URLSearchParams({ ...(project ? { project } : {}), [message]: String(value).slice(0, 180) })}`;
    const field = (body, name) => String(body[name] || '').trim();

    r.get('/settings/model-plan', async (req, res) => {
        if (!viewer(req)) return page(req, res, 'Model plan', wrap(`${header('Model plan')}${signIn(req)}`));
        const project = String(req.query.project || '').trim();
        let saved;
        try { saved = await modelPlans.get(req.viewer.subject, project || null); }
        catch (error) { return page(req, res, 'Model plan', wrap(`${header('Model plan')}${flash(req)}<p role="alert">${esc(error.message)}</p>`)); }
        const presets = await modelPlans.presets();
        const chosen = presets[req.query.preset] || saved.effective;
        const entries = await aiCatalog.choices({ force: true }).catch(() => []);
        const options = [...new Map([['auto', { id: 'auto', name: 'Auto (AI routes)' }], ...entries.map((item) => [item.id, item])]).values()];
        // The editor (Opus, 2026-11-11; openvibe.design component "model plan"): presets as cards that say what they do,
        // the mode as a switch with one line on what it means, each role a card (on/off, model, reasoning, limits folded
        // with their summary), the checks as switches, and Save in a bar that stays in reach on a phone. Field names are
        // the form's contract with POST below and the API; only the look changed.
        const ROLE_LINE = { planner: 'Reads the task and the code, and writes the plan.', builder: 'Writes the change. Always on.', reviewer: 'Reads the change and asks for fixes.', verifier: 'Runs the result and checks it against the task.' };
        const MODE_LINE = { single: 'One model does the whole task.', pair: 'A builder, and a reviewer who checks the work.', council: 'Several plans are written; the best one is built.', escalate: 'Starts small and moves up the ladder when a check fails.' };
        const cap = (x) => String(x).charAt(0).toUpperCase() + String(x).slice(1);
        const presetLine = (plan) => {
            const roles = (plan.roles || []).map((r) => r.role);
            const top = (plan.roles || []).map((r) => EFFORTS.indexOf(r.effort)).reduce((a, b) => Math.max(a, b), 0);
            return `${cap(plan.mode || 'single')} · ${roles.length ? roles.map(cap).join(', ') : 'Builder'} · ${EFFORTS[top] || 'medium'} reasoning`;
        };
        const same = (a, b) => JSON.stringify({ m: a.mode, r: a.roles, c: a.checks }) === JSON.stringify({ m: b.mode, r: b.roles, c: b.checks });
        const active = req.query.preset && presets[req.query.preset] ? req.query.preset : Object.keys(presets).find((name) => same(presets[name], chosen)) || '';
        const modelInput = (role, current) => `<input name="role_${role}_model" list="model-plan-models" value="${esc(current.model || 'auto')}" maxlength="200" required aria-label="${esc(cap(role))} model">`;
        const effortInput = (role, current) => `<select name="role_${role}_effort" aria-label="${esc(cap(role))} reasoning">${EFFORTS.map((value) => `<option value="${value}"${current.effort === value ? ' selected' : ''}>${value}</option>`).join('')}</select>`;
        const limitsLine = (b = {}) => [b.tokens ? `${Number(b.tokens).toLocaleString('en-US')} tokens` : '', b.minutes ? `${b.minutes} min` : '', b.dollars ? `$${b.dollars}` : ''].filter(Boolean).join(' · ') || 'None set';
        const roleRow = (role) => {
            const current = chosen.roles.find((item) => item.role === role) || { model: 'auto', effort: 'medium' };
            const enabled = role === 'builder' || chosen.roles.some((item) => item.role === role);
            const on = role === 'builder' ? '<span class="mp-always">Always on</span>' : `<label class="mp-switch"><input type="checkbox" name="role_${role}_enabled" value="1"${enabled ? ' checked' : ''}><span aria-hidden="true"></span><span class="mp-sr">Use ${esc(role)}</span></label>`;
            return `<section class="mp-role${enabled ? '' : ' is-off'}" data-role="${esc(role)}"><header class="mp-role-h"><div><h3>${esc(cap(role))}</h3><p>${esc(ROLE_LINE[role] || '')}</p></div>${on}</header>
<div class="mp-fields"><label class="mp-model">Model ${modelInput(role, current)}</label><label>Reasoning ${effortInput(role, current)}</label>${role === 'planner' ? `<label>Plans <input type="number" name="role_planner_samples" min="1" max="5" value="${current.samples || 1}"></label>` : ''}</div>
<details class="mp-limits"${current.budget ? ' open' : ''}><summary>Limits <small>${esc(limitsLine(current.budget))}</small></summary><div class="mp-fields mp-fields--3"><label>Tokens <input type="number" name="role_${role}_tokens" min="1" value="${esc(current.budget?.tokens || '')}" placeholder="No limit"></label><label>Minutes <input type="number" name="role_${role}_minutes" min="0.01" step="any" value="${esc(current.budget?.minutes || '')}" placeholder="No limit"></label><label>Dollars <input type="number" name="role_${role}_dollars" min="0.01" step="any" value="${esc(current.budget?.dollars || '')}" placeholder="No limit"></label></div></details></section>`;
        };
        const check = (name, label, line, on) => `<label class="mp-check"><span class="mp-switch"><input type="checkbox" name="${name}" value="1"${on ? ' checked' : ''}><span aria-hidden="true"></span></span><span><b>${label}</b><small>${line}</small></span></label>`;
        const content = `${header('Model plan', 'Choose how each coding task is planned, built and checked.')}${flash(req)}${req.viewer.role === 'owner' ? '<p class="mp-owner"><a href="/admin/model-plans">Weekly outcomes and preset tuning</a></p>' : ''}
<section class="mp" aria-label="Model plan">
<nav class="mp-presets" aria-label="Presets">${Object.keys(presets).map((name) => `<a class="mp-preset${name === active ? ' is-on' : ''}" href="/settings/model-plan?${new URLSearchParams({ ...(project ? { project } : {}), preset: name })}"${name === active ? ' aria-current="true"' : ''}><b>${esc(name)}</b><small>${esc(presetLine(presets[name]))}</small></a>`).join('')}</nav>
<form class="mp-form" method="post" action="/settings/model-plan">
<div class="mp-top"><label class="mp-scope">Applies to <input name="project" value="${esc(project)}" maxlength="100" placeholder="Your account (every project)"></label></div>
<fieldset class="mp-modes"><legend>Mode</legend><div class="mp-seg">${['single', 'pair', 'council', 'escalate'].map((mode) => `<label><input type="radio" name="mode" value="${mode}"${chosen.mode === mode ? ' checked' : ''}><span>${cap(mode)}</span></label>`).join('')}</div>
<p class="mp-mode-lines">${['single', 'pair', 'council', 'escalate'].map((mode) => `<span data-mode="${mode}">${esc(MODE_LINE[mode])}</span>`).join('')}</p></fieldset>
<datalist id="model-plan-models">${options.map((item) => `<option value="${esc(item.id)}" label="${esc(item.name || item.display_name || item.id)}${item.desc ? ` · ${esc(item.desc)}` : ''}"></option>`).join('')}</datalist>
<div class="mp-roles">${ROLE_ORDER.map(roleRow).join('')}</div>
<label class="mp-ladder">When a check fails, try next <small>One model per line, for Escalate</small><textarea name="ladder" rows="3" placeholder="e.g. a stronger model, then the strongest">${esc((chosen.ladder || []).join('\n'))}</textarea></label>
<fieldset class="mp-checks"><legend>Before it is done</legend>${check('checks_tests', 'Tests', 'The project’s tests pass.', chosen.checks.tests)}${check('checks_lint', 'Lint', 'The linter has nothing to say.', chosen.checks.lint)}${check('checks_reviewer', 'Reviewer approval', 'The reviewer signs off.', chosen.checks.reviewer)}</fieldset>
<div class="mp-save"><span>${active ? `Starting from <b>${esc(active)}</b>` : 'Your own plan'}</span><button class="ovk-btn ovk-btn--primary" type="submit">Save model plan</button></div></form></section>`;
        return page(req, res, 'Model plan', wrap(content));
    });

    r.post('/settings/model-plan', form, async (req, res) => {
        if (!viewer(req)) return res.redirect(303, '/auth/login?next=%2Fsettings%2Fmodel-plan');
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        const body = req.body || {};
        const project = field(body, 'project');
        try {
            const roles = ROLE_ORDER.filter((role) => role === 'builder' || field(body, `role_${role}_enabled`) === '1').map((role) => {
                const item = { role, model: field(body, `role_${role}_model`) || 'auto', effort: field(body, `role_${role}_effort`) || 'medium' };
                if (role === 'planner') item.samples = Number(field(body, 'role_planner_samples') || 1);
                const budget = {};
                for (const key of ['tokens', 'minutes', 'dollars']) {
                    const value = field(body, `role_${role}_${key}`);
                    if (value) budget[key] = Number(value);
                }
                if (Object.keys(budget).length) item.budget = budget;
                return item;
            });
            const ladder = field(body, 'ladder').split(/[\n,]+/).map((line) => line.trim()).filter(Boolean);
            const plan = { mode: field(body, 'mode'), roles, ...(ladder.length ? { ladder } : {}), checks: { tests: field(body, 'checks_tests') === '1', lint: field(body, 'checks_lint') === '1', reviewer: field(body, 'checks_reviewer') === '1' } };
            await modelPlans.put(req.viewer.subject, plan, project || null);
            return res.redirect(303, url(project, 'ok', 'Model plan saved'));
        } catch (error) { return res.redirect(303, url(project, 'error', error.message || 'The model plan could not be saved')); }
    });
    return r;
}

module.exports = { createModelPlanSettings };
