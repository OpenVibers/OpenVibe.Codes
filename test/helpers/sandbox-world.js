'use strict';
/**
 * A fake public web for the chat plays sandbox tests (sandbox/*.js). Nothing here reaches the real network:
 *
 *   - the resolver answers fixed names (origin.example is a public address, private.example a 10/8 one, …) and
 *     hands numeric spellings (127.1, 2130706433) to the system resolver, which answers them without any network;
 *   - dial() is the proxy's only way out: it connects the fake public addresses to a local origin server, and
 *     records any other address it is asked for (a test fails if the proxy ever dials one: the guard must refuse
 *     before a socket is opened);
 *   - a canary server on the host's loopback and on every host address counts every connection it gets: none
 *     may come from the sandbox;
 *   - canaries: an environment variable, a token file and an abstract socket only the host has.
 *
 *   const world = await startWorld();  … world.egress (for createSandbox) … await world.close();
 */
const crypto = require('crypto');
const dns = require('dns');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const ORIGIN_IP = '93.184.215.14';      // public: the fake origin answers here
const SMTP_IP = '93.184.215.15';        // public: but only port 25/587/465 is ever asked of it
const SELF_IP = '93.184.215.99';        // public, and one of the host's own addresses in these tests

const NAMES = {
    'origin.example': [ORIGIN_IP],
    // The same public origin under a second name: per-destination limits can be told apart from the session's.
    'alt.example': [ORIGIN_IP],
    'smtp.example': [SMTP_IP],
    'self.example': [SELF_IP],
    'private.example': ['10.0.0.5'],
    'lan.example': ['192.168.1.20'],
    'docker.example': ['172.17.0.1'],
    'meta.example': ['169.254.169.254'],
    'loop.example': ['127.0.0.1'],
    'cgnat.example': ['100.64.0.7'],
    'mixed.example': [ORIGIN_IP, '192.168.1.10'],
    'v6loop.example': ['::1'],
    'v6mapped.example': ['::ffff:127.0.0.1'],
};

/** dns.lookup for the fake names; numeric spellings (127.1, 2130706433, 0x7f000001) go to the system resolver. */
function lookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const host = String(hostname).toLowerCase().replace(/\.$/, '');
    const fixed = NAMES[host];
    if (fixed) {
        const addrs = fixed.map((address) => ({ address, family: net.isIP(address) }));
        return process.nextTick(() => (options && options.all ? callback(null, addrs) : callback(null, addrs[0].address, addrs[0].family)));
    }
    if (/^[0-9a-fx.]+$/i.test(host)) return dns.lookup(host, options, callback);
    const err = new Error(`getaddrinfo ENOTFOUND ${host}`);
    err.code = 'ENOTFOUND';
    return process.nextTick(() => callback(err));
}

/** The host's own addresses, plus SELF_IP so "the host's own public address" can be tested without one. */
function hostAddresses() {
    const out = new Set([SELF_IP]);
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) out.add(a.address.split('%')[0]);
    return out;
}

function hostLanAddresses() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (!a.internal && a.family === 'IPv4') out.push(a.address);
    return out;
}

async function listen(server, ...args) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(...args, () => resolve()); });
    return server;
}

async function startWorld() {
    const canary = crypto.randomBytes(12).toString('hex');
    const hits = { canary: 0, abstract: 0, unexpectedDials: [] };

    // The fake public origin: / answers, /redirect?to= redirects, /page has a title the browser test reads.
    const origin = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://origin.example');
        if (u.pathname === '/redirect') { res.writeHead(302, { location: u.searchParams.get('to') || '/' }); return res.end(); }
        if (u.pathname === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>Origin page</title><h1 id="h">origin-ok</h1>'); }
        if (u.pathname === '/big') {
            const n = Math.min(8 * 1024 * 1024, Math.max(1, parseInt(u.searchParams.get('n'), 10) || 1024));
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            return res.end(Buffer.alloc(n, 0x61));
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('origin-ok');
    });
    await listen(origin, 0, '127.0.0.1');
    // The fake public TLS port: a raw TCP echo of "ping" → "pong" (CONNECT tunnels carry bytes, the test needs no TLS).
    const tunnel = net.createServer((s) => s.on('data', (d) => { if (String(d).includes('ping')) s.end('pong'); }));
    await listen(tunnel, 0, '127.0.0.1');

    // The canary: the host's loopback and every host address. Nothing inside the sandbox may ever reach it.
    const canaryServer = http.createServer((req, res) => { hits.canary++; res.end(`host-secret-${canary}`); });
    await listen(canaryServer, 0, '0.0.0.0');
    const canaryPort = canaryServer.address().port;
    // An abstract socket (X11 and D-Bus use these): it lives in the host's network namespace only.
    const abstractName = `ov-canary-${canary}`;
    const abstractServer = net.createServer((s) => { hits.abstract++; s.end(canary); });
    await listen(abstractServer, `\0${abstractName}`);

    /** The proxy's only way out: the two fake public addresses, nothing else. */
    function dial({ host, port }) {
        if (host === ORIGIN_IP && port === 80) return net.connect(origin.address().port, '127.0.0.1');
        if (host === ORIGIN_IP && port === 443) return net.connect(tunnel.address().port, '127.0.0.1');
        hits.unexpectedDials.push(`${host}:${port}`);
        const s = new net.Socket();
        process.nextTick(() => s.destroy(Object.assign(new Error('unexpected dial in a test'), { code: 'ECONNREFUSED' })));
        return s;
    }

    // The worker's token and the host's own secrets: a file in a directory only the host has, and an env variable.
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-sbx-secret-'));
    const tokenFile = path.join(secretDir, 'worker-secret');
    fs.writeFileSync(tokenFile, `token-${canary}`, { mode: 0o600 });
    process.env.OV_SANDBOX_TEST_CANARY = `env-${canary}`;

    return {
        canary, hits, canaryPort, abstractName, tokenFile, secretDir,
        hostLan: hostLanAddresses(),
        egress: { lookup, dial, hostAddresses },
        async close() {
            for (const s of [origin, tunnel, canaryServer, abstractServer]) await new Promise((r) => s.close(() => r()));
            fs.rmSync(secretDir, { recursive: true, force: true });
            delete process.env.OV_SANDBOX_TEST_CANARY;
        },
    };
}

