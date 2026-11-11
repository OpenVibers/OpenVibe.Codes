'use strict';

/**
 * The per-turn usage ledger: what each turn spent, and the gate before the next call.
 *
 * One entry per turn: the engine and model that ran it, the effort, the tokens (cached called out), the cost and
 * where the price came from, what triggered the turn, the parent turn when it was delegated, and how it ended. The
 * root's totals sum every entry including the delegated ones, and the delegated subtotal is reported beside them —
 * a turn farmed out still counts against the task that ordered it.
 *
 * The pre-call gate keeps the money honest: at the cap the call is refused (status 409, never run), and one warning
 * goes out when spending crosses 80% of a cap, once. An unknown price is no USD limit, never a zero budget.
 *
 *   add(ledger, turn)                 the validated entry, appended
 *   summarize(ledger)                 totals: turns, tokens, cost, delegated share, spend by engine
 *   preCall(ledger, limits, {warned}) { allowed, warned, warning?, hit?, status?, message? }
 *   WARN_AT, CAPPED_STATUS
 */

const WARN_AT = 0.8;
const CAPPED_STATUS = 409;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (v == null ? null : (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null));
const str = (v, max) => (v == null ? null : String(v).slice(0, max));

/** One turn's spending, validated. Unknowns stay null: a missing price is no limit, never zero. */
function add(ledger, turn = {}) {
    if (!Array.isArray(ledger)) throw new Error('a ledger is a list');
    if (!isObject(turn)) throw new Error('a ledger turn is an object');
    const entry = {
        n: ledger.length + 1,
        engine: str(turn.engine, 64),
        model: str(turn.model, 128),
        effort: str(turn.effort, 32),
        inputTokens: num(turn.inputTokens),
        outputTokens: num(turn.outputTokens),
        cachedTokens: num(turn.cachedTokens),
        costUsd: num(turn.costUsd),
        costSource: str(turn.costSource, 64),
        trigger: str(turn.trigger, 128),
        parent: turn.parent == null ? null : str(turn.parent, 64),
        outcome: ['ok', 'error', 'refused'].includes(turn.outcome) ? turn.outcome : null,
        at: turn.at === undefined ? new Date().toISOString() : String(turn.at),
    };
    if (entry.costUsd != null && !entry.costSource) throw new Error('a ledger cost names its source');
    ledger.push(entry);
    return entry;
}

/** The totals: every turn counts, delegated ones twice-reported, never twice-summed. */
function summarize(ledger = []) {
    const list = Array.isArray(ledger) ? ledger : [];
    const sum = { turns: list.length, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: null, delegatedTurns: 0, delegatedCostUsd: null, byEngine: {} };
    let cost = 0, hasCost = false, delegatedCost = 0, hasDelegatedCost = false;
    for (const t of list) {
        if (!isObject(t)) continue;
        if (t.inputTokens != null) sum.inputTokens += t.inputTokens;
        if (t.outputTokens != null) sum.outputTokens += t.outputTokens;
        if (t.cachedTokens != null) sum.cachedTokens += t.cachedTokens;
        if (t.costUsd != null) { cost += t.costUsd; hasCost = true; }
        if (t.parent != null) {
            sum.delegatedTurns++;
            if (t.costUsd != null) { delegatedCost += t.costUsd; hasDelegatedCost = true; }
        }
        const e = t.engine || 'unknown';
        sum.byEngine[e] = sum.byEngine[e] || { turns: 0, costUsd: null };
        sum.byEngine[e].turns++;
        if (t.costUsd != null) sum.byEngine[e].costUsd = (sum.byEngine[e].costUsd || 0) + t.costUsd;
    }
    sum.costUsd = hasCost ? Math.round(cost * 1e6) / 1e6 : null;
    sum.delegatedCostUsd = hasDelegatedCost ? Math.round(delegatedCost * 1e6) / 1e6 : null;
    return sum;
}

/** The gate before the next call: refuse at the cap, warn once at 80% of it. */
function preCall(ledger = [], limits = {}, { warned = false } = {}) {
    const s = summarize(ledger);
    const turnsCap = limits.turns == null ? null : num(limits.turns);
    const usdCap = limits.usd == null ? null : num(limits.usd);
    const refused = (hit, message) => ({
        allowed: false, warned, hit, status: CAPPED_STATUS, message,
        turns: s.turns, costUsd: s.costUsd,
    });
    if (turnsCap != null && turnsCap > 0 && s.turns >= turnsCap) {
        return refused('turns', `the task already ran ${s.turns} of ${turnsCap} turns: no further call`);
    }
    if (usdCap != null && usdCap > 0 && s.costUsd != null && s.costUsd >= usdCap) {
        return refused('usd', `the task already spent $${s.costUsd} of $${usdCap}: no further call`);
    }
    if (!warned) {
        if (turnsCap != null && turnsCap > 0 && s.turns >= Math.ceil(turnsCap * WARN_AT)) {
            return { allowed: true, warned: true, hit: null, warning: `the task ran ${s.turns} of ${turnsCap} turns`, turns: s.turns, costUsd: s.costUsd };
        }
        if (usdCap != null && usdCap > 0 && s.costUsd != null && s.costUsd >= usdCap * WARN_AT) {
            return { allowed: true, warned: true, hit: null, warning: `the task spent $${s.costUsd} of $${usdCap}`, turns: s.turns, costUsd: s.costUsd };
        }
    }
    return { allowed: true, warned, hit: null, turns: s.turns, costUsd: s.costUsd };
}

module.exports = {
    WARN_AT, CAPPED_STATUS,
    add, summarize, preCall,
};
