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
 *   const proxy = createEgressProxy({ lookup, dial, hostAddresses, ports, maxConnections, onDecision });
 *   await proxy.listen('/run/…/net/egress.sock') or proxy.listen({ port: 0, host: '127.0.0.1' })   (tests)
 *   await proxy.check(host, port) → { ok, host, port, address, family } | { ok: false, code, reason }
 *   proxy.address(), await proxy.close()
 *
 * lookup (dns.lookup-shaped) and dial ({ host: address, port } → net.Socket) are injectable for the tests; the worker
 * uses the system resolver and net.connect.
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

function createEgressProxy({
    lookup = dns.lookup, dial = defaultDial, hostAddresses = defaultHostAddresses, ports = PORTS,
    maxConnections = 64, connectTimeoutMs = 10_000, idleMs = 120_000, lookupTimeoutMs = 5_000,
    onDecision = () => {}, log = console,
} = {}) {
    const allowedPorts = new Set(ports.map(Number));
    const sockets = new Set();
    let server = null;

    const refuse = (host, port, code, reason) => ({ ok: false, host, port, code, reason });

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

    async function onRequest(req, res) {
        if (req.socket.ovRefused) return;
        let url;
        try { url = new URL(req.url); } catch { return deny(res, 400, 'egress.bad_request', 'This is a forward proxy: send an absolute http:// URL, or CONNECT for https'); }
        if (url.protocol === 'https:') return deny(res, 400, 'egress.use_connect', 'Use CONNECT for https');
        if (url.protocol !== 'http:') return deny(res, 403, 'egress.scheme', 'Only http and https leave the sandbox');
        if (url.username || url.password) return deny(res, 403, 'egress.credentials', 'No credentials in a URL');
        const d = await check(url.hostname, url.port ? Number(url.port) : 80);
        report(req.method, d);
        if (!d.ok) return deny(res, 403, d.code, `Refused: ${d.reason}`);

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
        upstream.on('response', (up) => {
            const out = [];
            for (let i = 0; i < up.rawHeaders.length; i += 2) if (!HOP.has(up.rawHeaders[i].toLowerCase())) out.push(up.rawHeaders[i], up.rawHeaders[i + 1]);
            res.writeHead(up.statusCode, up.statusMessage, out);
            up.pipe(res);
        });
        upstream.on('timeout', () => upstream.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
        upstream.on('error', () => deny(res, 502, 'egress.upstream', 'The site did not answer'));
        req.pipe(upstream);
    }

    async function onConnect(req, socket, head) {
        socket.on('error', () => {});
        if (socket.ovRefused) return;
        const m = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(req.url) || /^([^\s:[\]/@]+):(\d{1,5})$/.exec(req.url);
        if (!m) return socket.end(refusalHead(400, 'egress.bad_request', 'CONNECT needs host:port'));
        const d = await check(m[1], Number(m[2]));
        report('CONNECT', d);
        if (!d.ok) return socket.end(refusalHead(403, d.code, `Refused: ${d.reason}`));
        const up = dial({ host: d.address, port: d.port });
        const timer = setTimeout(() => up.destroy(), connectTimeoutMs);
        up.once('connect', () => {
            clearTimeout(timer);
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head && head.length) up.write(head);
            up.pipe(socket);
            socket.pipe(up);
        });
        up.on('error', () => { clearTimeout(timer); if (!socket.destroyed) socket.end(refusalHead(502, 'egress.upstream', 'The site did not answer')); });
        socket.on('close', () => up.destroy());
        up.on('close', () => socket.destroy());
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
        async close() {
            if (!server) return;
            for (const s of sockets) s.destroy();
            await new Promise((resolve) => server.close(() => resolve()));
            server = null;
        },
    };
}

module.exports = { createEgressProxy, PORTS, defaultHostAddresses };