/**
 * A short runtime directory: a Unix socket path must fit in 108 bytes, so the sessions live under /tmp (or
 * XDG_RUNTIME_DIR), never under a long working directory.
 */
function shortRuntimeDir() {
    const base = process.env.XDG_RUNTIME_DIR && process.env.XDG_RUNTIME_DIR.length < 40 ? process.env.XDG_RUNTIME_DIR : '/tmp';
    return fs.mkdtempSync(path.join(base, 'ovsbx-'));
}

/** The pids of a process and every descendant, read from /proc on the host. */
function processTree(rootPid) {
    const children = new Map();
    for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
            const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
            const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
            if (!children.has(ppid)) children.set(ppid, []);
            children.get(ppid).push(Number(name));
        } catch { /* gone already */ }
    }
    const out = [];
    const walk = (pid) => { out.push(pid); for (const c of children.get(pid) || []) walk(c); };
    walk(rootPid);
    return out;
}

/** Is a process still there? A zombie (killed, not yet reaped by whoever inherited it) is not. */
const alive = (pid) => {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
    } catch { return false; }
};

/**
 * The probe that runs INSIDE the sandbox (written to /workspace/probe.js). It takes a list of attempts as JSON and
 * prints what happened to each one as JSON. It uses only Node's own modules.
 */
