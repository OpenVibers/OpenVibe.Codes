'use strict';
/**
 * The chat plays sandbox worker (Agent Streams S6, design 2026-11-06 §1, §3, §5, §6): the process that makes the
 * sandboxes a viewer's request runs in, and says whether it can. It runs as its own unprivileged user under
 * deploy/sandbox/openvibe-codes-sandbox.service (bin/openvibe-sandbox-worker.js).
 *
 *   health        the self-test (sandbox/selftest.js) at boot and every CODES_SANDBOX_SELFTEST_MS: the worker is
 *                 ready only when every isolation check passed AND the cgroup limits are there
 *   announce      every CODES_SANDBOX_ANNOUNCE_MS (30 s):
 *                   Live   POST {LIVE}/api/streams/agent/:id/plays/worker with the worker's own Network service token
 *                          (client credentials, audience openvibe.live, capability live.agent_sandbox.register), for
 *                          each stream it serves: CODES_SANDBOX_LIVE_STREAMS and the streams of its running sessions
 *                   Codes  POST {CODES}/internal/sandbox-workers/heartbeat, HMAC-signed (sandbox/signature.js)
 *                 with the same body: the worker, ready, the checks, the isolation facts, capacity and what runs
 *   local API     HTTP on a Unix socket (CODES_SANDBOX_SOCKET, 0660: only the worker's user and group): Codes' runner
 *                 makes a session, runs the agent's commands, edits files, opens pages, and wipes it
 *                   GET  /health                       POST /sessions { stream_id?, time_box_minutes? }
 *                   GET  /sessions                     GET  /sessions/:id (with its egress log)
 *                   POST /sessions/:id/exec { argv, stdin?, tty?, timeout_ms? }
 *                   GET|PUT /sessions/:id/files?path=  GET /sessions/:id/list?path=
 *                   POST /sessions/:id/browser { url }  POST /sessions/:id/wipe (Wipe now)   DELETE /sessions/:id
 *
 * Its secrets (the Network client secret, the Codes heartbeat secret) come from systemd credentials or files, are read
 * once, and are never in the environment it hands anything: bubblewrap gets PATH only and the sandbox its own
 * allowlist. Nothing a sandbox says is a URL the worker fetches: every outbound request goes to a configured base.
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createSandbox: realCreateSandbox, probeSupport } = require('./session');
const { detectLimits } = require('./limits');
const { findBrowser } = require('./browser');
const { runSelfTest } = require('./selftest');
const signature = require('./signature');
const { PORTS } = require('./egress-proxy');

const VERSION = require('../package.json').version;
const STREAM = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION = /^[a-z0-9]{10}$/;
const MB = 1024 * 1024;

const int = (v, def, min, max) => { const n = parseInt(v, 10); return Math.min(max, Math.max(min, Number.isFinite(n) ? n : def)); };
const trim = (s) => String(s || '').trim().replace(/\/+$/, '');

/** A secret from the environment, a file, or a systemd credential (LoadCredential=name:…). */
function secret(env, name, credential) {
    if (env[`${name}_FILE`]) { try { return fs.readFileSync(env[`${name}_FILE`], 'utf8').trim(); } catch { return ''; } }
    if (env.CREDENTIALS_DIRECTORY && credential) { try { return fs.readFileSync(path.join(env.CREDENTIALS_DIRECTORY, credential), 'utf8').trim(); } catch { /* not given */ } }
    return String(env[name] || '').trim();
}

