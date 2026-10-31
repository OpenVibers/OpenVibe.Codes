'use strict';

/**
 * The fleet (Codes C9c): what each of a person's machines says about its coding agents right now — installed, signed
 * in, and every limit window with when it frees.
 *
 * The machine reports it with its heartbeat to OpenVibe.Bot (OpenVibe.Node `logins`), and Bot answers it for the
 * machine's owner at GET /api/v1/machines with the person's own token. This module reads that answer, keeps the latest
 * per machine in codes_machine_fleet, and answers the Agents page, the router and the MCP fleet tool from it. It stores
 * no key, no token and no account name: the Node reports labels, numbers and times only.
 *
 *   createFleet({ config, store, fetchImpl, log, now })
 *     refresh(subject, token)   read Bot now and replace the stored rows → { ok, machines } or { ok: false, problem }
 *     latest(subject)           the stored rows per machine → { machines: [{ id, node_id, name, online, agents }], at }
 *     byHarness(subject)        per harness id, the best state across the person's machines (the router's input)
 *     agents(subject, harnesses) one row per agent for the Agents page, usable first
 *
 * A Bot that is not configured or does not answer is a problem beside what is stored, never a silent empty fleet: the
 * page keeps the last reading and says when it was taken.
 */

const { roomFor, windowFull, FULL_PCT, MIN_BALANCE_USD } = require('../../engine/router');
const { readBalances } = require('../../engine/balance');

const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const AGENT = /^[a-z0-9-]{1,40}$/;
const MACHINE = /^[A-Za-z0-9_-]{1,128}$/;
const STATE = { ok: 0, low: 1, unknown: 2, absent: 3, login: 4, limited: 5, empty: 6 };
const LOW_PCT = 80;

