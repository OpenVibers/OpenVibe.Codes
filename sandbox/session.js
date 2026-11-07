'use strict';
/**
 * One chat plays sandbox (Agent Streams S6, design 2026-11-06 §1, §3, §5): a fresh, empty, network-less box a
 * viewer's request runs in, and nothing of the host's.
 *
 *   probeSupport({ bwrap }) → { ok, reason, version, seccomp, disableUserns }   can this host make sandboxes?
 *   createSandbox(opts) → a started sandbox:
 *       sbx.exec(argv, { stdin, tty, cwd, env, timeoutMs, maxOutput, onOutput }) → { code, signal, stdout, stderr, timedOut, truncated }
 *       sbx.writeFile(path, data) · sbx.readFile(path) → Buffer · sbx.list(path) → [{ name, type, size }]   (workspace only)
 *       sbx.openPage(url) → { ok, url, title, text, screenshot }                                           (the browser)
 *       sbx.wipe(reason) → { reason }        Wipe now, the end of the session, or the time box
 *       sbx.ended (Promise of { reason }), sbx.state ('running' | 'wiping' | 'wiped'), sbx.id, sbx.pid, sbx.dir, sbx.cgroup
 *
 *   opts: runtimeDir (short: a socket path must fit 108 bytes), limits { memoryMb, diskMb, pids, cpuPercent }, timeBoxMs,
 *         limiter (sandbox/limits.js; null only with allowUnlimited, for tests), egress { lookup, dial, hostAddresses }
 *         (sandbox/egress-proxy.js), onEgress(decision), nodePath, browserPath, rootfs, bwrap, seccomp, log
 *
 * How it is made (sandbox/bwrap.js has the whole list): bubblewrap with its own user, pid, network, ipc, uts and cgroup
 * namespaces, a read-only root of /usr and a few /etc entries, size-limited tmpfs for /workspace, /home/agent and /tmp,
 * a cleared environment, no capabilities, the seccomp filter (sandbox/seccomp.js), in a cgroup of its own
 * (sandbox/limits.js). The only ways in or out are the supervisor's stdin/stdout (sandbox/supervisor.js) and the egress
 * proxy's socket, which the worker listens on in a directory the sandbox sees read-only.
 *
 * The wipe: SIGKILL to the cgroup and to bubblewrap (its pid namespace takes every process with it), then the proxy is
 * closed, the session's directory removed and the cgroup removed. The tmpfs areas were only ever in the sandbox's own
 * mount namespace: they are gone with it. Nothing of the sandbox is kept on the host.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { buildArgs, etcFiles } = require('./bwrap');
const { compile } = require('./seccomp');
const { createEgressProxy } = require('./egress-proxy');
const { createCdp, openPage } = require('./browser');

const SUPERVISOR = path.join(__dirname, 'supervisor.js');
const DEFAULT_LIMITS = Object.freeze({ memoryMb: 2048, diskMb: 512, pids: 256, cpuPercent: 100 });
const MAX_FRAME = 16 * 1024 * 1024;
const READY_MS = 20_000;

const procState = (pid) => {
    try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return st.slice(st.lastIndexOf(')') + 2, st.lastIndexOf(')') + 3); } catch { return null; }
};
const nsOf = (pid) => { try { return fs.readlinkSync(`/proc/${pid}/ns/pid`); } catch { return null; } };

/** The first child of a process (bubblewrap's own child is the sandbox's pid namespace init). */
function firstChild(pid) {
    try {
        const kids = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
        if (kids.length) return kids[0];
    } catch { /* no CONFIG_PROC_CHILDREN: scan */ }
    for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
            const st = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
            if (Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]) === pid) return Number(name);
        } catch { /* gone */ }
    }
    return null;
}

/** Every live process (zombies excluded) in a pid namespace, seen from the host. */
function membersOf(ns) {
    const out = [];
    for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        if (nsOf(name) === ns && procState(name) !== 'Z') out.push(Number(name));
    }
    return out;
}

