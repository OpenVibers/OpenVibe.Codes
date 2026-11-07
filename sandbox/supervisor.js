'use strict';
/**
 * The chat plays sandbox's supervisor: the first program INSIDE the sandbox (bubblewrap starts it as
 * `node /opt/ov/supervisor.js`; sandbox/bwrap.js). It is the agent's terminal, editor and browser launcher, and it
 * holds the sandbox's end of the egress proxy. It uses Node's own modules only: nothing else is mounted for it.
 *
 * It talks to the worker over its stdin and stdout only, one JSON object per line — never over a path the worker would
 * open, so nothing inside can point the worker at another socket. The worker treats every line from here as untrusted
 * data (anything inside could write one): it only ever shows them.
 *
 *   in   { id, op: 'exec', argv, cwd?, env?, stdin?, tty?, timeoutMs?, maxOutput? }   run a command (the terminal)
 *        { id, op: 'stdin', target, data?, end? } · { id, op: 'kill', target }
 *        { id, op: 'write', path, data } · { id, op: 'read', path, max? } · { id, op: 'list', path }   (the editor)
 *        { id, op: 'browser', action: 'start' | 'stop' } · { op: 'cdp', message }                   (the browser)
 *   out  { ev: 'ready', pid, uid } · { id, ev: 'out', fd, data } · { id, ev: 'exit', code, signal, timedOut, truncated }
 *        { id, ev: 'done', ok, …, error? } · { ev: 'cdp', message }
 *
 * data is base64. The egress relay: 127.0.0.1:OV_SANDBOX_PROXY_PORT inside → OV_SANDBOX_EGRESS_SOCKET (the worker's
 * proxy). The relay is a convenience: it adds no way out, the socket is the only one there is.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const WORKSPACE = process.env.OV_SANDBOX_WORKSPACE || '/workspace';
const PROXY_PORT = Number(process.env.OV_SANDBOX_PROXY_PORT || 3128);
const EGRESS_SOCKET = process.env.OV_SANDBOX_EGRESS_SOCKET || '/run/ov/net/egress.sock';
const BROWSER = process.env.OV_SANDBOX_BROWSER || '';
const MAX_LINE = 12 * 1024 * 1024;
const MAX_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_OUTPUT = 1024 * 1024;

const procs = new Map();
let browser = null;

function send(frame) { process.stdout.write(`${JSON.stringify(frame)}\n`); }
const b64 = (buf) => Buffer.from(buf).toString('base64');
const fail = (id, error) => send({ id, ev: 'done', ok: false, error: String(error).slice(0, 300) });

/** A path in the workspace, or an error: the editor works on the workspace only. */
function inWorkspace(p, { mustExist = false } = {}) {
    const abs = path.resolve(WORKSPACE, String(p == null ? '.' : p));
    const inside = (x) => x === WORKSPACE || x.startsWith(`${WORKSPACE}/`);
    if (!inside(abs)) throw new Error('outside the workspace');
    let real = abs;
    try { real = fs.realpathSync(abs); } catch (err) {
        if (mustExist) throw err;
        try { real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch { real = abs; }
    }
    if (!inside(real)) throw new Error('outside the workspace (a link points out of it)');
    return abs;
}

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function exec(msg) {
    const id = msg.id;
    const argv = Array.isArray(msg.argv) ? msg.argv.map(String) : [];
    if (!argv.length || argv.some((a) => a.length > 65536)) return send({ id, ev: 'exit', code: 127, signal: null, error: 'bad argv' });
    let file = argv[0];
    let args = argv.slice(1);
    // A terminal device: util-linux script(1) gives the command a pty of the sandbox's own /dev/pts.
    if (msg.tty) { file = 'script'; args = ['-q', '-e', '-f', '-c', argv.map(shq).join(' '), '/dev/null']; }
    let cwd = WORKSPACE;
    try { if (msg.cwd) cwd = inWorkspace(msg.cwd, { mustExist: true }); } catch (err) { return send({ id, ev: 'exit', code: 127, signal: null, error: err.message }); }
    const env = { ...process.env };
    for (const [k, v] of Object.entries(msg.env || {})) if (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) && !k.startsWith('OV_SANDBOX')) env[k] = String(v).slice(0, 8192);
    const max = Math.min(Number(msg.maxOutput) || DEFAULT_OUTPUT, 8 * DEFAULT_OUTPUT);
    const timeoutMs = Math.min(Math.max(100, Number(msg.timeoutMs) || 60_000), MAX_TIMEOUT_MS);
    let child;
    try {
        child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (err) {
        return send({ id, ev: 'exit', code: 127, signal: null, error: err.code || err.message });
    }
    const state = { child, sent: 0, truncated: false, timedOut: false, finished: false };
    procs.set(id, state);
    const out = (fd) => (chunk) => {
        if (state.sent >= max) { state.truncated = true; return; }
        const part = chunk.length + state.sent > max ? chunk.subarray(0, max - state.sent) : chunk;
        if (part.length < chunk.length) state.truncated = true;
        state.sent += part.length;
        send({ id, ev: 'out', fd, data: b64(part) });
    };
    child.stdout.on('data', out(1));
    child.stderr.on('data', out(2));
    child.stdin.on('error', () => {});
    if (msg.stdin != null) child.stdin.write(Buffer.from(String(msg.stdin), 'base64'));
    if (msg.stdinOpen !== true) child.stdin.end();
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
    const timer = setTimeout(() => { state.timedOut = true; killGroup(); }, timeoutMs);
    const finish = (code, signal, error) => {
        if (state.finished) return;
        state.finished = true;
        clearTimeout(timer);
        procs.delete(id);
        send({ id, ev: 'exit', code, signal, timedOut: state.timedOut, truncated: state.truncated, ...(error ? { error } : {}) });
    };
    child.on('error', (err) => finish(127, null, err.code || err.message));
    // A background process may keep the pipes open: the exit is the end, the rest of the output gets a moment.
    child.on('exit', (code, signal) => {
        const t = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(code, signal); }, 200);
        child.on('close', () => { clearTimeout(t); finish(code, signal); });
    });
}

