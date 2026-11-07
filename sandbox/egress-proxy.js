'use strict';
/**
 * The chat plays sandbox's only way out (Agent Streams S6, design 2026-11-06 §1): an HTTP forward proxy that runs in
 * the worker, OUTSIDE the sandbox, on a Unix socket in a directory the sandbox sees read-only. The sandbox has no
 * network of its own (its own network namespace, a loopback and nothing else), so every byte that leaves it passes
 * here, and here it meets the egress guard (openvibe-shared/egress):
 *
 *   - public http and https only: an absolute http:// request, or a CONNECT tunnel (https, and ws/wss the way browsers
 *     send them), to port 80 or 443. No SMTP (25, 587, 465), no SSH, no database, no other port at all;
 *   - never a private, loopback, link-local (cloud metadata), carrier-grade NAT, reserved or documentation address,
 *     in any spelling, nor a name that can only mean a local network (localhost, *.local, *.internal, a bare word);
 *   - never one of the host's own addresses, even a public one: the worker's machine is not "the web";
 *   - checked AFTER DNS resolution: every answer must pass (one private answer among public ones refuses the name), and
 *     the socket opens to the very address that was checked, so a second lookup cannot rebind it;
 *   - checked on every redirect: the proxy never follows one. A 3xx goes back to the client as it came, and the
 *     client's next request is a new request, checked again.
 *
 * A refusal is a 403 with `X-OV-Egress: refused; code=egress.…` and no socket is opened for it. Every decision (host,
 * port, address, allowed or the refusal's code — never a path, a header or a body) goes to onDecision for the
 * owner's log.
 *
 * A session has a budget and limits of its own (design §1; the owner sets the bytes through CODES_SANDBOX_EGRESS_MB_*):
 *
 *   - bytes: 500 MB down and 100 MB up by default. Every response body and tunnel counts both ways; an open tunnel
 *     is closed as soon as the budget is spent, and a download is cut off at the byte that spends it. New requests
 *     after that are 429 with `code=egress.budget`, and the session's report (stats()) says it is spent;
 *   - requests: a token bucket per destination host (10/s, burst 30) and one for the session (50/s, burst 50). A
 *     request over either is 429 `egress.rate` without a socket;
 *   - connections: at most 8 open at once to one destination host (a CONNECT tunnel or an HTTP request in flight).
 *     One more is 429 `egress.connections`.
 *
 * The counters are per proxy, and a proxy is one sandbox session, so one session can never spend another's budget.
 *
 *   const proxy = createEgressProxy({ lookup, dial, hostAddresses, ports, maxConnections,
 *       budgetDownBytes, budgetUpBytes, hostRequests, sessionRequests, maxConnectionsPerHost, now, onDecision });
 *   await proxy.listen('/run/…/net/egress.sock') or proxy.listen({ port: 0, host: '127.0.0.1' })   (tests)
 *   await proxy.check(host, port) → { ok, host, port, address, family } | { ok: false, code, reason }
 *   proxy.stats() → what this session has spent, its limits and the refusals it made
 *   proxy.address(), await proxy.close()
 *
 * lookup (dns.lookup-shaped) and dial ({ host: address, port } → net.Socket) are injectable for the tests; the worker
 * uses the system resolver and net.connect. now() is the clock for the token buckets (tests).
 */
const dns = require('dns');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const egress = require('openvibe-shared/egress');

const PORTS = Object.freeze([80, 443]);
// Hop-by-hop headers (RFC 9110 §7.6.1) and the proxy's own: never forwarded.
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'upgrade']);

/** The machine's own addresses (every interface), as the guard compares them. */
function defaultHostAddresses() {
    const out = new Set();
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) out.add(a.address.split('%')[0].toLowerCase());
    return out;
}

const defaultDial = ({ host, port }) => net.connect({ host, port });

const DEFAULT_BUDGET_DOWN = 500 * 1024 * 1024;
const DEFAULT_BUDGET_UP = 100 * 1024 * 1024;
const DEFAULT_HOST_REQUESTS = Object.freeze({ rate: 10, burst: 30 });
const DEFAULT_SESSION_REQUESTS = Object.freeze({ rate: 50, burst: 50 });
const DEFAULT_MAX_PER_HOST = 8;