/** Can this host make sandboxes? bubblewrap ≥ 0.8 and unprivileged user and network namespaces. */
async function probeSupport({ bwrap = process.env.CODES_SANDBOX_BWRAP || 'bwrap' } = {}) {
    const v = spawnSync(bwrap, ['--version'], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
    if (v.error || v.status !== 0) return { ok: false, reason: `bubblewrap is not installed (${bwrap}: ${v.error ? v.error.code : v.status}); the worker's host needs it: apt install bubblewrap` };
    const version = (String(v.stdout).match(/(\d+)\.(\d+)\.(\d+)/) || [])[0] || '0.0.0';
    const [maj, min] = version.split('.').map(Number);
    if (maj === 0 && min < 8) return { ok: false, version, reason: `bubblewrap ${version} is too old: the sandbox needs 0.8 or newer (--disable-userns, --size)` };
    const t = spawnSync(bwrap, ['--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--ro-bind', '/usr', '/usr',
        '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev',
        '--', '/usr/bin/true'], { encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin' } });
    if (t.error || t.status !== 0) {
        const why = String(t.stderr || (t.error && t.error.code) || '').trim().split('\n').pop().slice(0, 200);
        return { ok: false, version, reason: `unprivileged user namespaces are not allowed here (${why}): Ubuntu needs kernel.apparmor_restrict_unprivileged_userns=0 or an AppArmor profile for bwrap` };
    }
    return { ok: true, version, seccomp: compile() !== null, disableUserns: true };
}

function assertLimits(l) {
    const out = { ...DEFAULT_LIMITS, ...(l || {}) };
    for (const k of Object.keys(DEFAULT_LIMITS)) if (!(Number(out[k]) > 0)) throw new Error(`limit ${k} must be a positive number`);
    return out;
}

async function createSandbox(opts = {}) {
    const {
        runtimeDir, timeBoxMs = 10 * 60_000, limiter = null, allowUnlimited = false, egress = {}, onEgress = () => {},
        nodePath = process.execPath, browserPath = null, rootfs = '/', bwrap = process.env.CODES_SANDBOX_BWRAP || 'bwrap',
        seccomp = true, log = console,
    } = opts;
    if (!runtimeDir) throw new Error('runtimeDir is required');
    const limits = assertLimits(opts.limits);
    if (!limiter && !allowUnlimited) throw new Error('no limiter: a sandbox never starts without its cgroup limits');
    if (limiter && !limiter.ok) throw new Error(`the limits are not available: ${limiter.reason}`);
    const id = opts.id || crypto.randomBytes(5).toString('hex');
    if (!/^[a-z0-9-]{4,32}$/.test(id)) throw new Error('bad sandbox id');

    // The session's own directory: its /etc files and the proxy socket's directory. Owned by the worker, 0700.
    const dir = path.join(runtimeDir, `s-${id}`);
    fs.mkdirSync(dir, { mode: 0o700 });
    const etcDir = path.join(dir, 'etc');
    const netDir = path.join(dir, 'net');
    fs.mkdirSync(etcDir, { mode: 0o700 });
    fs.mkdirSync(netDir, { mode: 0o700 });
    const socketPath = path.join(netDir, 'egress.sock');
    if (Buffer.byteLength(socketPath) > 100) { fs.rmSync(dir, { recursive: true, force: true }); throw new Error(`runtimeDir is too long for a socket path: ${runtimeDir}`); }

    let proxy = null;
    let handle = null;
    let seccompFd = null;
    let child = null;
    const cleanup = async () => {
        if (proxy) await proxy.close().catch(() => {});
        if (handle) await handle.remove().catch(() => {});
        if (seccompFd != null) { try { fs.closeSync(seccompFd); } catch { /* closed */ } seccompFd = null; }
        fs.rmSync(dir, { recursive: true, force: true });
    };

    try {
        proxy = createEgressProxy({ ...egress, onDecision: (d) => { try { onEgress({ sandbox: id, ...d }); } catch { /* the log never breaks egress */ } }, log });
        await proxy.listen(socketPath);

        const filter = seccomp ? compile() : null;
        if (filter) {
            const f = path.join(dir, 'seccomp.bpf');
            fs.writeFileSync(f, filter, { mode: 0o600 });
            seccompFd = fs.openSync(f, 'r');
        }
        const built = buildArgs({
            rootfs, sessionEtc: etcDir, netDir, supervisorPath: SUPERVISOR, nodePath, browserPath,
            diskMb: limits.diskMb, shmMb: Math.min(256, limits.diskMb), seccompFd: filter ? 3 : null,
        });
        for (const [name, text] of Object.entries(etcFiles({ shell: built.shell }))) fs.writeFileSync(path.join(etcDir, name), text, { mode: 0o644 });

        // The worker's environment never reaches bubblewrap: PATH only (and the user bus for systemd-run).
        let argv = [bwrap, ...built.args];
        let env = { PATH: '/usr/bin:/bin' };
        if (limiter) {
            handle = limiter.prepare(id, limits);
            ({ argv, env } = handle.wrap(argv, env));
        }
        child = spawn(argv[0], argv.slice(1), { env, stdio: ['pipe', 'pipe', 'pipe', ...(filter ? [seccompFd] : [])], cwd: '/' });
    } catch (err) {
        if (child) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
        await cleanup();
        throw err;
    }

    const sbx = new Sandbox({ id, dir, child, proxy, handle, limits, timeBoxMs, cleanup, log, hasBrowser: !!browserPath });
    try {
        await sbx.ready();
    } catch (err) {
        await sbx.wipe('failed_to_start');
        throw err;
    }
    if (handle) handle.attach(child.pid);
    // The sandbox's pid namespace, from its init (bubblewrap's child): the wipe waits until nothing is left in it.
    const init = firstChild(child.pid);
    const ns = init ? nsOf(init) : null;
    if (ns && ns !== nsOf(process.pid)) sbx._pidns = ns;
    return sbx;
}

class Sandbox {
    constructor({ id, dir, child, proxy, handle, limits, timeBoxMs, cleanup, log, hasBrowser }) {
        Object.assign(this, { id, dir, limits, log });
        this.pid = child.pid;
        this.state = 'running';
        this.startedAt = Date.now();
        this.endsAt = this.startedAt + timeBoxMs;
        this._child = child;
        this._proxy = proxy;
        this._handle = handle;
        this._cleanup = cleanup;
        this._hasBrowser = hasBrowser;
        this._nextId = 1;
        this._pending = new Map();
        this._stderr = '';
        this._cdp = null;
        this.ended = new Promise((resolve) => { this._resolveEnded = resolve; });
        this._exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
        this._readyWaiter = null;

        let buf = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            buf += chunk;
            if (buf.length > MAX_FRAME && buf.indexOf('\n') < 0) { this.wipe('protocol'); return; }
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                this._frame(line);
            }
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (d) => { this._stderr = (this._stderr + d).slice(-4096); });
        for (const s of [child.stdin, child.stdout, child.stderr]) s.on('error', () => {});
        child.once('exit', () => { if (this.state === 'running') this.wipe('exited'); });
        this._timer = setTimeout(() => this.wipe('time_box'), timeBoxMs);
        if (this._timer.unref) this._timer.unref();
    }

    get cgroup() { return this._handle ? this._handle.path : null; }

    ready() {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`the sandbox did not start: ${this._stderr.trim().slice(-300)}`)), READY_MS);
            this._readyWaiter = (frame) => { clearTimeout(timer); resolve(frame); };
            this._exited.then(({ code, signal }) => { clearTimeout(timer); reject(new Error(`the sandbox did not start (${code}/${signal}): ${this._stderr.trim().slice(-300)}`)); });
        });
    }

    /** One line from inside. Untrusted: it is matched to a request of ours or dropped, never acted on. */
    _frame(line) {
        let f;
        try { f = JSON.parse(line); } catch { return; }
        if (!f || typeof f !== 'object') return;
        if (f.ev === 'ready' && this._readyWaiter) { const w = this._readyWaiter; this._readyWaiter = null; return w(f); }
        if (f.ev === 'cdp') { if (this._cdp && typeof f.message === 'string') this._cdp.onMessage(f.message); return; }
        if (f.ev === 'cdp-closed') { if (this._cdp) { this._cdp.close('exited'); this._cdp = null; } return; }
        const p = this._pending.get(f.id);
        if (!p) return;
        if (f.ev === 'out' && p.onOut) return p.onOut(f.fd === 2 ? 2 : 1, Buffer.from(String(f.data || ''), 'base64'));
        if (f.ev === 'exit' || f.ev === 'done') { this._pending.delete(f.id); p.resolve(f); }
    }

    _request(msg, { onOut } = {}) {
        if (this.state !== 'running') return Promise.reject(new Error(`the sandbox is ${this.state === 'wiping' ? 'being wiped' : 'wiped'}`));
        const id = this._nextId++;
        return new Promise((resolve, reject) => {
            this._pending.set(id, { resolve, reject, onOut });
            this._child.stdin.write(`${JSON.stringify({ ...msg, id })}\n`);
        });
    }

    /** The terminal: a command inside, with its output (capped) and how it ended. */
    async exec(argv, { stdin = null, tty = false, cwd, env, timeoutMs = 60_000, maxOutput = 1024 * 1024, onOutput } = {}) {
        if (!Array.isArray(argv) || !argv.length) throw new Error('argv is a non-empty array');
        const out = [[], []];
        const sizes = [0, 0];
        const onOut = (fd, buf) => {
            const k = fd === 2 ? 1 : 0;
            if (sizes[k] < maxOutput) { out[k].push(buf.subarray(0, maxOutput - sizes[k])); sizes[k] += buf.length; }
            if (onOutput) { try { onOutput(fd, buf); } catch { /* the caller's problem */ } }
        };
        const f = await this._request({
            op: 'exec', argv: argv.map(String), tty: !!tty, cwd, env, timeoutMs, maxOutput,
            ...(stdin != null ? { stdin: Buffer.from(stdin).toString('base64') } : {}),
        }, { onOut });
        return {
            code: typeof f.code === 'number' ? f.code : null, signal: typeof f.signal === 'string' ? f.signal : null,
            stdout: Buffer.concat(out[0]).toString('utf8'), stderr: Buffer.concat(out[1]).toString('utf8'),
            timedOut: f.timedOut === true, truncated: f.truncated === true, ...(f.error ? { error: String(f.error).slice(0, 200) } : {}),
        };
    }

    async _file(msg) {
        const f = await this._request(msg);
        if (!f.ok) throw new Error(String(f.error || 'failed').slice(0, 200));
        return f;
    }

    /** The editor: files in the workspace only (the supervisor refuses a path outside it). */
    async writeFile(p, data) { await this._file({ op: 'write', path: String(p), data: Buffer.from(data).toString('base64') }); }
    async readFile(p) { return Buffer.from(String((await this._file({ op: 'read', path: String(p) })).data || ''), 'base64'); }
    async list(p = '/workspace') {
        const f = await this._file({ op: 'list', path: String(p) });
        return (Array.isArray(f.entries) ? f.entries : []).map((e) => ({ name: String(e.name), type: String(e.type), size: e.size == null ? null : Number(e.size) }));
    }

    /** The browser: headless Chromium inside, on the egress proxy. */
    async openPage(url, opts = {}) {
        if (!this._hasBrowser) throw new Error('this sandbox has no browser');
        if (!this._cdp) {
            const f = await this._request({ op: 'browser', action: 'start' });
            if (!f.ok) throw new Error(`the browser did not start: ${String(f.error || '').slice(0, 200)}`);
            this._cdp = createCdp((message) => { if (this.state === 'running') this._child.stdin.write(`${JSON.stringify({ op: 'cdp', message })}\n`); });
            // The browser answers once its pipe is open.
            const until = Date.now() + 15_000;
            for (;;) {
                try { await Promise.race([this._cdp.call('Browser.getVersion'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]); break; } catch (err) {
                    if (Date.now() > until) throw new Error(`the browser did not answer: ${err.message}`);
                }
            }
        }
        try {
            return await openPage(this._cdp, url, opts);
        } catch (err) {
            return { ok: false, url, error: String(err.message).slice(0, 200) };
        }
    }

    /** Wipe now (or the end, or the time box): everything of the sandbox goes, and nothing of it is kept. */
    wipe(reason = 'wipe_now') {
        if (this._wiping) return this._wiping;
        this.state = 'wiping';
        clearTimeout(this._timer);
        this._wiping = (async () => {
            if (this._cdp) { this._cdp.close(reason); this._cdp = null; }
            if (this._handle) { try { this._handle.kill(); } catch { /* gone */ } }
            try { this._child.kill('SIGKILL'); } catch { /* gone */ }
            await Promise.race([this._exited, new Promise((r) => setTimeout(r, 5000))]);
            // bubblewrap's death takes its pid namespace with it; make sure, and kill any straggler by hand.
            let leftover = [];
            if (this._pidns) {
                const until = Date.now() + 5000;
                for (;;) {
                    leftover = membersOf(this._pidns);
                    if (!leftover.length || Date.now() > until) break;
                    for (const pid of leftover) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
                    await new Promise((r) => setTimeout(r, 25));
                }
                if (leftover.length) this.log.error(`[sandbox] ${this.id}: ${leftover.length} process(es) outlived the wipe`);
            }
            for (const p of this._pending.values()) p.reject(new Error(`the sandbox was wiped (${reason})`));
            this._pending.clear();
            try { await this._cleanup(); } catch (err) { this.log.error('[sandbox] cleanup:', err.message); }
            this.state = 'wiped';
            const out = { reason, ...(leftover.length ? { leftover: leftover.length } : {}) };
            this._resolveEnded(out);
            return out;
        })();
        return this._wiping;
    }

    info() {
        return { id: this.id, state: this.state, started_at: new Date(this.startedAt).toISOString(), ends_at: new Date(this.endsAt).toISOString(), limits: this.limits };
    }
}

module.exports = { probeSupport, createSandbox, DEFAULT_LIMITS, SUPERVISOR };