function loadConfig(env = process.env) {
    const runtimeDir = env.CODES_SANDBOX_RUNTIME_DIR || env.RUNTIME_DIRECTORY
        || (env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'ovsbx') : path.join('/tmp', `ovsbx-${process.getuid()}`));
    return {
        workerId: String(env.CODES_SANDBOX_WORKER_ID || `sbw-${os.hostname()}`).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64),
        runtimeDir,
        socket: env.CODES_SANDBOX_SOCKET || path.join(runtimeDir, 'worker.sock'),
        socketGroupMode: 0o660,
        limitsMode: env.CODES_SANDBOX_LIMITS || 'auto',
        limits: {
            memoryMb: int(env.CODES_SANDBOX_MEMORY_MB, 2048, 128, 65536),
            diskMb: int(env.CODES_SANDBOX_DISK_MB, 512, 16, 65536),
            pids: int(env.CODES_SANDBOX_PIDS, 256, 32, 32768),
            cpuPercent: int(env.CODES_SANDBOX_CPU_PERCENT, 100, 10, 6400),
        },
        maxSessions: int(env.CODES_SANDBOX_MAX_SESSIONS, 2, 1, 64),
        // Each session's egress budget (design §1): 500 MB down and 100 MB up unless the owner sets it. The rate and
        // connection limits are the proxy's own defaults (10/s burst 30 per host, 50/s per session, 8 per host).
        egress: {
            budgetDownBytes: int(env.CODES_SANDBOX_EGRESS_MB_DOWN, 500, 1, 1024 * 1024) * MB,
            budgetUpBytes: int(env.CODES_SANDBOX_EGRESS_MB_UP, 100, 1, 1024 * 1024) * MB,
            hostRequests: { rate: 10, burst: 30 },
            sessionRequests: { rate: 50, burst: 50 },
            maxConnectionsPerHost: 8,
        },
        // The owner's time box is 5 to 30 minutes (design §3); the worker's own ceiling is that, never more.
        timeBoxMinMinutes: 5,
        timeBoxMaxMinutes: int(env.CODES_SANDBOX_TIME_BOX_MAX_MIN, 30, 5, 30),
        nodePath: env.CODES_SANDBOX_NODE || process.execPath,
        browserPath: findBrowser(env),
        announceMs: int(env.CODES_SANDBOX_ANNOUNCE_MS, 30_000, 1000, 600_000),
        selfTestMs: int(env.CODES_SANDBOX_SELFTEST_MS, 10 * 60_000, 10_000, 24 * 3_600_000),
        codes: { url: trim(env.CODES_SANDBOX_CODES_URL || 'http://127.0.0.1:4900'), secret: secret(env, 'CODES_SANDBOX_WORKER_SECRET', 'codes-worker-secret') },
        live: {
            url: trim(env.CODES_SANDBOX_LIVE_URL || 'https://openvibe.live'),
            streams: String(env.CODES_SANDBOX_LIVE_STREAMS || '').split(',').map((s) => s.trim()).filter((s) => STREAM.test(s)),
        },
        network: {
            tokenUrl: `${trim(env.CODES_SANDBOX_NETWORK_URL || 'https://openvibe.network')}/oauth/token`,
            clientId: String(env.CODES_SANDBOX_CLIENT_ID || '').trim(),
            clientSecret: secret(env, 'CODES_SANDBOX_CLIENT_SECRET', 'network-client-secret'),
            audience: 'openvibe.live',
            scope: 'live.agent_sandbox.register',
        },
        hidden: [env.CREDENTIALS_DIRECTORY, env.CODES_SANDBOX_WORKER_SECRET_FILE, env.CODES_SANDBOX_CLIENT_SECRET_FILE].filter(Boolean),
    };
}

/**
 * createWorker({ config, createSandbox, limiter, support, fetchImpl, tokens, log, now })
 *   → { start(), stop(), health(), selfTest(), announce(), sessions, server }
 * createSandbox, limiter, support, fetchImpl and tokens are injectable (tests); start() detects them otherwise.
 */