function file(msg) {
    const id = msg.id;
    try {
        if (msg.op === 'write') {
            const p = inWorkspace(msg.path);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644);
            try { fs.writeSync(fd, Buffer.from(String(msg.data || ''), 'base64')); } finally { fs.closeSync(fd); }
            return send({ id, ev: 'done', ok: true });
        }
        if (msg.op === 'read') {
            const p = inWorkspace(msg.path, { mustExist: true });
            const max = Math.min(Number(msg.max) || 4 * 1024 * 1024, 8 * 1024 * 1024);
            const st = fs.statSync(p);
            if (!st.isFile()) throw new Error('not a file');
            const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try {
                const buf = Buffer.alloc(Math.min(st.size, max));
                const n = fs.readSync(fd, buf, 0, buf.length, 0);
                return send({ id, ev: 'done', ok: true, data: b64(buf.subarray(0, n)), size: st.size, truncated: st.size > max });
            } finally { fs.closeSync(fd); }
        }
        if (msg.op === 'list') {
            const p = inWorkspace(msg.path, { mustExist: true });
            const entries = fs.readdirSync(p, { withFileTypes: true }).slice(0, 5000).map((e) => {
                let size = null;
                try { size = e.isFile() ? fs.statSync(path.join(p, e.name)).size : null; } catch { /* gone */ }
                return { name: e.name, type: e.isFile() ? 'file' : e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'other', size };
            });
            return send({ id, ev: 'done', ok: true, entries });
        }
    } catch (err) {
        return fail(id, err.code && !/outside/.test(err.message) ? err.code : err.message);
    }
    return fail(id, 'unknown op');
}

