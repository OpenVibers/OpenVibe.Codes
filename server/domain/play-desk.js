'use strict';
/**
 * OpenVibe.Codes — the chat plays desk (Agent Streams S6, design 2026-11-06, §1, §3, §4 and §5).
 *
 * A fresh sandboxed desk whose task is chat's queue. It is started with --shared:
 *
 *   - no profile, no keys, no person's files, and a fresh workspace;
 *   - public egress only: no private address is reachable, and no route to post anything anywhere;
 *   - a browser on the allowed public web, a terminal inside the sandbox, an editor, and a scratch site
 *     at a throwaway OpenVibe.Space address.
 *
 * Its lifetime is the session: it is wiped at the end, and what it leaves is only the stream's VOD and the
 * session report. It never touches the owner's machines, keys, repositories, accounts or money; it never
 * sends email, posts to a site, signs up for anything, or downloads an executable to run outside itself.
 *
 * The owner sets the time box (5 to 30 minutes, the default 10) and the cap (money and minutes), and arms
 * the session with Go before the first request may run. The scratch site is removed after 24 hours unless
 * the owner keeps it.
 */
const net = require('net');
const crypto = require('crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const TIME_BOX_DEFAULT_MIN = 10;
const TIME_BOX_MIN_MIN = 5;
const TIME_BOX_MAX_MIN = 30;
const STEP_BUDGET_DEFAULT = 40;
const SCRATCH_TTL_MS = 24 * 60 * 60 * 1000;          // the scratch site lives a day
const CAP_MONEY_DEFAULT_CENTS = 500;
const CAP_MINUTES_DEFAULT = 30;

// ── The desk ─────────────────────────────────────────────────────────────

/** The shared desk: what it is and, more to the point, what it is not. */
function sharedDesk() {
    return {
        shared: true,
        profile: false,             // no person's profile
        keys: false,                // no keys, no credentials, no environment worth printing
        personal_files: false,      // no person's files
        workspace: 'fresh',         // an empty workspace
        egress: 'public-only',      // no private address is reachable
        may_run_outside: false,     // a download is never run outside the sandbox
        may_email: false,
        may_post: false,
        may_sign_up: false,
        tools: ['browser', 'terminal', 'editor', 'scratch_site'],
    };
}

/** A ULID, for the session and the task ids. */
function ulid(now = Date.now()) {
    let time = '';
    for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = ALPHABET[t % 32] + time;
    const bytes = crypto.randomBytes(16);
    let rand = '';
    for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i] % 32];
    return time + rand;
}

// ── The egress guard ─────────────────────────────────────────────────────

/** The hosts that are never the public web. */
const PRIVATE_HOSTS = new Set([
    'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
    'metadata', 'metadata.google.internal', 'instance-data',
]);

/** Is this address in a private, loopback, link-local or otherwise reserved range? */
function isPrivateAddress(ip) {
    const v = net.isIP(ip);
    if (!v) return false;
    if (v === 4) {
        const p = ip.split('.').map(Number);
        if (p[0] === 10) return true;                       // 10.0.0.0/8
        if (p[0] === 127) return true;                      // 127.0.0.0/8 loopback
        if (p[0] === 0) return true;                        // 0.0.0.0/8
        if (p[0] === 169 && p[1] === 254) return true;       // 169.254.0.0/16 link-local (the cloud metadata)
        if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;   // 172.16.0.0/12
        if (p[0] === 192 && p[1] === 168) return true;       // 192.168.0.0/16
        if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;  // 100.64.0.0/10 carrier-grade NAT
        if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true;   // benchmarking
        if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true;       // 192.0.0.0/24
        if (p[0] === 198 && p[1] >= 18 && p[1] <= 19) return true;
        if (p[0] === 203 && p[1] === 0 && p[2] === 113) return true;     // 203.0.113.0/24 documentation
        if (p[0] === 192 && p[1] === 88 && p[2] === 99) return true;     // 6to4 relay anycast
        if (p[0] >= 224) return true;                       // multicast and reserved
        return false;
    }
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    if (s.startsWith('fc') || s.startsWith('fd')) return true;         // unique local
    if (s.startsWith('fe80')) return true;                            // link-local
    if (s.startsWith('ff')) return true;                              // multicast
    if (s.startsWith('::ffff:')) return isPrivateAddress(s.slice(7));  // IPv4-mapped
    return false;
}