function createWorker(opts = {}) {
    const config = opts.config || loadConfig();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const now = opts.now || (() => Date.now());
    const createSandbox = opts.createSandbox || realCreateSandbox;
    let limiter = opts.limiter || null;
    let support = opts.support || null;
    let tokens = opts.tokens || null;
    let lastSelfTest = null;
    const lastAnnounce = { codes: null, live: {} };
    const sessions = new Map();
    const timers = [];
    let server = null;

    if (!tokens && config.network.clientId && config.network.clientSecret) {
        const { createServiceTokenClient } = require('openvibe-sdk/auth');
        tokens = createServiceTokenClient({ tokenUrl: config.network.tokenUrl, clientId: config.network.clientId, clientSecret: config.network.clientSecret, audience: config.network.audience, scope: config.network.scope, fetch: fetchImpl });
    }

    /** What the worker can enforce, as it found it (never a secret, a path or an address). */
    function isolation() {
        const c = (lastSelfTest && lastSelfTest.checks) || {};
        // Live reads these five facts (server/agent-streams/sandbox.js REQUIRED_ISOLATION) and refuses a report that
        // does not say each one exactly: false, false, false, true, 'ephemeral'. An unproven fact is left out, so a
        // worker that cannot show it never registers instead of claiming it.
        const live = {};
        if (c.network_namespace === true) live.host_network = false;
        if (c.clean_env === true && c.no_host_files === true && c.no_capabilities === true) live.credentials = false;
        if (c.no_host_files === true) live.profile = false;
        if (c.egress_refuses_private === true && c.no_direct_egress === true) live.egress_proxy = true;
        if (c.wipe === true) live.workspace = 'ephemeral';
        return {
            sandbox: 'bubblewrap', bubblewrap: support && support.version || null,
            user_namespace: !!(support && support.ok), network_namespace: c.network_namespace === true,
            egress: { via: 'proxy', public_only: c.egress_refuses_private === true, ports: [...PORTS], direct: c.no_direct_egress === true ? 'none' : 'unknown' },
            host_credentials: c.clean_env === true && c.no_host_files === true ? 'none' : 'unknown',
            host_files: c.no_host_files === true ? 'none' : 'unknown',
            capabilities: c.no_capabilities === true ? 'none' : 'unknown',
            seccomp: c.seccomp === true,
            ...live,
            workspace_kind: 'tmpfs, wiped with the sandbox',
            limits: {
                kind: limiter && limiter.ok ? limiter.kind : 'none', enforced: c.limits === true,
                memory_mb: config.limits.memoryMb, disk_mb: config.limits.diskMb, pids: config.limits.pids, cpu_percent: config.limits.cpuPercent,
                time_box_minutes: [config.timeBoxMinMinutes, config.timeBoxMaxMinutes],
            },
        };
    }

    function health() {
        const ready = !!(support && support.ok && limiter && limiter.ok && lastSelfTest && lastSelfTest.ok);
        const reasons = [];
        if (!support || !support.ok) reasons.push(support ? support.reason : 'not started');
        if (!limiter || !limiter.ok) reasons.push(`limits: ${limiter ? limiter.reason : 'not detected'}`);
        if (lastSelfTest && !lastSelfTest.ok) reasons.push(`self-test failed: ${lastSelfTest.failed.join(', ')}`);
        return {
            worker_id: config.workerId, service: 'codes-sandbox', version: VERSION, ready, ...(reasons.length ? { reasons } : {}),
            checks: lastSelfTest ? lastSelfTest.checks : {}, checked_at: lastSelfTest ? lastSelfTest.at : null,
            isolation: isolation(), browser: !!config.browserPath,
            capacity: config.maxSessions, active: [...sessions.values()].filter((s) => s.sbx.state === 'running').length,
            at: new Date(now()).toISOString(),
        };
    }

    async function selfTest() {
        if (!support || !support.ok) { lastSelfTest = { ok: false, checks: {}, failed: ['user_namespace'], at: new Date(now()).toISOString() }; return lastSelfTest; }
        lastSelfTest = await (opts.runSelfTest || runSelfTest)({
            createSandbox, limiter, runtimeDir: config.runtimeDir, nodePath: config.nodePath, hidden: config.hidden,
            seccompExpected: support.seccomp !== false, log,
        });
        if (!lastSelfTest.ok) log.error(`[sandbox] not ready: ${lastSelfTest.failed.join(', ')}${lastSelfTest.error ? ` (${lastSelfTest.error})` : ''}`);
        return lastSelfTest;
    }

    async function post(url, body, headers) {
        const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, signal: AbortSignal.timeout(10_000) });
        await res.text().catch(() => '');
        return res.status;
    }

    /** One round of check-ins: Codes (signed) and Live (the worker's own service token), with the same facts. */
    async function announce() {
        const h = health();
        const body = JSON.stringify(h);
        if (config.codes.secret) {
            try {
                const status = await post(`${config.codes.url}/internal/sandbox-workers/heartbeat`, body, { [signature.HEADER]: signature.sign(config.codes.secret, body, now()) });
                lastAnnounce.codes = { status, at: new Date(now()).toISOString() };
            } catch (err) { lastAnnounce.codes = { error: err.code || err.name || 'failed', at: new Date(now()).toISOString() }; }
        }
        const streams = new Set(config.live.streams);
        for (const s of sessions.values()) if (s.stream && s.sbx.state === 'running') streams.add(s.stream);
        if (tokens && streams.size) {
            let token = null;
            try { token = await tokens.getToken(); } catch (err) { log.error('[sandbox] no Network service token:', err.code || err.message); }
            for (const stream of streams) {
                if (!token) { lastAnnounce.live[stream] = { error: 'no_token' }; continue; }
                try {
                    const status = await post(`${config.live.url}/api/streams/agent/${encodeURIComponent(stream)}/plays/worker`, body, { authorization: `Bearer ${token}` });
                    lastAnnounce.live[stream] = { status, at: new Date(now()).toISOString() };
                } catch (err) { lastAnnounce.live[stream] = { error: err.code || err.name || 'failed' }; }
            }
        }
        return { codes: lastAnnounce.codes, live: { ...lastAnnounce.live } };
    }

    // ── Sessions ────────────────────────────────────────────

    async function openSession({ stream_id: stream = null, time_box_minutes: minutes } = {}) {
        if (!health().ready) throw Object.assign(new Error('the worker is not ready'), { status: 503 });
        const running = [...sessions.values()].filter((s) => s.sbx.state === 'running').length;
        if (running >= config.maxSessions) throw Object.assign(new Error('no room: every sandbox is in use'), { status: 429 });
        if (stream != null && !STREAM.test(String(stream))) throw Object.assign(new Error('bad stream_id'), { status: 400 });
        const box = Math.min(config.timeBoxMaxMinutes, Math.max(config.timeBoxMinMinutes, Number(minutes) || 10));
        const id = crypto.randomBytes(5).toString('hex');
        const egressLog = [];
        const sbx = await createSandbox({
            id, runtimeDir: config.runtimeDir, limiter, limits: config.limits, timeBoxMs: box * 60_000, nodePath: config.nodePath,
            browserPath: config.browserPath, egress: config.egress, log,
            onEgress: (d) => { egressLog.push(d); if (egressLog.length > 500) egressLog.shift(); },
        });
        const entry = { id, sbx, stream: stream ? String(stream) : null, egressLog, created: now() };
        sessions.set(id, entry);
        sbx.ended.then(({ reason }) => { log.log(`[sandbox] ${id} ended: ${reason}`); setTimeout(() => sessions.delete(id), 60_000).unref(); });
        return entry;
    }

    // The session's report: what it spent on egress (spent and why), beside the allow/refuse counts of its log.
    const view = (e) => {
        const info = e.sbx.info();
        return {
            ...info, stream_id: e.stream,
            egress: {
                ...(info.egress || {}),
                allowed: e.egressLog.filter((d) => d.allowed).length,
                refused: e.egressLog.filter((d) => !d.allowed).length,
            },
        };
    };

    // ── The local API (a Unix socket; the runner on this host is its only client) ──

    function readBody(req, limit) {
        return new Promise((resolve, reject) => {
            const parts = [];
            let size = 0;
            req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else parts.push(c); });
            req.on('end', () => resolve(Buffer.concat(parts)));
            req.on('error', reject);
        });
    }
    const json = async (req) => { const b = await readBody(req, MB); if (!b.length) return {}; try { return JSON.parse(String(b)); } catch { throw Object.assign(new Error('bad JSON'), { status: 400 }); } };
    const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

    async function route(req, res) {
        const url = new URL(req.url, 'http://worker');
        const parts = url.pathname.split('/').filter(Boolean);
        if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ...health(), announce: lastAnnounce });
        if (parts[0] !== 'sessions') return send(res, 404, { error: 'not_found' });
        if (parts.length === 1) {
            if (req.method === 'GET') return send(res, 200, { sessions: [...sessions.values()].map(view) });
            if (req.method === 'POST') { const e = await openSession(await json(req)); return send(res, 201, view(e)); }
            return send(res, 405, { error: 'method' });
        }
        if (!SESSION.test(parts[1]) || !sessions.has(parts[1])) return send(res, 404, { error: 'no_session' });
        const e = sessions.get(parts[1]);
        const action = parts[2] || '';
        if (!action && req.method === 'GET') return send(res, 200, { ...view(e), egress_log: e.egressLog.slice(-100) });
        if ((!action && req.method === 'DELETE') || (action === 'wipe' && req.method === 'POST')) {
            const out = await e.sbx.wipe(action === 'wipe' ? 'wipe_now' : 'end');
            return send(res, 200, { id: e.id, state: e.sbx.state, ...out });
        }
        if (action === 'exec' && req.method === 'POST') {
            const b = await json(req);
            const r = await e.sbx.exec(b.argv, { stdin: b.stdin == null ? null : String(b.stdin), tty: b.tty === true, timeoutMs: Number(b.timeout_ms) || 60_000 });
            return send(res, 200, r);
        }
        if (action === 'files' && req.method === 'PUT') { await e.sbx.writeFile(url.searchParams.get('path'), await readBody(req, 8 * MB)); return send(res, 200, { ok: true }); }
        if (action === 'files' && req.method === 'GET') {
            const data = await e.sbx.readFile(url.searchParams.get('path'));
            res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
            return res.end(data);
        }
        if (action === 'list' && req.method === 'GET') return send(res, 200, { entries: await e.sbx.list(url.searchParams.get('path') || '/workspace') });
        if (action === 'browser' && req.method === 'POST') { const b = await json(req); return send(res, 200, await e.sbx.openPage(String(b.url || ''))); }
        return send(res, 404, { error: 'not_found' });
    }

    async function start() {
        if (!support) support = await probeSupport();
        if (!support.ok) log.error(`[sandbox] cannot make sandboxes: ${support.reason}`);
        if (!limiter) limiter = await detectLimits({ mode: config.limitsMode });
        if (!limiter.ok) log.error(`[sandbox] no limits: ${limiter.reason}`);
        fs.mkdirSync(config.runtimeDir, { recursive: true, mode: 0o750 });
        // A worker that crashed left its sandboxes' directories (their processes died with it: --die-with-parent).
        for (const name of fs.readdirSync(config.runtimeDir)) if (/^s-[a-z0-9-]+$/.test(name)) fs.rmSync(path.join(config.runtimeDir, name), { recursive: true, force: true });
        if (limiter.ok && limiter.base) {
            for (const name of fs.readdirSync(limiter.base)) if (/^sbx-[a-z0-9-]+$/.test(name)) { try { fs.rmdirSync(path.join(limiter.base, name)); } catch { /* still busy: left alone */ } }
        }
        await selfTest();
        server = http.createServer((req, res) => {
            route(req, res).catch((err) => send(res, err.status || (/outside the workspace|not a file|ENOENT/.test(err.message) ? 400 : 500), { error: String(err.message).slice(0, 200) }));
        });
        try { fs.unlinkSync(config.socket); } catch { /* none */ }
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.socket, resolve); });
        fs.chmodSync(config.socket, config.socketGroupMode);
        await announce();
        const a = setInterval(() => { announce().catch(() => {}); }, config.announceMs);
        const t = setInterval(() => { selfTest().catch(() => {}); }, config.selfTestMs);
        timers.push(a, t);
        log.log(`[sandbox] worker ${config.workerId}: ${health().ready ? 'ready' : 'NOT ready'} (limits: ${limiter.kind}, browser: ${config.browserPath ? 'yes' : 'no'})`);
        return health();
    }

    async function stop() {
        for (const t of timers.splice(0)) clearInterval(t);
        await Promise.all([...sessions.values()].map((e) => e.sbx.wipe('worker_stopped').catch(() => {})));
        if (server) await new Promise((r) => server.close(() => r()));
        try { fs.unlinkSync(config.socket); } catch { /* gone */ }
    }

    return { start, stop, health, selfTest, announce, openSession, sessions, config, get server() { return server; } };
}

module.exports = { createWorker, loadConfig };
