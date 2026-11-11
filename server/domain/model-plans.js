'use strict';

const { PRESETS, validatePlan, resolvePlan } = require('../../engine/model-plan');
const { weeklySummary, tuningSuggestions } = require('../../engine/model-plan-outcomes');

const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const scopeOf = (project) => {
    if (project == null || project === '') return 'account';
    if (typeof project !== 'string' || !PROJECT.test(project)) throw Object.assign(new Error('project must be a project id'), { status: 422, code: 'codes.project_invalid' });
    return `project:${project}`;
};
const copy = (value) => JSON.parse(JSON.stringify(value));

function createModelPlans({ store, aiCatalog, config }) {
    const db = store.db;
    const enabled = () => config.modelPlans?.enabled === true;
    const requireEnabled = () => {
        if (!enabled()) throw Object.assign(new Error('model plans are off for this service'), { status: 409, code: 'codes.model_plans_disabled' });
    };
    async function stored(subject, project = null) {
        const row = await db.maybe('SELECT plan FROM codes_model_plans WHERE subject = $1 AND scope = $2', [subject, scopeOf(project)]);
        return row?.plan || null;
    }
    async function presets() {
        const result = copy(PRESETS);
        const rows = await db.many('SELECT name, plan FROM codes_model_preset_defaults');
        for (const row of rows) if (result[row.name]) {
            try { result[row.name] = validatePlan(row.plan); } catch { /* keep the shipped preset */ }
        }
        return result;
    }
    async function get(subject, project = null) {
        const account = await stored(subject) || (await presets()).Balanced;
        const projectPlan = project ? await stored(subject, project) : null;
        return { account, project: projectPlan, effective: projectPlan || account, source: projectPlan ? 'project' : 'account' };
    }
    async function put(subject, plan, project = null) {
        const checked = validatePlan(plan);
        const catalog = await aiCatalog.read({ force: true });
        const resolved = resolvePlan(checked, catalog);
        await db.exec(`INSERT INTO codes_model_plans (subject, scope, plan, updated_at) VALUES ($1, $2, $3::jsonb, now())
            ON CONFLICT (subject, scope) DO UPDATE SET plan = EXCLUDED.plan, updated_at = now()`, [subject, scopeOf(project), JSON.stringify(checked)]);
        return { plan: checked, resolved: resolved.plan, fallbacks: resolved.fallbacks, prices: resolved.prices };
    }
    async function select(subject, project, { plan = null, preset = null } = {}) {
        requireEnabled();
        if (plan && preset) throw Object.assign(new Error('choose plan or preset'), { status: 422, code: 'codes.model_plan_invalid' });
        const availablePresets = await presets();
        if (preset && !availablePresets[preset]) throw Object.assign(new Error('unknown model plan preset'), { status: 422, code: 'codes.preset_unknown' });
        const saved = await get(subject, project);
        const picked = plan ? validatePlan(plan) : preset ? copy(availablePresets[preset]) : saved.effective;
        const resolved = resolvePlan(picked, await aiCatalog.read({ force: true }));
        return { ...resolved, preset: preset || null, source: plan || preset ? 'task' : saved.source };
    }
    async function outcomes() {
        const rows = await db.many(`SELECT preset, role_runs, result, state FROM run_tasks
            WHERE model_plan IS NOT NULL AND created_at >= $1
            ORDER BY created_at DESC LIMIT 5000`, [store.now() - 7 * 24 * 60 * 60_000]);
        const summary = weeklySummary(rows);
        return { ...summary, suggestions: tuningSuggestions(summary, await presets()) };
    }
    async function tune(ownerSubject) {
        const { suggestions } = await outcomes();
        for (const item of suggestions) await db.exec(`INSERT INTO codes_model_preset_defaults (name, plan, owner_subject, tuned_at)
            VALUES ($1, $2::jsonb, $3, now()) ON CONFLICT (name) DO UPDATE SET plan = EXCLUDED.plan,
            owner_subject = EXCLUDED.owner_subject, tuned_at = now()`, [item.preset, JSON.stringify(item.plan), ownerSubject]);
        return suggestions;
    }
    return { get, put, select, presets, stored, enabled, outcomes, tune };
}

module.exports = { createModelPlans, scopeOf };
