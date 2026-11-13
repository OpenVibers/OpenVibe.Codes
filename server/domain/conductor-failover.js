'use strict';

/**
 * The conductor's failover (owner 2026-11-03): "aware of current usage, and the person can configure a fail-over
 * agent/harness/model for their orchestrator for when their primary one is approaching or has maxed out its usage".
 *
 * A conductor has a chain: its own agent and model first, then up to three fallbacks the person picked in Settings
 * (codes_user_settings.conductor_fallbacks). Before each turn the chain is read against the fleet — what the person's
 * machine says about each agent: installed, signed in, every limit window and when it frees (fleet.js) — and the turn
 * runs on the first agent whose fullest window is under the person's switch point (conductor_switch_pct, 90% unless
 * they chose another). When the primary's windows free again, the next turn goes back to it on its own.
 *
 *   usageOf(row, now)                    one agent's reading → { state, pct, window, resets_at }
 *   choose({ chain, fleet, switchPct, now }) → { pick, index, switched, note, usage: [...] }
 *   cleanFallbacks(list)                 the fallbacks a form or an API sent, checked → [{ agent, model }]
 *   resetsLabel(iso, now)                "resets in 3 h" / "resets Thu 15:00 UTC"
 *
 * The states: ok (room), near (at or over the switch point, still usable), full (a window at the router's FULL_PCT, or
 * no room), login (installed, not signed in), absent (the machine reported its agents and this one is not there),
 * unknown (no reading: the machine never reported, or reported nothing on this agent). An unknown primary is used, as it
 * was before any machine reported; an unknown fallback is tried only after every known one.
 */

const { windowFull, FULL_PCT } = require('../../engine/router');

/** The agents a conductor's turn can run on: the CLIs that resume a session and take the Codes MCP tools. */
const CONDUCTOR_AGENTS = ['claude-code', 'codex', 'opencode'];
const AGENT_NAMES = {
    'claude-code': 'Claude Code', 'claude-other': 'Claude Code (another provider)', codex: 'Codex', opencode: 'OpenCode',
    'command-code': 'Command Code', 'minimax-code': 'MiniMax Code', muse: 'Muse Code', aider: 'Aider', deepseek: 'DeepSeek',
    'openvibe-ai': 'OpenVibe.AI', 'openai-compatible': 'Your own model',
};
const MODEL = /^[A-Za-z0-9._:/-]{1,100}$/;
const MAX_FALLBACKS = 3;
const DEFAULT_SWITCH_PCT = 90;
const MIN_SWITCH_PCT = 50;
/** The switch point is never above the router's own "full": a window at 95% takes no new work anywhere in Codes. */
const MAX_SWITCH_PCT = FULL_PCT;

const nameOf = (agent) => AGENT_NAMES[agent] || agent;

/** A switch point from a form or an API: a whole percentage between 50 and 95; anything else is refused. */
function cleanSwitchPct(v) {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < MIN_SWITCH_PCT || n > MAX_SWITCH_PCT) {
        throw Object.assign(new Error(`the switch point is a percentage from ${MIN_SWITCH_PCT} to ${MAX_SWITCH_PCT}`), { status: 422, code: 'settings.switch_invalid' });
    }
    return Math.round(n);
}

/**
 * The fallbacks a form or an API sent: an ordered list of { agent, model }, at most three, each agent one a conductor
 * can run on, no agent twice. An empty model means the agent's own default. Anything else is refused with a 422.
 */
function cleanFallbacks(list) {
    if (list === undefined) return undefined;
    if (list === null || list === '') return [];
    if (!Array.isArray(list)) throw Object.assign(new Error('the fallbacks are a list'), { status: 422, code: 'settings.fallbacks_invalid' });
    const out = [];
    for (const item of list) {
        if (item == null || item === '') continue;
        const agent = String((typeof item === 'object' ? item.agent : item) || '').trim();
        if (!agent) continue;
        if (!CONDUCTOR_AGENTS.includes(agent)) {
            throw Object.assign(new Error(`a conductor can fall back to ${CONDUCTOR_AGENTS.map(nameOf).join(', ')}`), { status: 422, code: 'settings.fallback_agent' });
        }
        const rawModel = typeof item === 'object' && item.model != null ? String(item.model).trim() : '';
        if (rawModel && !MODEL.test(rawModel)) throw Object.assign(new Error('a fallback\'s model is a model name, or empty for the agent\'s default'), { status: 422, code: 'settings.fallback_model' });
        if (out.some((x) => x.agent === agent && x.model === (rawModel || null))) continue;
        out.push({ agent, model: rawModel || null });
    }
    if (out.length > MAX_FALLBACKS) throw Object.assign(new Error(`at most ${MAX_FALLBACKS} fallbacks`), { status: 422, code: 'settings.fallbacks_too_many' });
    return out;
}

/** The fallbacks as stored (jsonb), read back defensively: a bad row reads as none. */
function storedFallbacks(v) {
    let list = v;
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = null; } }
    if (!Array.isArray(list)) return [];
    try { return cleanFallbacks(list); } catch { return []; }
}

