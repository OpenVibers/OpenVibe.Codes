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
        const modelInput = (role, current) => `<input name="role_${role}_model" list="model-plan-models" value="${esc(current.model || 'auto')}" maxlength="200" required>`;
        const effortInput = (role, current) => `<select name="role_${role}_effort">${EFFORTS.map((value) => `<option value="${value}"${current.effort === value ? ' selected' : ''}>${value}</option>`).join('')}</select>`;
        const roleRow = (role) => {
            const current = chosen.roles.find((item) => item.role === role) || { model: 'auto', effort: 'medium' };
            const enabled = chosen.roles.some((item) => item.role === role);
            return `<fieldset class="c4-card"><legend>${esc(role)}</legend>${role === 'builder' ? '' : `<label><input type="checkbox" name="role_${role}_enabled" value="1"${enabled ? ' checked' : ''}> Use ${esc(role)}</label>`}
<div class="c4-form-grid"><label>Model ${modelInput(role, current)}</label><label>Effort ${effortInput(role, current)}</label>${role === 'planner' ? `<label>Plan samples <input type="number" name="role_planner_samples" min="1" max="5" value="${current.samples || 1}"></label>` : ''}</div>
<div class="c4-form-grid"><label>Token budget <input type="number" name="role_${role}_tokens" min="1" value="${esc(current.budget?.tokens || '')}"></label><label>Minute budget <input type="number" name="role_${role}_minutes" min="0.01" step="any" value="${esc(current.budget?.minutes || '')}"></label><label>Dollar budget <input type="number" name="role_${role}_dollars" min="0.01" step="any" value="${esc(current.budget?.dollars || '')}"></label></div></fieldset>`;
        };
        const content = `${header('Model plan', 'Choose how each coding task is planned, built and checked.')}${flash(req)}${req.viewer.role === 'owner' ? '<p><a href="/admin/model-plans">Weekly outcomes and preset tuning</a></p>' : ''}
<section class="c4-card"><p>Start from a preset and edit any field:</p><p>${Object.keys(presets).map((name) => `<a class="ovk-btn ovk-btn--quiet" href="/settings/model-plan?${new URLSearchParams({ ...(project ? { project } : {}), preset: name })}">${esc(name)}</a>`).join(' ')}</p>
<form class="c4-form" method="post" action="/settings/model-plan"><label>Project id (empty saves your account default) <input name="project" value="${esc(project)}" maxlength="100"></label>
<label>Mode <select name="mode">${['single', 'pair', 'council', 'escalate'].map((mode) => `<option value="${mode}"${chosen.mode === mode ? ' selected' : ''}>${mode}</option>`).join('')}</select></label>
<datalist id="model-plan-models">${options.map((item) => `<option value="${esc(item.id)}" label="${esc(item.name || item.display_name || item.id)}${item.desc ? ` · ${esc(item.desc)}` : ''}"></option>`).join('')}</datalist>
${ROLE_ORDER.map(roleRow).join('')}
<label>Escalation or fallback ladder (one model per line) <textarea name="ladder" rows="3">${esc((chosen.ladder || []).join('\n'))}</textarea></label>
<fieldset><legend>Checks</legend><label><input type="checkbox" name="checks_tests" value="1"${chosen.checks.tests ? ' checked' : ''}> Tests</label> <label><input type="checkbox" name="checks_lint" value="1"${chosen.checks.lint ? ' checked' : ''}> Lint</label> <label><input type="checkbox" name="checks_reviewer" value="1"${chosen.checks.reviewer ? ' checked' : ''}> Reviewer approval</label></fieldset>
<button class="ovk-btn ovk-btn--primary" type="submit">Save model plan</button></form></section>`;
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
