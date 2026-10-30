'use strict';

/**
 * The tier router: what kind of job is this, and which runner may take it.
 *
 * A brief is classified into one of five tiers — basic, research, standard, hard, design — and each tier has its own
 * ladder, cheapest suitable first: free models for basic chores, flat-price plans for everyday code, the strongest
 * models only for hard problems and design. A brief can force its tier with a line "tier: basic|research|standard|hard|
 * design".
 *
 * Only runners that are on, healthy and have a free slot are chosen, and a runner whose recent jobs mostly failed for
 * real is skipped until it does better (the record comes from the caller's run list, never from a file here). Pay-per-
 * token DeepSeek comes after the plans that are already paid for.
 *
 * The ladder below is the portal's, so the portal's jobs keep their routing. Codes supplies its own ladder (its
 * harness ids differ) through `pick(prompt, { ladder })`.
 */

const fs = require('fs');
const path = require('path');
const { fitEffort, stepUp, EFFORTS } = require('./effort');

const LADDER = {
    // Chores: renames, docs, formatting, counting, simple checks — free and plan Flash models first.
    basic: [['oc', 'opencode-go/beam-free', null], ['cc', 'reflection/beam:free', 'low'], ['pg', 'deepseek-v4.1-flash-1017', 'low'], ['mm', null, 'low'], ['cx', 'gpt-6-luna', 'low'], ['dsh', 'deepseek-flash', 'none']],
    // Reading, comparing, web research, audits: models with search, middle reasoning.
    research: [['cx', 'gpt-6-sol', 'medium'], ['mm', null, 'medium'], ['dsh', 'deepseek-flash', 'high'], ['cc', 'deepseek/deepseek-v4.1-flash', 'high'], ['oc', 'opencode-go/kimi-k3', null]],
    // Everyday features and fixes: flat-price plans first.
    standard: [['mm', null, 'high'], ['cx', 'gpt-6-sol', 'medium'], ['cc', 'deepseek/deepseek-v4.1-flash', 'high'], ['oc', 'opencode-go/kimi-k2.7-code', null], ['dsh', 'deepseek-flash', 'high']],
    // Root causes, architecture, security, migrations: the strongest models.
    // DeepSeek V4 Pro only as the very last resort (owner, 10-29: it costs a lot more and rarely earns it).
    hard: [['cx', 'gpt-6-astra', 'high'], ['mm', null, 'max'], ['cc', 'deepseek/deepseek-v4.1-flash', 'high'], ['oc', 'opencode-go/kimi-k3.1-pro', null], ['dsh', 'deepseek-flash', 'max'], ['dsh', 'deepseek-v4-pro', 'max']],
    // Layout, styling, UI: strong models with taste (Opus reviews later through OPUS-REVIEW-QUEUE.md).
    // Astra only in the hard tier (owner, 10-29: "does it really need Astra for this?").
    design: [['cx', 'gpt-6-sol', 'high'], ['mm', null, 'high'], ['cc', 'deepseek/deepseek-v4.1-flash', 'high'], ['dsh', 'deepseek-flash', 'high']],
};

/** The tiers a brief can fall into. */
const TIERS = ['basic', 'research', 'standard', 'hard', 'design'];

/**
 * How full a plan's window may be and still take a new job: 95%, not 100%. A task started with 4% of a week left would
 * run out of it mid-way, and the portal's own "low" state treats a near-full window as spent (today Command Code is at
 * 96% of its week and must not be chosen).
 */
const FULL_PCT = 95;

/**
 * A limit window is full when it has no room left, or when its reset is still ahead and it is at FULL_PCT or more.
 * `used`/`limit` and `pct` are the two shapes providers report; `resets_at` may be an ISO string or epoch ms.
 *
 * @param {object} w a window: { name, used, limit, pct, resets_at }
 * @param {number} [now] the clock
 * @returns {boolean} may a new job be started in this window?
 */
function windowFull(w, now = Date.now()) {
    if (!w || typeof w !== 'object') return false;
    const resets = w.resets_at == null || w.resets_at === '' ? null : Date.parse(String(w.resets_at));
    if (Number.isFinite(resets) && resets > 0 && resets <= now) return false;   // it has freed since it was read
    let pct = Number(w.pct);
    if (!Number.isFinite(pct)) {
        const used = Number(w.used); const limit = Number(w.limit);
        pct = Number.isFinite(used) && Number.isFinite(limit) && limit > 0 ? (used / limit) * 100 : NaN;
    }
    return Number.isFinite(pct) && pct >= FULL_PCT;
}

/**
 * The lowest balance a pay-per-token agent may take a job on: $1. DeepSeek reads its balance the way the portal reads
 * it (engine/balance.js), and a balance under a dollar would not pay for the job: the agent would stop mid-way and the
 * task would need a person.
 */
const MIN_BALANCE_USD = 1;

/**
 * Whether a runner's balance is too low to take a job. A balance nobody read is unknown, not empty: the agent stays
 * in the ladder (the ladder worked for years without one).
 *
 * @param {object} [fleet] the fleet per runner: { [runner]: { signed_in, windows, balance_usd } }
 * @param {string} runner the runner's id
 * @param {number} [min] the lowest balance that may take a job
 * @returns {boolean} is the balance spent?
 */