/** Headless Chromium inside the sandbox, on the egress proxy, driven over a DevTools pipe the worker relays. */
function browserOp(msg) {
    const id = msg.id;
    if (msg.action === 'stop') {
        if (browser) { try { process.kill(-browser.pid, 'SIGKILL'); } catch { /* gone */ } browser = null; }
        return send({ id, ev: 'done', ok: true });
    }
    if (msg.action !== 'start') return fail(id, 'unknown action');
    if (browser) return send({ id, ev: 'done', ok: true, already: true });
    if (!BROWSER) return fail(id, 'no browser in this sandbox');
    const args = [
        '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-breakpad',
        '--disable-crash-reporter', '--disable-features=Translate,MediaRouter,OptimizationHints,DialMediaRouteProvider',
        `--proxy-server=http://127.0.0.1:${PROXY_PORT}`, '--user-data-dir=/home/agent/.browser', '--remote-debugging-pipe',
        '--window-size=1280,800', 'about:blank',
    ];
    let child;
    try {
        child = spawn(BROWSER, args, { cwd: WORKSPACE, env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: true });
    } catch (err) { return fail(id, err.code || err.message); }
    browser = child;
    child.stderr.on('data', () => {});
    let buf = '';
    child.stdio[4].on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\0')) >= 0) { send({ ev: 'cdp', message: buf.slice(0, i) }); buf = buf.slice(i + 1); }
    });
    child.stdio[3].on('error', () => {});
    child.on('exit', (code) => { if (browser === child) { browser = null; send({ ev: 'cdp-closed', code }); } });
    child.on('error', (err) => { if (browser === child) browser = null; fail(id, err.code || err.message); });
    child.on('spawn', () => send({ id, ev: 'done', ok: true }));
}

function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.op) {
        case 'ping': return send({ id: msg.id, ev: 'done', ok: true, pid: process.pid, uid: process.getuid() });
        case 'exec': return exec(msg);
        case 'stdin': {
            const s = procs.get(msg.target);
            if (s) { if (msg.data) s.child.stdin.write(Buffer.from(String(msg.data), 'base64')); if (msg.end) s.child.stdin.end(); }
            return undefined;
        }
        case 'kill': {
            const s = procs.get(msg.target);
            if (s) { try { process.kill(-s.child.pid, 'SIGKILL'); } catch { /* gone */ } }
            return undefined;
        }
        case 'write': case 'read': case 'list': return file(msg);
        case 'browser': return browserOp(msg);
        case 'cdp': if (browser) browser.stdio[3].write(`${String(msg.message)}\0`); return undefined;
        default: return fail(msg.id, 'unknown op');
    }
}

let inbuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    inbuf += chunk;
    if (inbuf.length > MAX_LINE && inbuf.indexOf('\n') < 0) { inbuf = ''; return; }
    let i;
    while ((i = inbuf.indexOf('\n')) >= 0) {
        const line = inbuf.slice(0, i);
        inbuf = inbuf.slice(i + 1);
        let msg = null;
        try { msg = JSON.parse(line); } catch { continue; }
        try { handle(msg); } catch (err) { fail(msg && msg.id, err.message); }
    }
});
// The worker went away: so does everything here (bubblewrap's --die-with-parent does the rest).
process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', (err) => { try { send({ ev: 'error', error: String(err && err.message).slice(0, 300) }); } catch { /* stdout gone */ } });

function ready() { send({ ev: 'ready', pid: process.pid, uid: process.getuid() }); }
if (PROXY_PORT > 0) {
    const relay = net.createServer((c) => {
        const up = net.connect(EGRESS_SOCKET);
        c.on('error', () => up.destroy());
        up.on('error', () => c.destroy());
        c.pipe(up);
        up.pipe(c);
    });
    relay.on('error', (err) => { send({ ev: 'error', error: `relay: ${err.code || err.message}` }); ready(); });
    relay.listen(PROXY_PORT, '127.0.0.1', ready);
} else {
    ready();
}