const iso = (value) => {
    if (value == null || value === '') return null;
    const numeric = Number(value);
    const ms = Number.isFinite(numeric) && numeric > 0 ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(String(value));
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const num = (value) => {
    const n = Number(value);
    return value == null || value === '' || !Number.isFinite(n) ? null : n;
};
const str = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

/** One reported window, with only the four things a person may see (a label, two numbers, a time). */
function windowOf(w) {
    if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
    const used = num(w.used ?? w.used_percent ?? w.percent_used);
    const limit = num(w.limit ?? w.total ?? w.max);
    let pct = num(w.pct);
    if (pct == null && used != null && limit != null && limit > 0) pct = Math.round((used / limit) * 100);
    const name = str(w.name ?? w.label ?? w.id ?? w.window, 40);
    if (name == null && used == null && limit == null && pct == null) return null;
    return { name: name || 'window', used, limit, pct: pct == null ? null : Math.round(pct), resets_at: iso(w.resets_at ?? w.reset_at ?? w.resets) };
}

/** The windows of one agent, merged across machines by name: the fullest reading wins (a stale machine never hides one). */
function mergeWindows(lists) {
    const by = new Map();
    for (const list of lists) {
        for (const w of list || []) {
            if (!w) continue;
            const seen = by.get(w.name);
            if (!seen || (w.pct ?? -1) > (seen.pct ?? -1)) by.set(w.name, w);
        }
    }
    return [...by.values()];
}

/** The one-line state the page shows. An agent with room on one machine is usable, even when another machine's window is
 *  full: the meter shows the fullest reading, and the row's machines say which one can take a job. A pay-per-token
 *  agent whose balance is nearly gone is out of credit, whatever its windows say. */
function stateOf(row) {
    if (!row) return 'unknown';
    if (!row.installed) return 'absent';
    if (!row.signed_in) return 'login';
    const usd = row.balance_usd == null || row.balance_usd === '' ? NaN : Number(row.balance_usd);
    if (Number.isFinite(usd) && usd < MIN_BALANCE_USD) return 'empty';
    const windows = Array.isArray(row.windows) ? row.windows : [];
    if (row.room !== true && windows.length && windows.every((w) => w.pct != null && w.pct >= FULL_PCT)) return 'limited';
    if (windows.some((w) => w.pct != null && w.pct >= LOW_PCT)) return 'low';
    return 'ok';
}

function createFleet({ config = {}, store, fetchImpl = globalThis.fetch, log = console, now = () => Date.now(), balance = null } = {}) {
    const db = store.db;
    const base = String((config.bot && config.bot.internalUrl) || '').replace(/\/+$/, '');
    // The balances of the pay-per-token accounts (Codes C9c): a plan window says how much of a plan is used, a
    // balance says what is left of the money. Read the way the portal reads it (engine/balance.js), cached for five
    // minutes: the answer moves in cents, and a task's routing may ask for it as often as it likes.
    const BALANCE_TTL_MS = 5 * 60_000;
    let balanceCache = { at: 0, value: null };
    const readBalancesNow = balance || (() => readBalances({ fetchImpl }));
    async function balances() {
        if (balanceCache.value && now() - balanceCache.at < BALANCE_TTL_MS) return balanceCache.value;
        let value = {};
        try { value = await readBalancesNow(); } catch (e) {
            log.warn(`[Codes] the balances could not be read: ${String((e && e.message) || e).slice(0, 160)}`);
        }
        balanceCache = { at: now(), value: value || {} };
        return balanceCache.value;
    }

    /** One read of Bot's machines for this person. → { status, doc } */
    async function read(token) {
        if (!base) throw Object.assign(new Error('OpenVibe.Bot is not configured, so the fleet cannot be read'), { status: 503, code: 'fleet.unavailable' });
        let res;
        try {
            res = await fetchImpl(`${base}/api/v1/machines`, {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                signal: AbortSignal.timeout(8000),
            });
        } catch (e) {
            throw Object.assign(new Error(`OpenVibe.Bot did not answer: ${e.message}`), { status: 503, code: 'fleet.unavailable' });
        }
        if (res.status === 401) throw Object.assign(new Error('the session expired'), { status: 401, code: 'fleet.expired' });
        const doc = await res.json().catch(() => null);
        if (!res.ok || !doc) {
            throw Object.assign(new Error((doc && (doc.detail || doc.title)) || `OpenVibe.Bot answered ${res.status}`), { status: res.status === 403 ? 403 : 503, code: 'fleet.unavailable' });
        }
        return doc;
    }

    /**
     * Read Bot now and replace what Codes holds for each machine whose answer names a fleet. A machine that is gone from
     * the answer is gone here too; a machine that answers no fleet keeps its last reading (the Node may be older).
     */
    async function refresh(subject, token) {
        if (!USER.test(String(subject || '')) || !token) return { ok: false, problem: { status: 401, detail: 'sign in again to see your machines' } };
        let doc;
        try { doc = await read(token); } catch (e) {
            if (e.status === 401) throw e;
            log.warn(`[Codes] the fleet could not be read: ${String(e && e.message).slice(0, 200)}`);
            return { ok: false, problem: { status: e.status || 503, detail: String(e.message || 'the fleet could not be read').slice(0, 300) } };
        }
        const machines = (Array.isArray(doc.machines) ? doc.machines : []).filter((m) => m && MACHINE.test(String(m.id || '')));
        const at = new Date(now()).toISOString();
        await store.tx(async () => {
            const ids = machines.map((m) => String(m.id));
            await db.exec('DELETE FROM codes_machine_fleet WHERE subject = $1 AND NOT (machine = ANY($2))', [subject, ids]);
            for (const m of machines) {
                if (!Array.isArray(m.fleet)) continue;   // no report from this machine yet: keep what Codes has
                const machine = String(m.id);
                await db.exec('DELETE FROM codes_machine_fleet WHERE subject = $1 AND machine = $2', [subject, machine]);
                for (const entry of m.fleet) {
                    if (!entry || !AGENT.test(String(entry.agent || ''))) continue;
                    const windows = (Array.isArray(entry.windows) ? entry.windows : []).map(windowOf).filter(Boolean).slice(0, 10);
                    await db.exec(
                        `INSERT INTO codes_machine_fleet (subject, machine, node_id, name, agent, installed, signed_in, windows, online, reported_at, updated_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::timestamptz, now())
                         ON CONFLICT (subject, machine, agent) DO UPDATE SET node_id = EXCLUDED.node_id, name = EXCLUDED.name,
                             installed = EXCLUDED.installed, signed_in = EXCLUDED.signed_in, windows = EXCLUDED.windows,
                             online = EXCLUDED.online, reported_at = EXCLUDED.reported_at, updated_at = now()`,
                        [subject, machine, str(m.node_id, 128), str(m.name, 120), String(entry.agent), !!entry.installed, !!entry.signed_in,
                            JSON.stringify(windows), m.online !== false, iso(m.fleet_at) || at],
                    );
                }
            }
        });
        return { ok: true, machines: await latest(subject).then((x) => x.machines), problem: null };
    }

    /** The stored fleet, per machine, newest reading first. */
    async function latest(subject) {
        if (!USER.test(String(subject || ''))) return { ok: false, machines: [], at: null };
        const rows = await db.many(
            'SELECT * FROM codes_machine_fleet WHERE subject = $1 ORDER BY name ASC NULLS LAST, machine ASC, agent ASC',
            [subject],
        );
        const by = new Map();
        for (const row of rows) {
            const key = row.machine;
            const machine = by.get(key) || { id: key, node_id: row.node_id || null, name: row.name || null, online: !!row.online, reported_at: null, agents: [] };
            if (row.reported_at && (!machine.reported_at || String(row.reported_at) > machine.reported_at)) machine.reported_at = iso(row.reported_at);
            machine.agents.push({
                agent: row.agent, installed: !!row.installed, signed_in: !!row.signed_in,
                windows: Array.isArray(row.windows) ? row.windows : [],
            });
            by.set(key, machine);
        }
        const machines = [...by.values()];
        const times = machines.map((m) => m.reported_at).filter(Boolean).sort();
        return { ok: true, machines, at: times.length ? times[times.length - 1] : null };
    }

    /**
     * Per harness id, the best state across the person's machines — what the router reads. An agent is usable when at
     * least one machine has it installed and signed in with room; its windows are the fullest reading across machines.
     * A pay-per-token agent also carries its balance, when one was read: an agent whose money is nearly gone may not
     * take a job (the router's rule), so the reading belongs with the rest of its state.
     */
    async function byHarness(subject) {
        const { machines } = await latest(subject);
        const money = await balances();
        const out = {};
        for (const machine of machines) {
            for (const a of machine.agents) {
                const cur = out[a.agent] || (out[a.agent] = {
                    installed: false, signed_in: false, windows: [], machines: [], _lists: [], _room: false, _best: null,
                });
                cur.installed = cur.installed || a.installed;
                cur.signed_in = cur.signed_in || a.signed_in;
                cur._lists.push(a.windows);
                const room = a.installed && a.signed_in && !a.windows.some((w) => windowFull(w, now()));
                cur._room = cur._room || room;
                cur.machines.push({ machine: machine.id, node_id: machine.node_id, name: machine.name, online: machine.online, room });
                if (room && !cur._best) cur._best = machine.id;
            }
        }
        for (const [agent, row] of Object.entries(out)) {
            row.windows = mergeWindows(row._lists);
            row.machine = row._best || (row.machines[0] && row.machines[0].machine) || null;
            const account = money[agent];
            row.balance_usd = account ? account.usd : null;
            row.balance_at = account ? account.at : null;
            row.room = row._room || roomFor({ [agent]: row }, agent, now());
            delete row._lists; delete row._best;
        }
        return out;
    }

    /** The fleet per runner id (cx, oc, cc, mm), what engine/router.js reads. */
    async function forRouter(subject, harnessOf) {
        const by = await byHarness(subject);
        const out = {};
        for (const [harness, row] of Object.entries(by)) {
            const runner = harnessOf ? harnessOf(harness) : harness;
            if (!runner) continue;
            const best = (row.machines || []).find((m) => m.machine === row.machine) || (row.machines || [])[0] || null;
            out[runner] = {
                signed_in: row.signed_in, installed: row.installed, windows: row.windows,
                machine: row.machine, name: best ? best.name : null, room: row.room, balance_usd: row.balance_usd ?? null,
            };
        }
        return out;
    }

    /** One row per agent, for the Agents page: usable and with the most room first, then sign-in needed, then limited. */
    async function agents(subject, harnesses = null) {
        const by = await byHarness(subject);
        const rows = Object.entries(by).map(([agent, row]) => {
            const offer = harnesses && harnesses.get ? harnesses.get(agent) : null;
            const state = stateOf(row);
            const used = row.windows.reduce((max, w) => Math.max(max, w.pct == null ? 0 : w.pct), 0);
            return {
                agent, name: (offer && offer.name) || agent, state, installed: row.installed, signed_in: row.signed_in,
                windows: row.windows, machines: row.machines, machine: row.machine, used,
                balance_usd: row.balance_usd ?? null, balance_at: row.balance_at ?? null,
            };
        });
        return rows.sort((a, b) => (STATE[a.state] ?? 9) - (STATE[b.state] ?? 9) || a.used - b.used || a.name.localeCompare(b.name));
    }

    /**
     * The OpenVibe.Bot device id (`dev_…`) of one of the person's machines, given the id Codes knows it by (`nod_…`, or
     * the device id itself): what a Run job is pinned to (Codes C9c; Run's `job.node`). null when Bot's list has no such
     * machine; a Bot that does not answer throws (with a status), so a caller never pins to a guess.
     */
    async function deviceFor(token, nodeId) {
        if (!token) throw Object.assign(new Error('sign in again to read your machines'), { status: 401, code: 'fleet.expired' });
        const doc = await read(token);
        const hit = (Array.isArray(doc.machines) ? doc.machines : [])
            .find((m) => m && (m.id === nodeId || m.node_id === nodeId) && MACHINE.test(String(m.id || '')));
        return hit ? { device: String(hit.id), node_id: str(hit.node_id, 128), name: str(hit.name, 120), online: hit.online !== false } : null;
    }

    return { refresh, latest, byHarness, forRouter, agents, deviceFor, balances, stateOf, windowOf, mergeWindows, enabled: !!base };
}

module.exports = { createFleet, stateOf, windowOf, mergeWindows, FULL_PCT, LOW_PCT, MIN_BALANCE_USD, STATE };
