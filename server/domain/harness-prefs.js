'use strict';

/**
 * Each coding agent, set up the way the person wants it (2026-11-18; the owner: "make harness more easily configurable").
 * One entry per harness in codes_user_settings.harness_prefs (migration 0050), set on /settings/agents or through
 * PUT /api/v1/me/settings { harness_prefs: { <id>: {…} | null } }:
 *
 *   code_mode      null (the person's default switch) | 'strict' | 'beside' | 'off'
 *   model          the model this agent starts on when a task names none (≤ 100 characters)
 *   effort         its reasoning level when a task names none (the harness's own levels)
 *   instructions   standing instructions added to every task it takes (≤ 2000 characters)
 *
 * applyPrefs(args, settings) is what a job carries: a task's own choice of model or effort always wins; the instructions
 * follow the brief; code mode is the agent's own choice, else the person's switch. Runner 0.14.1 reads code_mode as
 * true, 'strict' or 'beside'.
 */
const CODE_MODES = ['strict', 'beside', 'off'];
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/;
const EFFORT = /^[a-z][a-z0-9-]{0,15}$/;
const AGENT = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MAX_INSTRUCTIONS = 2000;

/** One agent's preferences, cleaned; null when nothing is set. Throws a 422 for a value that is not one. */
function cleanOne(p) {
    if (p == null) return null;
    if (typeof p !== 'object' || Array.isArray(p)) throw Object.assign(new Error('an agent\'s settings are an object'), { status: 422, code: 'settings.harness_invalid' });
    const out = {};
    const cm = p.code_mode == null || p.code_mode === '' || p.code_mode === 'default' ? null : String(p.code_mode);
    if (cm !== null && !CODE_MODES.includes(cm)) throw Object.assign(new Error('code_mode is strict, beside, off or empty'), { status: 422, code: 'settings.harness_invalid' });
    if (cm) out.code_mode = cm;
    const model = p.model == null ? '' : String(p.model).trim();
    if (model) { if (!MODEL.test(model)) throw Object.assign(new Error('model is a model id (letters, digits, . _ : / @ + -)'), { status: 422, code: 'settings.harness_invalid' }); out.model = model; }
    const effort = p.effort == null ? '' : String(p.effort).trim();
    if (effort) { if (!EFFORT.test(effort)) throw Object.assign(new Error('effort is one of the agent\'s reasoning levels'), { status: 422, code: 'settings.harness_invalid' }); out.effort = effort; }
    const instructions = p.instructions == null ? '' : String(p.instructions).replace(/\r\n/g, '\n').trim();
    if (instructions) { if (instructions.length > MAX_INSTRUCTIONS) throw Object.assign(new Error(`instructions are at most ${MAX_INSTRUCTIONS} characters`), { status: 422, code: 'settings.harness_invalid' }); out.instructions = instructions; }
    return Object.keys(out).length ? out : null;
}

/** A stored map, read leniently (a value that no longer cleans is dropped, never an error on read). */
function present(map) {
    const out = {};
    const src = map && typeof map === 'object' && !Array.isArray(map) ? map : (typeof map === 'string' ? (() => { try { return JSON.parse(map); } catch { return {}; } })() : {});
    for (const [id, p] of Object.entries(src || {})) {
        if (!AGENT.test(id)) continue;
        try { const c = cleanOne(p); if (c) out[id] = c; } catch { /* dropped */ }
    }
    return out;
}

/** A patch over the stored map: each named agent's entry is replaced (null or empty clears it). */
function merge(stored, patch, knownAgent = () => true) {
    if (patch == null) return present(stored);
    if (typeof patch !== 'object' || Array.isArray(patch)) throw Object.assign(new Error('harness_prefs is an object of agent ids'), { status: 422, code: 'settings.harness_invalid' });
    const next = present(stored);
    for (const [id, p] of Object.entries(patch)) {
        if (!AGENT.test(id) || !knownAgent(id)) throw Object.assign(new Error(`${String(id).slice(0, 40)} is not a coding agent here`), { status: 422, code: 'settings.harness_unknown' });
        const c = cleanOne(p);
        if (c) next[id] = c; else delete next[id];
    }
    return next;
}

/** A job's args with the person's settings for its agent: code mode, then model, effort and instructions. */
function applyPrefs(args, settings = {}, { name = null } = {}) {
    const out = { ...args };
    const p = out.agent && settings.harness_prefs ? settings.harness_prefs[out.agent] || null : null;
    const mode = p && p.code_mode ? p.code_mode : (settings.code_mode === true ? 'on' : 'off');
    if (mode === 'off') delete out.code_mode;
    else out.code_mode = mode === 'strict' || mode === 'beside' ? mode : true;
    if (p && p.model && !out.model) out.model = p.model;
    if (p && p.effort && !out.effort) out.effort = p.effort;
    if (p && p.instructions && typeof out.prompt === 'string' && !out.prompt.includes(p.instructions)) {
        out.prompt = `${out.prompt}\n\n---\nStanding instructions for ${name || out.agent} (set by the person on openvibe.codes):\n${p.instructions}`;
    }
    return out;
}

module.exports = { cleanOne, present, merge, applyPrefs, CODE_MODES, MAX_INSTRUCTIONS };