function balanceLow(fleet, runner, min = MIN_BALANCE_USD) {
    const f = fleet && fleet[runner];
    if (!f) return false;
    if (f.balance_usd == null || f.balance_usd === '') return false;   // unknown, not empty
    const usd = Number(f.balance_usd);
    if (!Number.isFinite(usd)) return false;
    return usd < min;
}

/**
 * Whether a runner has room, from the fleet the person's machines reported. An agent the fleet does not name is
 * unknown, not full: the ladder keeps working before any machine has reported (and for the API-key agents, which have no
 * plan window at all).
 *
 * @param {object} [fleet] the fleet per runner: { [runner]: { signed_in, windows, balance_usd } }
 * @param {string} runner the runner's id
 * @param {number} [now] the clock
 * @returns {boolean} may this runner take a job now
 */
function roomFor(fleet, runner, now = Date.now()) {
    const f = fleet && fleet[runner];
    if (!f) return true;
    if (f.signed_in === false) return false;
    if (balanceLow(fleet, runner)) return false;
    const windows = Array.isArray(f.windows) ? f.windows : [];
    return !windows.some((w) => windowFull(w, now));
}

// The brief a launch prompt points at: "read /…/agents/jobs/x.brief.md and follow it" is a pointer, not a task, so
// the job is judged by the brief it names (2026-10-29: a pin job was routed as "a short question" to a free model
// because its prompt was one sentence long). The job's own brief counts too (jobs/<name>.brief.md, jobs/<name>.task.md).
const BRIEF_RE = /(?:^|[\s'"`(])([^\s'"`)]*\/jobs\/[\w.-]+\.(?:md|txt))/g;

/**
 * The brief a prompt names, read from the jobs folder.
 *
 * @param {string} prompt the launch prompt
 * @param {string} JOBS the jobs folder
 * @param {string} [name] the job's own name
 * @returns {{text: string, file: string}|null} the brief, or null when there is none
 */
function briefFor(prompt, JOBS, name) {
    const text = String(prompt || '');
    const cands = [];
    for (const m of text.matchAll(BRIEF_RE)) {
        const raw = m[1];
        cands.push(path.isAbsolute(raw) ? raw : path.join(JOBS, path.basename(raw)));
    }
    if (name) cands.push(path.join(JOBS, `${name}.brief.md`), path.join(JOBS, `${name}.task.md`));
    for (const p of cands) {
        if (!p) continue;
        let t = null;
        try { t = fs.readFileSync(p, 'utf8'); } catch { continue; }
        if (!t || !t.trim() || t.trim() === text.trim()) continue;   // the prompt itself is no brief
        return { text: t, file: p };
    }
    return null;
}

/** The tier a line forces, if it forces one. */
function forcedTier(text) {
    const m = String(text || '').match(/^\s*tier:\s*(basic|research|standard|hard|design)\b/im);
    return m ? m[1].toLowerCase() : null;
}

/**
 * The tier of a brief, from the brief itself.
 *
 * @param {string} text the brief (or the prompt)
 * @param {object} [opts]
 * @param {string} [opts.brief] the file the brief came from
 * @param {boolean} [opts.whole] also look for the tier line past the first 4000 characters (a brief may be long)
 * @returns {{tier: string, why: string, brief?: string}} the tier and the words that say so
 */
function classifyText(text, opts = {}) {
    const p = String(text || ''), head = p.slice(0, 4000);
    const said = opts.brief ? { brief: opts.brief } : {};
    const forced = forcedTier(head) || (opts.whole ? forcedTier(p) : null);
    if (forced) return { tier: forced, why: 'the brief says so', ...said };
    if (/\b(race condition|root cause|architecture|security (review|fix|hole)|migration|data loss|deadlock|concurrency bug|memory leak|performance regression|hard bug)\b/i.test(head)) return { tier: 'hard', why: 'a hard problem', ...said };
    if (/\b(design pass|redesign|layout|styling|visual|polish the|ui\b|ux\b|css|look and feel|screenshots? at 390)\b/i.test(head)) return { tier: 'design', why: 'design work', ...said };
    if (/\b(research|investigate|survey|compare|audit|competitor|do not edit any repository|report only|read-only)\b/i.test(head)) return { tier: 'research', why: 'research or audit', ...said };
    // A chore only when it reads like one and asks for nothing to be built (a short brief can still be a real feature).
    const builds = /\b(add|build|implement|create|endpoint|api|feature|refactor|migrat|tests?|component|page|service|integrat)\b/i.test(head);
    if (p.length < 1500 && !builds && /\b(rename|typo|reformat|format|bump|changelog|readme|docs? (update|fix)|add (a )?comment|count|list (all|the)|summari[sz]e|translate|check (that|whether|if)|lint|spell)\b/i.test(head)) return { tier: 'basic', why: 'a small chore', ...said };
    if (p.length < 200 && !builds) return { tier: 'basic', why: 'a short question', ...said };
    return { tier: 'standard', why: 'everyday code', ...said };
}

/**
 * The tier of a job: from the brief its prompt names, or from the prompt itself.
 *
 * @param {string} prompt the launch prompt
 * @param {object} [opts]
 * @param {string} [opts.JOBS] the jobs folder, where briefs live
 * @param {string} [opts.name] the job's own name
 * @param {string} [opts.briefText] the brief's text, when the caller already has it
 * @returns {{tier: string, why: string, brief?: string}} the tier and the words that say so
 */
function classify(prompt, opts = {}) {
    const brief = opts.briefText ? { text: opts.briefText, file: opts.briefFile || null }
        : (opts.JOBS ? briefFor(prompt, opts.JOBS, opts.name) : null);
    if (!brief) return classifyText(String(prompt || ''));
    // The tier line of the brief wins wherever it stands in it.
    return classifyText(brief.text, { brief: brief.file || undefined, whole: true });
}

/**
 * The record of what each runner really achieved: a runner whose recent jobs (7 days, at least 4) mostly failed for
 * real (not limits or sign-in, which the runner switch handles) is skipped until it does better.
 *
 * @param {object[]} runs the runs, newest first
 * @returns {object} per runner: { done, failed }
 */
function track(runs) {
    const since = Date.now() - 7 * 86400e3, rec = {};
    for (const r of runs || []) {
        if (r.session || r.runner === 'ship' || r.updated < since || !['done', 'failed', 'interrupted'].includes(r.status)) continue;
        if (r.status !== 'done' && ['limit', 'auth', 'capacity', 'refused'].includes(r.reason)) continue;
        const t = rec[r.runner] || (rec[r.runner] = { done: 0, failed: 0 });
        // Resolution belongs to the job chain, not this runner's attempt. A rescue
        // by another run (or an owner note) must not turn its failure into success.
        if (r.status === 'done') t.done++; else t.failed++;
    }
    return rec;
}

/**
 * Whether the person may run this runner (Codes C3): a runner whose connection is missing is never picked, so a
 * task never goes to an agent the person cannot pay for or sign in to.
 *
 * `connections` is { [runner]: { provider, connected } } — what the person has: an API key for the provider, or a
 * plan on one of their machines (the same thing the router skips while it is at its limit). A runner that is not in
 * the map needs no connection, and a map that is absent at all leaves the ladder as it was (the portal's router).
 *
 * @param {string} runner the runner's id
 * @param {object} [connections] the person's connections, per runner
 * @returns {boolean} may this runner take the job
 */
function connected(runner, connections) {
    if (!connections) return true;
    const c = connections[runner];
    if (!c) return true;
    return c.connected !== false;
}

/**
 * The runner, model and reasoning for a job, or null when nothing on the ladder can take it now.
 *
 * @param {string} prompt the brief or the launch prompt
 * @param {object} ctx
 * @param {object} ctx.cfg the config (subagents: per runner { enabled, max, model })
 * @param {object} ctx.health the health of each runner ({ state })
 * @param {object} ctx.counts how many jobs each runner runs now
 * @param {object} ctx.models the catalogs of each runner
 * @param {object[]} [ctx.runs] the recent runs, for the reliability gate
 * @param {string} [ctx.JOBS] the jobs folder
 * @param {string} [ctx.name] the job's own name
 * @param {object} [ctx.ladder] the ladder to use (the portal's by default)
 * @param {object} [ctx.connections] the person's connections, per runner (Codes C3)
 * @param {object} [ctx.fleet] the fleet per runner: { [runner]: { signed_in, windows } } (Codes C9c)
 * @returns {{runner: string, model: string|null, effort: string|null, tier: string, brief: string|null, why: string}|null}
 */
function pick(prompt, { cfg, health, counts, models, runs, JOBS, name, ladder, connections, fleet } = {}) {
    const c = classify(prompt, { JOBS, name });
    const rec = track(runs);
    const reliable = (r) => { const t = rec[r]; return !t || t.done + t.failed < 4 || t.done / (t.done + t.failed) >= 0.4; };
    const usable = (r) => cfg.subagents[r] && cfg.subagents[r].enabled && (counts[r] || 0) < cfg.subagents[r].max && health[r] && health[r].state === 'ok' && reliable(r) && connected(r, connections) && roomFor(fleet, r);
    for (const [runner, model, wanted] of (ladder || LADDER)[c.tier]) {
        if (!usable(runner)) continue;
        // A model the runner no longer lists is skipped for that runner's default (lists refresh from each provider).
        const m = model && models[runner] && !models[runner].includes(model) ? null : model;
        const effort = fitEffort(runner, wanted);
        const judged = c.brief ? `${c.why} (the brief it names)` : c.why;
        return { runner, model: m, effort, tier: c.tier, brief: c.brief || null, why: `${judged} → ${runner}${m ? ' · ' + m : ''}${effort ? ' · ' + effort : ''}` };
    }
    return null;
}

module.exports = { LADDER, TIERS, FULL_PCT, MIN_BALANCE_USD, classify, classifyText, pick, track, briefFor, forcedTier, fitEffort, stepUp, EFFORTS, connected, windowFull, balanceLow, roomFor };
