'use strict';

/** A model plan is portable between the API, repository config and the on-machine job. */
const ROLES = new Set(['planner', 'builder', 'reviewer', 'verifier']);
const MODES = new Set(['single', 'pair', 'council', 'escalate']);
const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const MODEL = /^(?:auto|[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199})$/;
const PRESETS = Object.freeze({
    Fast: { mode: 'single', roles: [{ role: 'builder', model: 'auto', effort: 'low' }], checks: { tests: true } },
    Balanced: { mode: 'pair', roles: [{ role: 'builder', model: 'auto', effort: 'medium' }, { role: 'reviewer', model: 'auto', effort: 'medium' }], checks: { tests: true, reviewer: true } },
    Deep: { mode: 'pair', roles: [{ role: 'planner', model: 'auto', effort: 'high', samples: 3 }, { role: 'builder', model: 'auto', effort: 'high' }, { role: 'reviewer', model: 'auto', effort: 'high' }, { role: 'verifier', model: 'auto', effort: 'high' }], checks: { tests: true, lint: true, reviewer: true } },
    Council: { mode: 'council', roles: [{ role: 'planner', model: 'auto', effort: 'high', samples: 3 }, { role: 'builder', model: 'auto', effort: 'high' }, { role: 'reviewer', model: 'auto', effort: 'high' }, { role: 'verifier', model: 'auto', effort: 'medium' }], checks: { tests: true, lint: true, reviewer: true } },
});
const copy = (value) => JSON.parse(JSON.stringify(value));
const invalid = (detail) => Object.assign(new Error(detail), { status: 422, code: 'codes.model_plan_invalid' });

function validatePlan(plan) {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw invalid('plan must be an object');
    if (Object.keys(plan).some((key) => !['mode', 'roles', 'ladder', 'checks'].includes(key))) throw invalid('plan has an unknown field');
    if (!MODES.has(plan.mode)) throw invalid('plan.mode must be single, pair, council or escalate');
    if (!Array.isArray(plan.roles) || plan.roles.length < 1 || plan.roles.length > 8) throw invalid('plan.roles needs 1 to 8 entries');
    for (const [index, role] of plan.roles.entries()) {
        if (!role || typeof role !== 'object' || Array.isArray(role) || Object.keys(role).some((key) => !['role', 'model', 'effort', 'samples', 'budget'].includes(key))) throw invalid(`plan.roles[${index}] has an unknown field`);
        if (!ROLES.has(role.role)) throw invalid(`plan.roles[${index}].role is unknown`);
        if (typeof role.model !== 'string' || !MODEL.test(role.model)) throw invalid(`plan.roles[${index}].model must be auto or an AI registry id`);
        if (!EFFORTS.includes(role.effort)) throw invalid(`plan.roles[${index}].effort is unknown`);
        if (role.samples !== undefined && (!Number.isInteger(role.samples) || role.samples < 1 || role.samples > 5)) throw invalid(`plan.roles[${index}].samples must be 1 to 5`);
        if (role.budget !== undefined) {
            const b = role.budget;
            if (!b || typeof b !== 'object' || Array.isArray(b) || !Object.keys(b).length || Object.keys(b).some((key) => !['tokens', 'minutes', 'dollars'].includes(key))) throw invalid(`plan.roles[${index}].budget is invalid`);
            if (b.tokens !== undefined && (!Number.isInteger(b.tokens) || b.tokens < 1 || b.tokens > 100000000)) throw invalid(`plan.roles[${index}].budget.tokens is invalid`);
            if (b.minutes !== undefined && (typeof b.minutes !== 'number' || b.minutes <= 0 || b.minutes > 1440)) throw invalid(`plan.roles[${index}].budget.minutes is invalid`);
            if (b.dollars !== undefined && (typeof b.dollars !== 'number' || b.dollars <= 0 || b.dollars > 10000)) throw invalid(`plan.roles[${index}].budget.dollars is invalid`);
        }
    }
    if (!plan.roles.some((r) => r.role === 'builder')) throw invalid('plan.roles needs a builder');
    if (plan.mode === 'pair' && (!plan.roles.some((r) => r.role === 'reviewer') || plan.checks?.reviewer !== true)) throw invalid('pair needs a reviewer that must approve');
    if (plan.mode === 'council' && !plan.roles.some((r) => r.role === 'planner' && r.samples >= 2 && r.samples <= 3)) throw invalid('council needs 2 or 3 planner samples');
    if (plan.ladder !== undefined && (!Array.isArray(plan.ladder) || !plan.ladder.length || plan.ladder.length > 8 || new Set(plan.ladder).size !== plan.ladder.length || plan.ladder.some((m) => typeof m !== 'string' || !MODEL.test(m)))) throw invalid('plan.ladder needs distinct AI registry ids');
    if (plan.mode === 'escalate' && (!plan.ladder || plan.ladder.length < 2)) throw invalid('escalate needs a ladder of at least two models');
    if (!plan.checks || typeof plan.checks !== 'object' || Array.isArray(plan.checks) || !Object.keys(plan.checks).length || Object.keys(plan.checks).some((key) => !['tests', 'lint', 'reviewer'].includes(key) || typeof plan.checks[key] !== 'boolean')) throw invalid('plan.checks needs tests, lint or reviewer booleans');
    return copy(plan);
}

