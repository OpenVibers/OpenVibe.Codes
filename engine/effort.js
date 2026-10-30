'use strict';

/**
 * Reasoning effort and blocked models: the two places where a runner is handed something it will refuse.
 *
 * Effort: every harness accepts a different set of levels. The 2026-10-29 incident: a job retried on another runner
 * copied Codex's "medium" to Command Code, which died before its first step ("Unknown effort \"medium\". Supported: off,
 * low, high, max."). `fitEffort` rounds a wanted level to the nearest one the target harness accepts (a tie goes up), so
 * no caller can hand a runner a level it refuses. The levels are uneven ("off" and "ultra" exist on one harness only),
 * so the ordering must know all of them or a cross-runner value passes through untouched.
 *
 * Blocked models: a provider can refuse a model on one account ("not supported with a ChatGPT account"). The list is
 * per harness; a blocked model is replaced by another one the harness still lists, and a launch with no unblocked model
 * left is an error, never a silent run with a refused model.
 *
 * The keys are the portal's short runner ids, so the portal's own ladders and catalogs keep working. Codes calls the
 * same harnesses by their full names; `harnessOf` maps those onto the short ids.
 */

/** The reasoning levels each harness accepts (empty: the harness has no setting). */
const EFFORTS = {
    cx: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    cc: ['off', 'low', 'high', 'max'],
    mm: ['low', 'medium', 'high', 'xhigh', 'max'],
    cm: ['low', 'medium', 'high', 'xhigh', 'max'],
    pg: ['low', 'medium', 'high', 'max'],
    cd: ['low', 'high', 'max'],
    claude: ['low', 'medium', 'high', 'xhigh', 'max'],
    dsh: ['none', 'low', 'high', 'max'],
    oc: [],
};

/** Codes' harness ids and the portal's short runner ids for the same harness. */
const ALIASES = {
    'claude-code': 'claude',
    codex: 'cx',
    'command-code': 'cc',
    opencode: 'oc',
    deepseek: 'dsh',
    minimax: 'mm',
    grove: 'pg',
};

/** Every level, from the weakest to the strongest. */
const ORDER = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** The short runner id of a harness, whoever named it. */
function harnessOf(id) {
    const key = String(id || '').toLowerCase();
    return ALIASES[key] || key;
}

/**
 * The nearest level the harness accepts for the wanted one (a tie goes up).
 *
 * @param {string} runner the harness
 * @param {string|null} effort the wanted level
 * @returns {string|null} a level the harness accepts, or the wanted one when the harness has no effort setting
 */
function fitEffort(runner, effort) {
    const list = EFFORTS[harnessOf(runner)] || [];
    if (!effort || !list.length || list.includes(effort)) return effort;
    const at = ORDER.indexOf(effort);
    if (at < 0) return effort;
    for (let d = 0; d < ORDER.length; d++) for (const i of [at + d, at - d]) if (list.includes(ORDER[i])) return ORDER[i];
    return effort;
}

/**
 * One reasoning level up, for a retry of a real failure: the same attempt again rarely helps.
 *
 * @param {string|null} effort the level this attempt used
 * @param {string[]|null} list the levels the runner accepts (null: any)
 * @returns {string|null} the next level
 */
function stepUp(effort, list) {
    const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const i = order.indexOf(effort || 'medium');
    for (let j = i + 1; j < order.length; j++) if (!list || list.includes(order[j])) return order[j];
    return effort || null;
}

/** The blocked models of one harness. */
function blockedList(blockedModels, runner) {
    const list = (blockedModels || {})[harnessOf(runner)];
    return Array.isArray(list) ? list : [];
}

/** Is this model refused by the provider on this harness's account? */
function isBlocked(blockedModels, runner, model) {
    if (!model) return false;
    return blockedList(blockedModels, runner).includes(model);
}

/** The catalog of one harness, by either of its names. */
function catalogFor(models, runner) {
    const all = models || {};
    return all[runner] || all[harnessOf(runner)] || [];
}

/**
 * The model a launch may use: the wanted one, unless the provider refused it, then the first the harness still lists.
 *
 * @param {object} what
 * @param {string} what.runner the harness
 * @param {string|null} what.model the wanted model
 * @param {object} what.models the catalogs, per harness
 * @param {object} what.blockedModels the blocked lists, per harness
 * @returns {string|null} the model to launch with
 * @throws {Error} when every model the harness lists is blocked
 */
function pickModel({ runner, model, models, blockedModels } = {}) {
    const blocked = blockedList(blockedModels, runner);
    if (!model || !blocked.includes(model)) return model;
    const replacement = catalogFor(models, runner).find((m) => !blocked.includes(m));
    if (!replacement) throw new Error(`No unblocked model available for ${runner}`);
    return replacement;
}

/** The provider messages that mean "this model is not available to you". */
const REFUSAL_RE = /not supported when using|model_not_found|not available on your plan|model_not_in_plan/i;

/**
 * The blocked list after a refusal: the model is added when the provider said it does not have it, and left alone
 * otherwise (a crash is not a missing model).
 *
 * @param {string[]} list the current blocked list
 * @param {string} model the model that was refused
 * @param {string} error the provider's message
 * @returns {string[]} the new list
 */
function blockModel(list, model, error) {
    if (!model || !REFUSAL_RE.test(String(error || ''))) return Array.isArray(list) ? list : [];
    const current = Array.isArray(list) ? list : [];
    if (current.includes(model)) return current;
    return [...current, model];
}

/** The blocked list without one model. */
function unblockModel(list, model) {
    return (Array.isArray(list) ? list : []).filter((m) => m !== model);
}

module.exports = {
    EFFORTS, ALIASES, ORDER, REFUSAL_RE,
    harnessOf, fitEffort, stepUp,
    blockedList, isBlocked, catalogFor, pickModel, blockModel, unblockModel,
};