const PROBE = String.raw`'use strict';
const net = require('net'); const dgram = require('dgram'); const fs = require('fs'); const path = require('path');
const PROXY = Number(process.env.OV_SANDBOX_PROXY_PORT || 3128);
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
fs.unlinkSync(process.argv[2]);   // the plan names the canaries: it must not be what a search finds
const out = [];
const withTimeout = (p, ms = 4000) => Promise.race([p, new Promise((r) => setTimeout(() => r({ error: 'TIMEOUT' }), ms))]);
function tcp(host, port) { return new Promise((resolve) => { const s = net.connect({ host, port }); s.on('connect', () => { s.destroy(); resolve({ connected: true }); }); s.on('error', (e) => resolve({ error: e.code || e.message })); }); }
function udp(host, port) { return new Promise((resolve) => { const s = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4'); s.send(Buffer.from('x'), port, host, (e) => { s.close(); resolve(e ? { error: e.code || e.message } : { sent: true }); }); }); }
function rawToProxy(text) { return new Promise((resolve) => { const s = net.connect(PROXY, '127.0.0.1'); let buf = ''; s.on('connect', () => s.write(text)); s.on('data', (d) => { buf += d; }); s.on('end', () => resolve(parse(buf))); s.on('close', () => resolve(parse(buf))); s.on('error', (e) => resolve({ error: e.code || e.message })); setTimeout(() => s.destroy(), 3000); }); }
function parse(buf) { const [head, ...rest] = buf.split('\r\n\r\n'); const lines = head.split('\r\n'); const m = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] || ''); const headers = {}; for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); } let body = rest.join('\r\n\r\n'); if (/chunked/i.test(headers['transfer-encoding'] || '')) { let out = ''; let r = body; for (;;) { const i = r.indexOf('\r\n'); if (i < 0) break; const n = parseInt(r.slice(0, i), 16); if (!n) break; out += r.slice(i + 2, i + 2 + n); r = r.slice(i + 4 + n); } body = out; } return { status: m ? Number(m[1]) : null, headers, body: body.slice(0, 300) }; }
async function get(url, follow) { const hops = []; let target = url; for (let i = 0; i < 5; i++) { const host = target.replace(/^[a-z]+:\/\//i, '').split('/')[0]; const r = await rawToProxy('GET ' + target + ' HTTP/1.1\r\nHost: ' + host + '\r\nConnection: close\r\n\r\n'); hops.push({ url: target, status: r.status, egress: r.headers && r.headers['x-ov-egress'] }); if (follow && r.status >= 300 && r.status < 400 && r.headers.location) { target = r.headers.location; continue; } return { ...r, hops }; } return { error: 'too many hops', hops }; }
function connect(authority, payload) { return new Promise((resolve) => { const s = net.connect(PROXY, '127.0.0.1'); let buf = ''; let open = false; s.on('connect', () => s.write('CONNECT ' + authority + ' HTTP/1.1\r\nHost: ' + authority + '\r\n\r\n')); s.on('data', (d) => { buf += d; if (!open && buf.includes('\r\n\r\n')) { const r = parse(buf); if (r.status === 200) { open = true; buf = ''; s.write(payload || 'ping'); } else { s.destroy(); resolve(r); } } }); s.on('end', () => resolve(open ? { status: 200, reply: buf } : parse(buf))); s.on('error', (e) => resolve({ error: e.code || e.message })); setTimeout(() => { s.destroy(); resolve(open ? { status: 200, reply: buf } : parse(buf)); }, 3000); }); }
function walk(root, needles, found, depth = 0) { let ents; try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return; } for (const e of ents) { const p = path.join(root, e.name); if (e.isDirectory() && depth < 8) walk(p, needles, found, depth + 1); else if (e.isFile()) { try { const st = fs.statSync(p); if (st.size > 4 * 1024 * 1024) continue; const t = fs.readFileSync(p, 'latin1'); for (const n of needles) if (t.includes(n)) found.push(p); } catch { /* unreadable */ } } } }
(async () => {
  for (const a of plan) {
    let r;
    try {
      if (a.kind === 'tcp') r = await withTimeout(tcp(a.host, a.port));
      else if (a.kind === 'udp') r = await withTimeout(udp(a.host, a.port));
      else if (a.kind === 'http') r = await withTimeout(get(a.url, a.follow), 8000);
      else if (a.kind === 'raw') r = await withTimeout(rawToProxy(a.request));
      else if (a.kind === 'connect') r = await withTimeout(connect(a.authority, a.payload));
      else if (a.kind === 'env') r = { env: process.env };
      else if (a.kind === 'exists') r = { exists: a.paths.filter((p) => { try { fs.lstatSync(p); return true; } catch { return false; } }) };
      else if (a.kind === 'readdir') r = { entries: (() => { try { return fs.readdirSync(a.path); } catch (e) { return 'ERR:' + e.code; } })() };
      else if (a.kind === 'read') r = (() => { try { return { text: fs.readFileSync(a.path, 'utf8') }; } catch (e) { return { error: e.code }; } })();
      else if (a.kind === 'write') r = (() => { try { fs.writeFileSync(a.path, 'x'); return { wrote: true }; } catch (e) { return { error: e.code }; } })();
      else if (a.kind === 'abstract') r = await withTimeout(new Promise((resolve) => { const s = net.connect('\0' + a.name); s.on('connect', () => { s.destroy(); resolve({ connected: true }); }); s.on('error', (e) => resolve({ error: e.code })); }));
      else if (a.kind === 'grep') { const found = []; for (const root of a.roots) walk(root, a.needles, found); for (const pid of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) for (const f of ['environ', 'cmdline']) { try { const t = fs.readFileSync('/proc/' + pid + '/' + f, 'latin1'); for (const n of a.needles) if (t.includes(n)) found.push('/proc/' + pid + '/' + f); } catch { /* not ours */ } } r = { found }; }
      else if (a.kind === 'fds') { const links = []; for (const pid of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) { let fds = []; try { fds = fs.readdirSync('/proc/' + pid + '/fd'); } catch { continue; } for (const fd of fds) { try { links.push(fs.readlinkSync('/proc/' + pid + '/fd/' + fd)); } catch { /* closed */ } } } r = { links }; }
      else if (a.kind === 'status') r = { status: fs.readFileSync('/proc/self/status', 'utf8').split('\n').filter((l) => /^(Cap(Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs|Seccomp):/.test(l)) };
      else if (a.kind === 'interfaces') r = { dev: fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2).map((l) => l.split(':')[0].trim()).filter(Boolean) };
      else r = { error: 'unknown kind' };
    } catch (e) { r = { error: e.code || e.message }; }
    out.push({ ...a, result: r });
  }
  // Exit once the output is flushed: the fallback timers above must not hold the probe open.
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
})();
`;

/** Write the probe and the plan into the sandbox and run it; resolves the list of attempts with their results. */
async function probe(sbx, plan, { timeoutMs = 45_000 } = {}) {
    await sbx.writeFile('/workspace/.probe.js', PROBE);
    await sbx.writeFile('/workspace/.plan.json', JSON.stringify(plan));
    const r = await sbx.exec(['node', '/workspace/.probe.js', '/workspace/.plan.json'], { timeoutMs });
    if (r.code !== 0) throw new Error(`the probe failed (${r.code}/${r.signal}): ${String(r.stderr).slice(0, 800)}`);
    return JSON.parse(String(r.stdout));
}

module.exports = {
    ORIGIN_IP, SMTP_IP, SELF_IP, NAMES, lookup, hostAddresses, startWorld, shortRuntimeDir, processTree, alive, probe, PROBE,
};