function createEgressProxy({
    lookup = dns.lookup, dial = defaultDial, hostAddresses = defaultHostAddresses, ports = PORTS,
    maxConnections = 64, connectTimeoutMs = 10_000, idleMs = 120_000, lookupTimeoutMs = 5_000,
    budgetDownBytes = DEFAULT_BUDGET_DOWN, budgetUpBytes = DEFAULT_BUDGET_UP,
    hostRequests = DEFAULT_HOST_REQUESTS, sessionRequests = DEFAULT_SESSION_REQUESTS,
    maxConnectionsPerHost = DEFAULT_MAX_PER_HOST, now = Date.now,
    onDecision = () => {}, log = console,
} = {}) {
    const allowedPorts = new Set(ports.map(Number));
    const sockets = new Set();
    let server = null;
    const clock = typeof now === 'function' ? now : Date.now;
    // A non-positive budget or rate means "no limit" for that knob, never zero (a 0-byte budget would brick the
    // session, and an env var left empty must not do that).
    const limitOf = (v, def) => (Number(v) > 0 ? Number(v) : Number(def) > 0 ? Number(def) : Infinity);
    const limits = { down: limitOf(budgetDownBytes, DEFAULT_BUDGET_DOWN), up: limitOf(budgetUpBytes, DEFAULT_BUDGET_UP) };
    const hostRate = { rate: Number(hostRequests.rate) > 0 ? Number(hostRequests.rate) : 0, burst: Math.max(1, Number(hostRequests.burst) || DEFAULT_HOST_REQUESTS.burst) };
    const sessionRate = { rate: Number(sessionRequests.rate) > 0 ? Number(sessionRequests.rate) : 0, burst: Math.max(1, Number(sessionRequests.burst) || DEFAULT_SESSION_REQUESTS.burst) };
    const perHost = Number(maxConnectionsPerHost) > 0 ? Number(maxConnectionsPerHost) : Infinity;

    const bytes = { down: 0, up: 0 };
    let spent = false;
    let spentAt = null;
    let spentDirection = null;
    const refusals = { budget: 0, rate: 0, connections: 0 };
    const hosts = new Map();   // host → { tokens, last, active }
    const sessionBucket = { tokens: sessionRate.burst, last: clock() };

    const refuse = (host, port, code, reason) => ({ ok: false, host, port, code, reason });

    /** A token bucket: burst tokens, refilled at rate per second. No rate = unlimited. */
    function take(bucket, cfg) {
        if (!(cfg.rate > 0)) return true;
        const t = Number(clock()) || Date.now();
        bucket.tokens = Math.min(cfg.burst, bucket.tokens + Math.max(0, t - bucket.last) / 1000 * cfg.rate);
        bucket.last = t;
        if (bucket.tokens < 1) return false;
        bucket.tokens -= 1;
        return true;
    }

    function hostState(host) {
        let h = hosts.get(host);
        if (!h) { h = { tokens: hostRate.burst, last: clock(), active: 0 }; hosts.set(host, h); }
        return h;
    }

    /** Count bytes both ways; at the byte that spends the budget the transfer is marked and the sockets it is on close. */
    function account(direction, n, host, port, method) {
        if (spent || !(n > 0)) return spent ? 0 : n;
        const left = limits[direction] - bytes[direction];
        const taken = Math.min(n, Number.isFinite(left) ? Math.max(0, left) : n);
        bytes[direction] += taken;
        if (taken < n) {
            spent = true;
            spentAt = new Date().toISOString();
            spentDirection = direction;
            report(method || 'TRANSFER', { host, port, code: 'egress.budget', reason: `the session's ${direction} budget is spent` });
        }
        return taken;
    }

    function spentRefusal(host, port, method) {
        refusals.budget++;
        const d = refuse(host, port, 'egress.budget', "the session's egress budget is spent");
        report(method, d);
        return d;
    }

    function resolveAll(host) {
        return new Promise((resolve) => {
            let settled = false;
            const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
            const timer = setTimeout(() => done({ error: 'ETIMEOUT' }), lookupTimeoutMs);
            try {
                lookup(host, { all: true, verbatim: true }, (err, addrs) => done(err ? { error: err.code || 'EDNS' } : { addrs: Array.isArray(addrs) ? addrs : [] }));
            } catch (err) { done({ error: err.code || 'EDNS' }); }
        });
    }

    /** The egress guard for one host and port: where the socket may go, or why not. */
    async function check(rawHost, rawPort) {
        const port = Number(rawPort);
        const host = egress.normalizeHost(rawHost);
        if (!Number.isInteger(port) || !allowedPorts.has(port)) return refuse(host, rawPort, 'egress.port', `only ports ${[...allowedPorts].join(' and ')} leave the sandbox`);
        if (!host || host.length > 253 || /[\s/\\@]/.test(host)) return refuse(host, port, 'egress.bad_request', 'not a host name');
        let addrs;
        if (net.isIP(host)) addrs = [{ address: host, family: net.isIP(host) }];
        else {
            if (egress.isInternalName(host)) return refuse(host, port, 'egress.internal_name', `${host} can only name a local network`);
            const r = await resolveAll(host);
            if (r.error) return refuse(host, port, 'egress.dns', `${host} does not resolve`);
            addrs = r.addrs.filter((a) => a && net.isIP(String(a.address)));
            if (!addrs.length) return refuse(host, port, 'egress.dns', `${host} has no address`);
        }
        const mine = hostAddresses();
        for (const a of addrs) {
            const address = String(a.address).split('%')[0].toLowerCase();
            if (!egress.isPublicAddress(address)) return refuse(host, port, 'egress.private_address', `${host} is not a public address`);
            const v4 = net.isIPv6(address) ? egress.embeddedV4(address) : null;
            if (mine.has(address) || (v4 && mine.has(v4))) return refuse(host, port, 'egress.host_address', `${host} is this machine`);
        }
        const first = addrs[0];
        return { ok: true, host, port, address: String(first.address).split('%')[0], family: net.isIP(String(first.address).split('%')[0]) };
    }

    function report(method, d) {
        try {
            onDecision({ at: new Date().toISOString(), method, allowed: d.ok === true, host: d.host, port: d.port, ...(d.ok ? { address: d.address } : { code: d.code }) });
        } catch { /* a logger never breaks the proxy */ }
    }

    const refusalHead = (status, code, text) => {
        const body = `${text}\n`;
        return `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nX-OV-Egress: refused; code=${code}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
    };

    function deny(res, status, code, text) {
        if (res.headersSent) return res.destroy();
        res.writeHead(status, { 'x-ov-egress': `refused; code=${code}`, 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
        res.end(`${text}\n`);
    }

    /** The session's own budget is checked first: once it is spent every new request says so, whatever it asks for. */
    function budgetDenied(host, port, method) {
        return spentRefusal(host, port, method);
    }

    async function onRequest(req, res) {
        if (req.socket.ovRefused) return;
        if (spent) {
            const shared = budgetDenied(null, null, req.method);
            return deny(res, 429, shared.code, "The session's egress budget is spent");
        }
        let url;
        try { url = new URL(req.url); } catch { return deny(res, 400, 'egress.bad_request', 'This is a forward proxy: send an absolute http:// URL, or CONNECT for https'); }
        if (url.protocol === 'https:') return deny(res, 400, 'egress.use_connect', 'Use CONNECT for https');
        if (url.protocol !== 'http:') return deny(res, 403, 'egress.scheme', 'Only http and https leave the sandbox');
        if (url.username || url.password) return deny(res, 403, 'egress.credentials', 'No credentials in a URL');
        const d = await check(url.hostname, url.port ? Number(url.port) : 80);
        report(req.method, d);
        if (!d.ok) return deny(res, 403, d.code, `Refused: ${d.reason}`);
        if (spent) {
            const shared = budgetDenied(d.host, d.port, req.method);
            return deny(res, 429, shared.code, "The session's egress budget is spent");
        }
        const h = hostState(d.host);
        if (!take(sessionBucket, sessionRate) || !take(h, hostRate)) {
            refusals.rate++;
            const limited = refuse(d.host, d.port, 'egress.rate', 'this session is sending requests too fast');
            report(req.method, limited);
            return deny(res, 429, limited.code, 'Too many requests: slow down');
        }
        if (h.active >= perHost) {
            refusals.connections++;
            const busy = refuse(d.host, d.port, 'egress.connections', `this session has ${h.active} connections open to ${d.host}`);
            report(req.method, busy);
            return deny(res, 429, busy.code, `Too many connections to ${d.host}: one at a time, please`);
        }
        h.active++;

        const headers = {};
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
            const k = req.rawHeaders[i];
            if (HOP.has(k.toLowerCase()) || k.toLowerCase() === 'host') continue;
            headers[k] = headers[k] === undefined ? req.rawHeaders[i + 1] : [].concat(headers[k], req.rawHeaders[i + 1]);
        }
        headers.Host = url.host;   // the request target decides where it goes; Host follows it, never the other way
        headers.Connection = 'close';
        // No `agent` key: with agent: false Node makes a fresh Agent and IGNORES createConnection (it would dial
        // localhost:80). host and port name the checked address too, so even then nothing else is dialled.
        const upstream = http.request({
            host: d.address, port: d.port, method: req.method, path: url.pathname + url.search, headers, timeout: connectTimeoutMs,
            createConnection: () => dial({ host: d.address, port: d.port }),
        });
        let released = false;
        const release = () => { if (!released) { released = true; h.active = Math.max(0, h.active - 1); } };
        upstream.on('close', release);
        upstream.on('response', (up) => {
            const out = [];
            for (let i = 0; i < up.rawHeaders.length; i += 2) if (!HOP.has(up.rawHeaders[i].toLowerCase())) out.push(up.rawHeaders[i], up.rawHeaders[i + 1]);
            res.writeHead(up.statusCode, up.statusMessage, out);
            // The body is counted as it arrives: a download that spends the budget is cut off at that byte, and the
            // client sees the response end early (the next request gets the 429).
            up.on('data', (chunk) => {
                if (res.destroyed) return;
                const n = account('down', chunk.length, d.host, d.port, req.method);
                if (n > 0) {
                    const body = n === chunk.length ? chunk : chunk.subarray(0, n);
                    if (!res.write(body)) { up.pause(); res.once('drain', () => up.resume()); }
                }
                if (n < chunk.length) { up.destroy(); res.end(); }
            });
            up.on('end', () => { if (!res.destroyed && !res.writableEnded) res.end(); });
            up.on('error', () => { if (!res.headersSent) deny(res, 502, 'egress.upstream', 'The site did not answer'); else res.destroy(); });
        });
        req.on('data', (chunk) => {
            if (account('up', chunk.length, d.host, d.port, req.method) < chunk.length) {
                req.destroy();
                upstream.destroy();
                if (!res.headersSent) deny(res, 429, 'egress.budget', "The session's egress budget is spent");
            }
        });
        upstream.on('timeout', () => upstream.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
        upstream.on('error', () => { release(); deny(res, 502, 'egress.upstream', 'The site did not answer'); });
        req.pipe(upstream);
    }

    async function onConnect(req, socket, head) {
        socket.on('error', () => {});
        if (socket.ovRefused) return;
        if (spent) {
            const shared = budgetDenied(null, null, 'CONNECT');
            return socket.end(refusalHead(429, shared.code, "The session's egress budget is spent"));
        }
        const m = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(req.url) || /^([^\s:[\]/@]+):(\d{1,5})$/.exec(req.url);
        if (!m) return socket.end(refusalHead(400, 'egress.bad_request', 'CONNECT needs host:port'));
        const d = await check(m[1], Number(m[2]));
        report('CONNECT', d);
        if (!d.ok) return socket.end(refusalHead(403, d.code, `Refused: ${d.reason}`));
        if (spent) {
            const shared = budgetDenied(d.host, d.port, 'CONNECT');
            return socket.end(refusalHead(429, shared.code, "The session's egress budget is spent"));
        }
        const h = hostState(d.host);
        if (!take(sessionBucket, sessionRate) || !take(h, hostRate)) {
            refusals.rate++;
            const limited = refuse(d.host, d.port, 'egress.rate', 'this session is sending requests too fast');
            report('CONNECT', limited);
            return socket.end(refusalHead(429, limited.code, 'Too many requests: slow down'));
        }
        if (h.active >= perHost) {
            refusals.connections++;
            const busy = refuse(d.host, d.port, 'egress.connections', `this session has ${h.active} connections open to ${d.host}`);
            report('CONNECT', busy);
            return socket.end(refusalHead(429, busy.code, `Too many connections to ${d.host}: one at a time, please`));
        }
        h.active++;
        const up = dial({ host: d.address, port: d.port });
        let released = false;
        const release = () => { if (!released) { released = true; h.active = Math.max(0, h.active - 1); } };
        const timer = setTimeout(() => up.destroy(), connectTimeoutMs);
        const cut = (direction) => (chunk) => {
            const n = account(direction, chunk.length, d.host, d.port, 'CONNECT');
            if (n < chunk.length) { up.destroy(); socket.destroy(); }
        };
        up.once('connect', () => {
            clearTimeout(timer);
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head && head.length) up.write(head);
            // Both directions count: the tunnel closes the moment either budget is spent.
            up.on('data', cut('down'));
            socket.on('data', cut('up'));
            up.pipe(socket);
            socket.pipe(up);
        });
        up.on('error', () => { clearTimeout(timer); if (!socket.destroyed) socket.end(refusalHead(502, 'egress.upstream', 'The site did not answer')); });
        up.on('close', () => { clearTimeout(timer); release(); socket.destroy(); });
        socket.on('close', () => { release(); up.destroy(); });
    }

    function onConnection(sock) {
        sock.on('error', () => {});
        if (sockets.size >= maxConnections) {
            sock.ovRefused = true;
            sock.end(refusalHead(503, 'egress.busy', 'Too many connections'));
            return;
        }
        sockets.add(sock);
        sock.setTimeout(idleMs, () => sock.destroy());
        sock.on('close', () => sockets.delete(sock));
    }

    function build() {
        const s = http.createServer({ requestTimeout: 0, headersTimeout: 30_000, maxHeaderSize: 32 * 1024 });
        s.on('connection', onConnection);
        s.on('request', (req, res) => { onRequest(req, res).catch((e) => { log.error('[sandbox] egress proxy:', e && e.message); deny(res, 500, 'egress.error', 'Proxy error'); }); });
        s.on('connect', (req, socket, head) => { onConnect(req, socket, head).catch(() => socket.destroy()); });
        s.on('upgrade', (req, socket) => { socket.on('error', () => {}); socket.end(refusalHead(400, 'egress.use_connect', 'Use CONNECT for WebSockets')); });
        s.on('clientError', (err, socket) => { if (socket.writable && !socket.ovRefused) socket.end(refusalHead(400, 'egress.bad_request', 'Not an HTTP request')); else socket.destroy(); });
        return s;
    }

    return {
        check,
        async listen(target) {
            server = build();
            if (typeof target === 'string') {
                try { fs.unlinkSync(target); } catch { /* none yet */ }
                await new Promise((resolve, reject) => { server.once('error', reject); server.listen(target, resolve); });
                fs.chmodSync(target, 0o600);
            } else {
                await new Promise((resolve, reject) => { server.once('error', reject); server.listen(target.port || 0, target.host || '127.0.0.1', resolve); });
            }
            return this;
        },
        address: () => server && server.address(),
        connections: () => sockets.size,
        /** What this session has spent and the limits it ran under (the worker's session report carries this). */
        stats: () => ({
            down_bytes: bytes.down, up_bytes: bytes.up,
            down_limit_bytes: Number.isFinite(limits.down) ? limits.down : null,
            up_limit_bytes: Number.isFinite(limits.up) ? limits.up : null,
            spent, spent_at: spentAt, spent_direction: spentDirection,
            budget_refusals: refusals.budget, rate_refusals: refusals.rate, connection_refusals: refusals.connections,
            host_requests_per_second: hostRate.rate || null, session_requests_per_second: sessionRate.rate || null,
            max_connections_per_host: Number.isFinite(perHost) ? perHost : null,
        }),
        async close() {
            if (!server) return;
            for (const s of sockets) s.destroy();
            await new Promise((resolve) => server.close(() => resolve()));
            server = null;
        },
    };
}

module.exports = {
    createEgressProxy, PORTS, defaultHostAddresses,
    DEFAULT_BUDGET_DOWN, DEFAULT_BUDGET_UP, DEFAULT_HOST_REQUESTS, DEFAULT_SESSION_REQUESTS, DEFAULT_MAX_PER_HOST,
};