/** Nearest accepted effort, with an upward tie. Models without a published list keep the requested level. */
function fitEffort(wanted, accepted) {
    if (!Array.isArray(accepted) || !accepted.length || accepted.includes(wanted)) return wanted;
    const at = EFFORTS.indexOf(wanted);
    for (let distance = 1; distance < EFFORTS.length; distance++) {
        for (const index of [at + distance, at - distance]) if (accepted.includes(EFFORTS[index])) return EFFORTS[index];
    }
    throw invalid(`model accepts none of the plan's effort levels`);
}

/** AI's catalog is the authority for saved ids, availability and price. */
function resolvePlan(value, catalog) {
    const plan = validatePlan(value);
    if (!catalog || !Array.isArray(catalog.entries)) throw Object.assign(new Error('AI model registry is unavailable; retry when it answers'), { status: 503, code: 'codes.model_registry_unavailable' });
    const entries = new Map(catalog.entries.map((entry) => [entry.id, entry]));
    const usable = (id) => id === 'auto' || (entries.has(id) && !['bad', 'off'].includes(entries.get(id).state));
    const ladder = plan.ladder || [];
    const fallbacks = [];
    for (const role of plan.roles) {
        const requested = role.model;
        if (!usable(role.model)) {
            const replacement = ladder.find(usable);
            if (!replacement) throw invalid(`${role.role} model ${requested} is unavailable and the ladder has no available replacement`);
            role.model = replacement;
            fallbacks.push({ role: role.role, requested, model: replacement, reason: 'unavailable in AI registry' });
        }
        role.effort = fitEffort(role.effort, entries.get(role.model)?.efforts);
    }
    return { plan, fallbacks, prices: plan.roles.map((role) => ({ role: role.role, model: role.model, output_nano_usd_per_m: entries.get(role.model)?.output_nano_usd_per_m || null })) };
}

function decision(response) {
    const text = String(response?.text || '');
    try {
        const value = JSON.parse(text);
        return { approved: value.approved === true, confidence: Number(value.confidence), reason: String(value.reason || value.findings || '').slice(0, 1000), text };
    } catch {
        return { approved: /^APPROVED\b/i.test(text.trim()), confidence: Number(response?.confidence), reason: text.slice(0, 1000), text };
    }
}

