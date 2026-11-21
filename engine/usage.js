'use strict';
/**
 * What each coding CLI's plan has left, asked of its own provider the way the CLI's own usage screen asks (Codes C9c,
 * plan §AD.37; the owner, 2026-11-21: "detect your usage limit … get every ounce of your usage across all your code
 * harnesses").
 *
 * engine/logins.js read limit windows only from the login files, and Claude Code's and Codex's files carry none: the
 * fleet's meters for the two main harnesses were empty. This reads them where the CLI does (the calls are the ones
 * CodexBar, MIT, documents):
 *
 *   claude-code   GET https://api.anthropic.com/api/oauth/usage    anthropic-beta: oauth-2025-04-20
 *                 → five_hour / seven_day / seven_day_opus / seven_day_sonnet { utilization (percent), resets_at }
 *   codex         GET https://chatgpt.com/backend-api/wham/usage   ChatGPT-Account-Id
 *                 → rate_limit.primary_window / secondary_window { used_percent, reset_at (s), limit_window_seconds }
 *                 else the newest session file's token_count rate_limits (no call at all)
 *   command-code  GET https://api.commandcode.ai/alpha/whoami?limits=1, then /alpha/billing/credits?orgId=…
 *
 * The token comes from the CLI's own login file on this machine and goes only to its own provider, in the Authorization
 * header. It is never refreshed here (that would rotate the CLI's session under it): an expired one reads as unknown
 * until the CLI refreshes it itself. Answers are kept 10 minutes (2 after a failure) in the home's cache, because the
 * endpoints are rate-limited. A window leaves as { name, used, limit: 100, resets_at }: the percent as "used of 100",
 * the shape the Link and Bot already carry. Labels, numbers and times only: never a token or an account name.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TTL_MS = 10 * 60_000;
const FAIL_TTL_MS = 2 * 60_000;
const TIMEOUT_MS = 8000;
const UA = 'openvibe-codes (usage meter; https://openvibe.codes)';

const pct = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n * 10) / 10)) : null;
};
const isoOf = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    const ms = Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : Date.parse(String(v));
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
/** A window as the fleet carries it. */
const win = (name, used, resetsAt, minutes = null) => (used == null && !resetsAt ? null : { name, used, limit: 100, resets_at: resetsAt || null, ...(minutes ? { window_min: minutes } : {}) });
/** A window's name from its length: 5h, week, or the hours. */
function nameOf(seconds, fallback) {
    const s = Number(seconds);
    if (!Number.isFinite(s) || s <= 0) return fallback;
    if (Math.abs(s - 5 * 3600) < 1800) return '5h';
    if (Math.abs(s - 7 * 86400) < 3 * 3600) return 'week';
    if (s % 86400 === 0) return `${s / 86400}d`;
    return `${Math.round(s / 3600)}h`;
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

async function getJson(fetchImpl, url, headers) {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return res.json();
}

/** Claude Code: the plan's 5-hour and weekly windows (and the per-model weekly ones when the plan has them). */
async function claude({ file, fetchImpl, now }) {
    const login = readJson(file);
    const o = login && (login.claudeAiOauth || login);
    const token = o && typeof o.accessToken === 'string' ? o.accessToken : null;
    if (!token) return { windows: [], note: 'no plan session (an API key has no plan windows)' };
    if (Number(o.expiresAt) && Number(o.expiresAt) < now()) return { windows: [], note: 'session expired: Claude Code refreshes it on its next run' };
    const out = await getJson(fetchImpl, 'https://api.anthropic.com/api/oauth/usage', { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' });
    const windows = [];
    for (const [key, name, minutes] of [['five_hour', '5h', 300], ['seven_day', 'week', 10080], ['seven_day_opus', 'week (Opus)', 10080], ['seven_day_sonnet', 'week (Sonnet)', 10080]]) {
        const w = out && out[key];
        if (!w || typeof w !== 'object') continue;
        const one = win(name, pct(w.utilization), isoOf(w.resets_at), minutes);
        if (one) windows.push(one);
    }
    return { windows };
}

/** The newest Codex session file's last rate_limits (Codex writes them with every turn): no call at all. */
function codexFromSessions(home, now) {
    const root = path.join(home, '.codex', 'sessions');
    const newest = (dir, depth) => {
        let names = [];
        try { names = fs.readdirSync(dir).sort().reverse(); } catch { return null; }
        for (const n of names.slice(0, 40)) {
            const p = path.join(dir, n);
            if (depth === 0) { if (/^rollout-.*\.jsonl$/.test(n)) return p; continue; }
            const found = newest(p, depth - 1);
            if (found) return found;
        }
        return null;
    };
    const file = newest(root, 3);   // YYYY/MM/DD/rollout-….jsonl
    if (!file) return null;
    let text = '';
    try {
        const size = fs.statSync(file).size;
        const fd = fs.openSync(file, 'r');
        const len = Math.min(size, 256 * 1024);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        fs.closeSync(fd);
        text = buf.toString('utf8');
    } catch { return null; }
    const lines = text.split('\n').reverse();
    for (const line of lines) {
        if (!line.includes('rate_limits')) continue;
        let e = null;
        try { e = JSON.parse(line); } catch { continue; }
        const rl = (e && e.payload && e.payload.rate_limits) || (e && e.rate_limits) || (e && e.msg && e.msg.rate_limits);
        if (!rl) continue;
        const at = Date.parse((e && e.timestamp) || '') || now();
        const windows = [];
        for (const [key, fallback] of [['primary', '5h'], ['secondary', 'week']]) {
            const w = rl[key];
            if (!w) continue;
            const reset = w.resets_at != null ? isoOf(w.resets_at) : w.resets_in_seconds != null ? new Date(at + Number(w.resets_in_seconds) * 1000).toISOString() : null;
            const one = win(nameOf(Number(w.window_minutes) * 60, fallback), pct(w.used_percent), reset, Number(w.window_minutes) || null);
            if (one) windows.push(one);
        }
        // A reading older than its own window's reset says nothing about now.
        return windows.filter((w) => !w.resets_at || Date.parse(w.resets_at) > now());
    }
    return null;
}

/** Codex: the ChatGPT plan's windows and credits; the session files when the call cannot be made. */
async function codex({ file, home, fetchImpl, now }) {
    const login = readJson(file);
    const t = login && login.tokens;
    const token = t && typeof t.access_token === 'string' ? t.access_token : null;
    if (token) {
        try {
            const out = await getJson(fetchImpl, 'https://chatgpt.com/backend-api/wham/usage', { Authorization: `Bearer ${token}`, ...(t.account_id ? { 'ChatGPT-Account-Id': String(t.account_id) } : {}) });
            const rl = (out && (out.rate_limit || out.rate_limits)) || {};
            const windows = [];
            for (const [key, fallback] of [['primary_window', '5h'], ['secondary_window', 'week']]) {
                const w = rl[key];
                if (!w) continue;
                const seconds = Number(w.limit_window_seconds);
                const one = win(nameOf(seconds, fallback), pct(w.used_percent), isoOf(w.reset_at ?? w.resets_at), Number.isFinite(seconds) ? Math.round(seconds / 60) : null);
                if (one) windows.push(one);
            }
            const credits = out && out.credits && typeof out.credits === 'object' ? { has: Boolean(out.credits.has_credits), unlimited: Boolean(out.credits.unlimited), balance: Number.isFinite(Number(out.credits.balance)) ? Number(out.credits.balance) : null } : null;
            return { windows, plan: typeof (out && out.plan_type) === 'string' ? out.plan_type.slice(0, 30) : null, credits };
        } catch (err) {
            const local = codexFromSessions(home, now);
            if (local) return { windows: local, note: `from the newest session (the usage call answered ${err.status || 'nothing'})` };
            throw err;
        }
    }
    const local = codexFromSessions(home, now);
    return local ? { windows: local, note: 'from the newest session' } : { windows: [], note: 'no plan session' };
}

/** Command Code: its credit windows (the calls its own /usage screen makes: cli.mjs fetchUsageData). */
async function commandCode({ file, fetchImpl }) {
    const login = readJson(file);
    const key = login && (login.apiKey || login.api_key);
    if (!key) return { windows: [], note: 'not signed in' };
    const H = { Authorization: `Bearer ${key}` };
    const who = await getJson(fetchImpl, 'https://api.commandcode.ai/alpha/whoami?limits=1', H);
    // A personal account has no org: its credits are asked without one.
    const orgId = who && who.org && who.org.id;
    const credits = await getJson(fetchImpl, `https://api.commandcode.ai/alpha/billing/credits${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''}`, H);
    const limits = (credits && credits.windowLimits) || {};
    const windows = [];
    // { fiveHour: { used, cap, exceeded, resetAt }, weekly: { … } }; resetAt 0 is a window that has not started.
    for (const [key2, name, minutes] of [['fiveHour', '5h', 300], ['weekly', 'week', 10080], ['daily', 'day', 1440], ['monthly', 'month', 43200]]) {
        const w = limits[key2];
        if (!w || typeof w !== 'object') continue;
        const used = Number(w.used);
        const cap = Number(w.cap ?? w.limit);
        const p = w.exceeded === true ? 100 : Number.isFinite(used) && Number.isFinite(cap) && cap > 0 ? pct((used / cap) * 100) : null;
        const one = win(name, p, Number(w.resetAt) > 0 ? isoOf(w.resetAt) : null, minutes);
        if (one) windows.push(one);
    }
    const monthly = credits && credits.credits && Number(credits.credits.monthlyCredits);
    return { windows, ...(Number.isFinite(monthly) ? { credits: { has: monthly > 0, unlimited: false, balance: Math.round(monthly * 100) / 100 } } : {}) };
}

const READERS = { 'claude-code': claude, codex, 'command-code': commandCode };

/**
 * The usage of each CLI that has a reader, with the cache in front.
 *   rows: logins.probe() rows (each with id, signed_in, and file: where its login is)
 * → { [id]: { windows, plan?, credits?, note?, error?, at } }
 */
async function readAll(rows, { home = os.homedir(), fetchImpl = globalThis.fetch, now = () => Date.now(), cacheFile = null } = {}) {
    const cachePath = cacheFile || path.join(home, '.cache', 'openvibe-codes', 'usage.json');
    const cache = readJson(cachePath) || {};
    const out = {};
    let changed = false;
    await Promise.all((rows || []).map(async (r) => {
        const read = READERS[r.id];
        if (!read || !r.signed_in || !r.file) return;
        const hit = cache[r.id];
        if (hit && now() - hit.at < (hit.error ? FAIL_TTL_MS : TTL_MS)) { out[r.id] = hit; return; }
        let got;
        try {
            got = { ...(await read({ file: r.file, home, fetchImpl, now })), at: now() };
        } catch (err) {
            got = { windows: [], error: err && err.status ? `HTTP ${err.status}` : String((err && (err.name === 'TimeoutError' ? 'timed out' : err.message)) || 'failed').slice(0, 80), at: now() };
        }
        out[r.id] = got;
        cache[r.id] = got;
        changed = true;
    }));
    if (changed) {
        try { fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 }); fs.writeFileSync(cachePath, JSON.stringify(cache), { mode: 0o600 }); } catch { /* a cache that cannot be written only costs a call */ }
    }
    return out;
}

module.exports = { readAll, claude, codex, commandCode, codexFromSessions, nameOf, READERS, TTL_MS };