/**
 * The egress guard: may this desk fetch this address? Only the public web, over http or https, and never
 * a private address, a local file, or a scheme that would run something.
 */
function egressAllowed(target) {
    const raw = String(target || '').trim();
    if (!raw) return { ok: false, code: 'egress.no_target' };
    let url;
    try {
        url = new URL(raw);
    } catch {
        return { ok: false, code: 'egress.not_a_url' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, code: 'egress.not_http' };
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host) return { ok: false, code: 'egress.no_host' };
    if (PRIVATE_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
        return { ok: false, code: 'egress.private_address' };
    }
    if (net.isIP(host) && isPrivateAddress(host)) {
        return { ok: false, code: 'egress.private_address' };
    }
    return { ok: true, host };
}

/** A download is never run outside the sandbox: it may be fetched into the workspace, and never started. */
function downloadPlan(target, { workspace = '/workspace' } = {}) {
    const allowed = egressAllowed(target);
    if (!allowed.ok) return { ok: false, code: allowed.code };
    return {
        ok: true,
        into: workspace,
        run: false,               // never executed outside the sandbox
        execute: false,
        keep: 'inside-the-sandbox',
    };
}

// ── The session ──────────────────────────────────────────────────────────

/** The session as the contract says it is (codes.sandbox-session@1). */
function createSession({ task = {}, owner = '', time_box_minutes = TIME_BOX_DEFAULT_MIN, step_budget = STEP_BUDGET_DEFAULT,
    cap = { money_cents: CAP_MONEY_DEFAULT_CENTS, minutes: CAP_MINUTES_DEFAULT }, now = Date.now() } = {}) {
    const box = Math.min(TIME_BOX_MAX_MIN, Math.max(TIME_BOX_MIN_MIN, Number(time_box_minutes) || TIME_BOX_DEFAULT_MIN));
    return {
        session_id: 'sbs_' + ulid(now),
        task: { id: String(task.id || ''), title: String(task.title || 'Chat plays') },
        owner: String(owner || ''),
        state: 'idle',
        time_box_minutes: box,
        step_budget: Math.max(1, Number(step_budget) || STEP_BUDGET_DEFAULT),
        cap: {
            money_cents: Math.max(0, Number(cap && cap.money_cents) || 0),
            minutes: Math.max(1, Number(cap && cap.minutes) || CAP_MINUTES_DEFAULT),
        },
        spend: { money_cents: 0, seconds: 0, steps: 0 },
        armed: false,
        armed_at: null,
        started_at: null,
        ended_at: null,
        wiped_at: null,
        egress_public_only: true,
        scratch_site: null,
        desk: sharedDesk(),
        workspace: { path: '/workspace', files: [], wiped: false },
    };
}

/** The owner's Go: the session is armed and the first request may run. */
function arm(session, { now = Date.now() } = {}) {
    if (!session || session.armed) return session;
    session.armed = true;
    session.armed_at = new Date(now).toISOString();
    if (session.state === 'idle') session.state = 'armed';
    return session;
}

/** A request may run only when the session is armed and the owner pressed Go. */
function mayRun(session) {
    if (!session) return { ok: false, code: 'desk.no_session' };
    if (!session.armed) return { ok: false, code: 'desk.not_armed' };
    if (session.state === 'wiped' || session.state === 'ended') return { ok: false, code: 'desk.session_over' };
    return { ok: true };
}

/** The time box: the run ends when the box is spent. */
function timeBoxLeft(session, { now = Date.now() } = {}) {
    if (!session || !session.started_at) return { ok: true, left_ms: session ? session.time_box_minutes * 60_000 : 0 };
    const started = Date.parse(session.started_at);
    const end = started + session.time_box_minutes * 60_000;
    const left = end - now;
    return { ok: left > 0, left_ms: Math.max(0, left), ends_at: new Date(end).toISOString() };
}