/** The stub-friendly role engine. invoke is always the OpenVibe.AI path in the job adapter. */
async function executePlan(value, { task, invoke, check, diff, onStep = () => {} }) {
    const plan = validatePlan(value);
    const role = (name) => plan.roles.find((item) => item.role === name) || plan.roles.find((item) => item.role === 'builder');
    const runs = [];
    const reasons = [];
    let answer = '';
    let previousPlan = '';
    let lastCheck = null;
    const call = async (item, phase, prompt, model = item.model) => {
        if (plan.mode === 'single') model = role('builder').model;
        const started = Date.now();
        onStep({ type: 'start', role: item.role, phase, model });
        let response;
        try { response = await invoke({ role: item.role, phase, model, effort: item.effort, budget: item.budget || null, prompt }); }
        catch (error) { response = { ok: false, refused: /refus|unavailable|not.found/i.test(String(error.message || error)), text: String(error.message || error) }; }
        const usage = response?.usage || {};
        const tokens = Math.max(0, Number(response?.tokens ?? usage.total_tokens ?? (Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0))) || 0);
        const cost = Math.max(0, Number(response?.cost_usd ?? response?.total_cost_usd) || 0);
        const duration = Math.max(0, Number(response?.duration_ms) || Date.now() - started);
        const budget = item.budget || {};
        const over = (budget.tokens && tokens > budget.tokens) || (budget.minutes && duration > budget.minutes * 60000) || (budget.dollars && cost > budget.dollars);
        let outcome = over ? 'failed' : response?.refused ? 'refused' : response?.ok === false ? 'failed' : 'passed';
        if (outcome === 'passed' && phase === 'review') outcome = decision(response).approved ? 'approved' : 'rejected';
        if (outcome === 'passed' && phase === 'verify') outcome = /^FAIL\b/i.test(String(response?.text || '').trim()) ? 'rejected' : 'approved';
        const run = { role: item.role, phase, model: String(response?.resolved_model || model), effort: item.effort, outcome, tokens: Math.round(tokens), cost_usd: cost, duration_ms: Math.round(duration), ...(over ? { reason: 'role budget exceeded' } : {}) };
        runs.push(run);
        onStep({ type: 'end', ...run });
        return { ...response, ok: outcome === 'passed' || outcome === 'approved', run };
    };
    const planner = plan.roles.find((item) => item.role === 'planner');
    if (planner) {
        const samples = [];
        for (let index = 0; index < (planner.samples || 1); index++) {
            const sampled = await call(planner, 'propose', `Propose a concise implementation plan for this task. Sample ${index + 1}.\nTask: ${task}`);
            if (sampled.ok) samples.push(String(sampled.text || ''));
        }
        if (!samples.length) return { ok: false, reason: 'no planner proposal succeeded', role_runs: runs, reasons };
        if (samples.length > 1) {
            const judge = await call(role('reviewer'), 'judge', `Pick or merge these plans with reasons:\n${samples.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
            previousPlan = judge.ok ? String(judge.text || samples[0]) : samples[0];
        } else previousPlan = samples[0];
    }
    const ladder = plan.mode === 'escalate' ? plan.ladder : [role('builder').model];
    for (let rung = 0; rung < ladder.length; rung++) {
        const builder = role('builder');
        const model = ladder[rung];
        const built = await call(builder, 'build', `Task: ${task}\n${previousPlan ? `Plan: ${previousPlan}\n` : ''}${rung ? `Escalation reason: ${reasons.at(-1)}\n` : ''}Implement the task and report what changed.`, model);
        answer = String(built.text || '');
        if (!built.ok) {
            reasons.push(built.run.outcome === 'refused' ? 'model refusal' : 'builder failed');
            if (rung + 1 < ladder.length) continue;
            return { ok: false, reason: reasons.at(-1), role_runs: runs, reasons };
        }
        const changed = await diff();
        if (!changed) return { ok: false, reason: 'diff could not be read', role_runs: runs, reasons };
        // A check before review gives the reviewer evidence. The verifier repeats it independently before success.
        for (const kind of ['tests', 'lint']) if (plan.checks[kind]) {
            lastCheck = await check(kind);
            onStep({ type: 'check', role: 'verifier', kind, ...lastCheck });
            if (lastCheck.ok === false) break;
        }
        if (lastCheck?.ok === false) {
            reasons.push(`${lastCheck.kind || 'check'} failed`);
            if (rung + 1 < ladder.length) continue;
            return { ok: false, reason: reasons.at(-1), role_runs: runs, reasons };
        }
        const needsReview = plan.mode === 'pair' || plan.mode === 'council' || plan.checks.reviewer === true;
        if (needsReview) {
            let review = await call(role('reviewer'), 'review', `Review this task's diff and checks. Return JSON {"approved":true|false,"confidence":0..1,"reason":"..."}.\nDiff:\n${String(changed).slice(0, 40000)}`);
            let verdict = decision(review);
            review.run.outcome = review.ok && verdict.approved ? 'approved' : 'rejected';
            if (!review.ok || !verdict.approved) {
                const fixed = await call(builder, 'repair', `Address these review findings once: ${verdict.reason}. Read the diff and fix the issue.`, model);
                if (!fixed.ok) return { ok: false, reason: 'builder could not address review', role_runs: runs, reasons };
                for (const kind of ['tests', 'lint']) if (plan.checks[kind]) {
                    lastCheck = await check(kind);
                    if (lastCheck.ok === false) return { ok: false, reason: `${kind} failed after review`, role_runs: runs, reasons };
                }
                review = await call(role('reviewer'), 'review', `Review the revised diff. Return JSON approval and reason.\n${String(await diff()).slice(0, 40000)}`);
                verdict = decision(review);
                review.run.outcome = review.ok && verdict.approved ? 'approved' : 'rejected';
                if (!review.ok || !verdict.approved) return { ok: false, reason: 'reviewer rejected the repair', role_runs: runs, reasons };
            }
            if (Number.isFinite(verdict.confidence) && verdict.confidence < 0.5) {
                reasons.push('low confidence');
                if (rung + 1 < ladder.length) continue;
                return { ok: false, reason: 'low confidence', role_runs: runs, reasons };
            }
        }
        const verifier = { ...role('verifier'), role: 'verifier' };
        const finalDiff = await diff();
        for (const kind of ['tests', 'lint']) if (plan.checks[kind]) {
            lastCheck = await check(kind);
            onStep({ type: 'check', role: 'verifier', kind, ...lastCheck });
            if (lastCheck.ok === false) {
                reasons.push(`${kind} failed on verification`);
                break;
            }
        }
        if (lastCheck?.ok === false) {
            if (rung + 1 < ladder.length) continue;
            return { ok: false, reason: reasons.at(-1), role_runs: runs, reasons };
        }
        const verified = await call(verifier, 'verify', `Read this final diff and the check results. Say PASS or FAIL with a reason.\n${String(finalDiff).slice(0, 40000)}`);
        if (!verified.ok || /^FAIL\b/i.test(String(verified.text || '').trim())) {
            reasons.push('verifier rejected');
            if (rung + 1 < ladder.length) continue;
            return { ok: false, reason: reasons.at(-1), role_runs: runs, reasons };
        }
        verified.run.outcome = 'approved';
        return { ok: true, summary: answer, role_runs: runs, reasons };
    }
    return { ok: false, reason: reasons.at(-1) || 'plan exhausted', role_runs: runs, reasons };
}

module.exports = { PRESETS, EFFORTS, validatePlan, fitEffort, resolvePlan, executePlan };