const isoOf = (v) => {
    if (v == null || v === '') return null;
    const t = Date.parse(String(v));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** "resets in 40 min" / "resets in 5 h" within a day, else "resets Thu 15:00 UTC". */
function resetsLabel(at, now = Date.now()) {
    const t = Date.parse(String(at || ''));
    if (!Number.isFinite(t)) return null;
    const ms = t - now;
    if (ms <= 0) return 'free again';
    if (ms < 60 * 60_000) return `resets in ${Math.max(1, Math.round(ms / 60_000))} min`;
    if (ms < 24 * 60 * 60_000) return `resets in ${Math.round(ms / (60 * 60_000))} h`;
    const d = new Date(t);
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
    return `resets ${day} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

/**
 * One agent's reading, from its fleet row (fleet.byHarness, or one machine's row when the conductor is pinned to it).
 * The windows that already reset since the reading count as free. `pct` is the fullest window still ahead.
 */
function usageOf(row, switchPct = DEFAULT_SWITCH_PCT, now = Date.now()) {
    if (!row) return { state: 'unknown', pct: null, window: null, resets_at: null };
    if (row.installed === false) return { state: 'absent', pct: null, window: null, resets_at: null };
    if (row.signed_in === false) return { state: 'login', pct: null, window: null, resets_at: null };
    let top = null;
    for (const w of Array.isArray(row.windows) ? row.windows : []) {
        if (!w) continue;
        const resets = Date.parse(String(w.resets_at || ''));
        if (Number.isFinite(resets) && resets <= now) continue;   // freed since it was read
        let pct = Number(w.pct);
        if (!Number.isFinite(pct)) {
            const used = Number(w.used); const limit = Number(w.limit);
            pct = Number.isFinite(used) && Number.isFinite(limit) && limit > 0 ? (used / limit) * 100 : NaN;
        }
        if (!Number.isFinite(pct)) continue;
        if (!top || pct > top.pct) top = { pct: Math.round(pct), window: w.name || 'window', resets_at: isoOf(w.resets_at), full: windowFull(w, now) };
    }
    const balanceGone = row.room === false && !(top && top.full);
    if (top && top.full) return { state: 'full', pct: top.pct, window: top.window, resets_at: top.resets_at };
    if (balanceGone) return { state: 'full', pct: top ? top.pct : null, window: top ? top.window : null, resets_at: top ? top.resets_at : null };
    if (top && top.pct >= switchPct) return { state: 'near', pct: top.pct, window: top.window, resets_at: top.resets_at };
    return { state: 'ok', pct: top ? top.pct : null, window: top ? top.window : null, resets_at: top ? top.resets_at : null };
}

/** "Claude Code is at 93% of its week (resets Thu 15:00 UTC)" — what the switch note and the page say. */
function describe(entry, u, now = Date.now()) {
    const name = nameOf(entry.agent);
    if (u.state === 'login') return `${name} is not signed in on your machine`;
    if (u.state === 'absent') return `${name} is not installed on your machine`;
    if (u.state === 'unknown') return `${name} has not reported its usage`;
    const when = resetsLabel(u.resets_at, now);
    if (u.pct == null) return `${name} has no room left`;
    return `${name} is at ${u.pct}% of its ${u.window || 'window'}${when ? ` (${when})` : ''}`;
}

/**
 * The agent this turn runs on. `chain` is [primary, ...fallbacks] as { agent, model }; `fleet` maps an agent to its
 * reading (or is null when nothing was ever read). The first agent with room under the switch point takes the turn;
 * with none, the first that is near but not full; with none of those, an unknown fallback; with nothing at all, the
 * primary (its own answer then says what the limit is — Codes never blocks a turn on a reading alone).
 */
function choose({ chain, fleet = null, switchPct = DEFAULT_SWITCH_PCT, now = Date.now() } = {}) {
    const list = (Array.isArray(chain) ? chain : []).filter((x) => x && x.agent);
    const point = Number.isFinite(Number(switchPct)) ? Number(switchPct) : DEFAULT_SWITCH_PCT;
    const usage = list.map((entry, i) => {
        const u = usageOf(fleet && fleet[entry.agent], point, now);
        return { agent: entry.agent, name: nameOf(entry.agent), model: entry.model || null, role: i === 0 ? 'primary' : 'fallback', ...u, label: describe(entry, u, now) };
    });
    if (!list.length) return { pick: null, index: -1, switched: false, note: null, usage };
    // The primary with no reading is used as it always was; a fallback with no reading waits behind every known one.
    const order = [
        (u, i) => u.state === 'ok' || (i === 0 && u.state === 'unknown'),
        (u) => u.state === 'near',
        (u) => u.state === 'unknown',
    ];
    let index = -1;
    for (const test of order) {
        index = usage.findIndex((u, i) => test(u, i));
        if (index >= 0) break;
    }
    const allOut = index < 0;
    if (allOut) index = 0;
    const pick = list[index];
    const primary = usage[0];
    let note = null;
    if (index > 0) {
        note = `${primary.label}; this turn runs on ${nameOf(pick.agent)}${pick.model ? ` (${pick.model})` : ''}.`;
    } else if (allOut && list.length > 1) {
        note = `Every agent in your chain is at its limit (${usage.map((u) => u.label).join('; ')}); this turn tries ${nameOf(pick.agent)}.`;
    } else if (allOut && primary.state === 'full') {
        note = `${primary.label}, and no fallback is set (Settings, then Conductor); this turn tries it anyway.`;
    }
    return { pick: { agent: pick.agent, model: pick.model || null }, index, switched: index > 0, note, usage };
}

module.exports = {
    CONDUCTOR_AGENTS, AGENT_NAMES, MAX_FALLBACKS, DEFAULT_SWITCH_PCT, MIN_SWITCH_PCT, MAX_SWITCH_PCT,
    cleanFallbacks, cleanSwitchPct, storedFallbacks, usageOf, choose, describe, resetsLabel, nameOf,
};