/** The cap: the session stops when the owner's money or minutes are spent. */
function capLeft(session) {
    const money = Math.max(0, session.cap.money_cents - session.spend.money_cents);
    const minutes = Math.max(0, session.cap.minutes * 60 - session.spend.seconds);
    return { ok: money > 0 && minutes > 0, money_cents: money, seconds: minutes };
}

/** What the session has spent, and whether it may go on. */
function spend(session, { money_cents = 0, seconds = 0, steps = 0, now = Date.now() } = {}) {
    session.spend.money_cents += Math.max(0, Number(money_cents) || 0);
    session.spend.seconds += Math.max(0, Number(seconds) || 0);
    session.spend.steps += Math.max(0, Number(steps) || 0);
    const cap = capLeft(session);
    const box = timeBoxLeft(session, { now });
    if (!cap.ok) {
        session.state = 'ended';
        session.ended_at = new Date(now).toISOString();
        return { ok: false, code: 'desk.budget_spent', line: "The budget for chat's requests is spent" };
    }
    if (!box.ok) {
        session.state = 'ended';
        session.ended_at = new Date(now).toISOString();
        return { ok: false, code: 'desk.time_box', line: 'The time box is over' };
    }
    if (session.spend.steps > session.step_budget) {
        session.state = 'ended';
        session.ended_at = new Date(now).toISOString();
        return { ok: false, code: 'desk.step_budget', line: 'The step budget is spent' };
    }
    return { ok: true, spend: session.spend };
}

/** The desk began a request. */
function begin(session, { now = Date.now() } = {}) {
    const allowed = mayRun(session);
    if (!allowed.ok) return allowed;
    session.state = 'running';
    if (!session.started_at) session.started_at = new Date(now).toISOString();
    return { ok: true, session };
}

/** Wipe now: the run stops and the sandbox is reset. Nothing of it is left. */
function wipe(session, { now = Date.now() } = {}) {
    if (!session) return { ok: false, code: 'desk.no_session' };
    session.state = 'wiped';
    session.wiped_at = new Date(now).toISOString();
    session.ended_at = new Date(now).toISOString();
    session.workspace = { path: session.workspace.path, files: [], wiped: true };
    session.scratch_site = null;
    return { ok: true, state: 'wiped' };
}

/** The end of the session: the workspace is wiped and nothing of it is kept. */
function end(session, { now = Date.now() } = {}) {
    if (!session) return { ok: false, code: 'desk.no_session' };
    session.state = 'ended';
    session.ended_at = new Date(now).toISOString();
    session.workspace = { path: session.workspace.path, files: [], wiped: true };
    return { ok: true, state: 'ended' };
}

/** The scratch site: a throwaway page that is removed after 24 hours unless the owner keeps it. */
function scratchSite(session, { url = '', kept = false, now = Date.now() } = {}) {
    if (!session) return { ok: false, code: 'desk.no_session' };
    if (!url) return { ok: false, code: 'desk.no_scratch_site' };
    session.scratch_site = {
        url: String(url),
        expires_at: new Date(now + SCRATCH_TTL_MS).toISOString(),
        kept: kept === true,
        no_login: true,
        no_forms: true,
    };
    return { ok: true, scratch_site: session.scratch_site };
}

/** Is the scratch site past its day? */
function scratchExpired(site, { now = Date.now() } = {}) {
    if (!site) return true;
    if (site.kept) return false;
    const at = Date.parse(site.expires_at || '');
    return !Number.isFinite(at) || at <= now;
}

module.exports = {
    TIME_BOX_DEFAULT_MIN, TIME_BOX_MIN_MIN, TIME_BOX_MAX_MIN, STEP_BUDGET_DEFAULT,
    SCRATCH_TTL_MS, CAP_MONEY_DEFAULT_CENTS, CAP_MINUTES_DEFAULT,
    sharedDesk, ulid, isPrivateAddress, egressAllowed, downloadPlan,
    createSession, arm, mayRun, timeBoxLeft, capLeft, spend, begin, wipe, end, scratchSite, scratchExpired,
};
