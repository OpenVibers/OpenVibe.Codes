'use strict';
/**
 * The chat plays sandbox's limits: CPU, memory and process count come from a cgroup v2 of the sandbox's own (rlimits
 * cannot do it: in a user namespace RLIMIT_NPROC still counts every process of the host user, and RLIMIT_AS breaks a
 * browser). Disk is the size of the sandbox's tmpfs areas (sandbox/bwrap.js), charged to that cgroup's memory too;
 * the wall clock is the session's time box (sandbox/session.js).
 *
 * Two ways to get the cgroup, both unprivileged:
 *
 *   cgroup        the worker's systemd unit has Delegate=yes (deploy/sandbox/openvibe-codes-sandbox.service): the
 *                 worker owns its cgroup subtree. It moves itself into <unit>/worker, turns on the cpu, memory and pids
 *                 controllers for the children, and makes <unit>/sbx-<id> per sandbox. The sandbox's first process
 *                 writes itself into it before it executes bubblewrap, so nothing of the sandbox ever runs outside it.
 *   systemd-user  a workstation: `systemd-run --user --scope` makes a transient scope with MemoryMax, TasksMax and
 *                 CPUQuota per sandbox (the user's systemd delegates cpu, memory and pids).
 *
 *   detectLimits({ mode: 'auto' | 'cgroup' | 'systemd-user' | 'none' }) → limiter { kind, ok, reason, prepare }
 *   limiter.prepare(id, { memoryMb, diskMb, pids, cpuPercent }) → handle
 *     handle.wrap(argv, env) → { argv, env }    the command that starts the sandbox inside its cgroup
 *     handle.attach(pid)                        learns the cgroup's path once the sandbox runs (systemd-user)
 *     handle.path                               the cgroup's directory (null until known)
 *     handle.kill()                             SIGKILL to everything in the cgroup (cgroup.kill)
 *     await handle.remove()                     waits for it to be empty and removes it
 *
 * The memory limit is memory + the three tmpfs areas (workspace, home, /tmp): tmpfs pages are charged to the cgroup that
 * wrote them, so a full disk must not count against the processes' own memory.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CONTROLLERS = ['cpu', 'memory', 'pids'];
const CPU_PERIOD = 100_000;
const MB = 1024 * 1024;

const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };
const write = (f, v) => fs.writeFileSync(f, String(v));

/** The memory.max, pids.max and cpu.max values for a sandbox's limits. */
function values({ memoryMb, diskMb, pids, cpuPercent }) {
    const memory = Math.round((Number(memoryMb) + 3 * Number(diskMb)) * MB);
    const quota = Math.max(1000, Math.round(Number(cpuPercent) * CPU_PERIOD / 100));
    return { memory, pids: Math.max(1, Math.round(Number(pids))), cpu: `${quota} ${CPU_PERIOD}`, cpuPercent: Number(cpuPercent) };
}

/** This process's own cgroup v2 path (the unified hierarchy's line in /proc/self/cgroup). */
function ownCgroup(root) {
    const line = read('/proc/self/cgroup').split('\n').find((l) => l.startsWith('0::'));
    return line ? path.join(root, line.slice(3)) : null;
}

const missingControllers = (dir) => {
    const have = read(path.join(dir, 'cgroup.controllers')).split(/\s+/);
    return CONTROLLERS.filter((c) => !have.includes(c));
};

async function waitEmpty(dir, ms = 5000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        const events = read(path.join(dir, 'cgroup.events'));
        if (!events || /populated 0/.test(events)) return true;
        await new Promise((r) => setTimeout(r, 25));
    }
    return false;
}

function killCgroup(dir) {
    if (!dir) return;
    try { write(path.join(dir, 'cgroup.kill'), '1'); return; } catch { /* before Linux 5.14: one by one */ }
    for (const pid of read(path.join(dir, 'cgroup.procs')).split('\n').filter(Boolean)) {
        try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ }
    }
}

/** The delegated subtree of the worker's systemd unit (Delegate=yes). */
function tryDelegated(root) {
    let own = ownCgroup(root);
    if (!own) return { ok: false, reason: 'no cgroup v2 (unified hierarchy) for this process' };
    // A worker that already moved itself (a second detect in the same process) sits in <base>/worker.
    const base = path.basename(own) === 'worker' && fs.existsSync(path.join(path.dirname(own), 'cgroup.subtree_control')) ? path.dirname(own) : own;
    const missing = missingControllers(base);
    if (missing.length) return { ok: false, reason: `the worker's cgroup has no ${missing.join(', ')} controller (its systemd unit needs Delegate=yes)` };
    try {
        fs.accessSync(base, fs.constants.W_OK);
        fs.accessSync(path.join(base, 'cgroup.procs'), fs.constants.W_OK);
        fs.accessSync(path.join(base, 'cgroup.subtree_control'), fs.constants.W_OK);
    } catch {
        return { ok: false, reason: `the worker may not write its cgroup ${base} (its systemd unit needs Delegate=yes)` };
    }
    const others = read(path.join(base, 'cgroup.procs')).split('\n').filter(Boolean).map(Number).filter((p) => p !== process.pid);
    if (others.length) return { ok: false, reason: `the worker's cgroup ${base} holds other processes: it needs one of its own (Delegate=yes)` };
    const leaf = path.join(base, 'worker');
    try {
        if (own !== leaf) {
            fs.mkdirSync(leaf, { recursive: true });
            write(path.join(leaf, 'cgroup.procs'), process.pid);
            own = leaf;
        }
        const enabled = read(path.join(base, 'cgroup.subtree_control')).split(/\s+/);
        const todo = CONTROLLERS.filter((c) => !enabled.includes(c));
        if (todo.length) write(path.join(base, 'cgroup.subtree_control'), todo.map((c) => `+${c}`).join(' '));
    } catch (err) {
        return { ok: false, reason: `the worker could not set up its cgroup subtree: ${err.code || err.message}` };
    }
    return {
        kind: 'cgroup', ok: true, base,
        prepare(id, limits) {
            const v = values(limits);
            const dir = path.join(base, `sbx-${id}`);
            fs.mkdirSync(dir);
            write(path.join(dir, 'memory.max'), v.memory);
            try { write(path.join(dir, 'memory.swap.max'), 0); } catch { /* no swap accounting: no swap to limit */ }
            write(path.join(dir, 'pids.max'), v.pids);
            write(path.join(dir, 'cpu.max'), v.cpu);
            // An out-of-memory kills the process that asked, not the whole sandbox (the agent sees it and goes on).
            try { write(path.join(dir, 'memory.oom.group'), 0); } catch { /* older kernels: the default is 0 */ }
            return {
                path: dir,
                // The first process moves itself (`echo 0` is "the writer") into the cgroup, then becomes bubblewrap.
                wrap: (argv, env) => ({ argv: ['/bin/sh', '-c', 'echo 0 > "$0" && exec "$@"', path.join(dir, 'cgroup.procs'), ...argv], env }),
                attach() {},
                kill: () => killCgroup(dir),
                async remove() {
                    if (!(await waitEmpty(dir))) { killCgroup(dir); await waitEmpty(dir); }
                    try { fs.rmdirSync(dir); } catch (err) { if (err.code !== 'ENOENT') throw err; }
                },
            };
        },
    };
}

/** A transient scope of the user's systemd per sandbox (a workstation; the worker's own unit uses the delegated way). */
function trySystemdUser(root) {
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (!runtime || !fs.existsSync(path.join(runtime, 'systemd'))) return { ok: false, reason: 'no user systemd (XDG_RUNTIME_DIR/systemd)' };
    const uid = process.getuid();
    const manager = path.join(root, `user.slice/user-${uid}.slice/user@${uid}.service`);
    const missing = missingControllers(manager);
    if (!fs.existsSync(manager) || missing.length) return { ok: false, reason: `the user's systemd does not delegate ${missing.join(', ') || 'a cgroup'}` };
    const env = { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: runtime, ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}) };
    const probe = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', '-p', 'TasksMax=4', '--', '/bin/true'], { env, timeout: 10_000, encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return { ok: false, reason: `systemd-run --user --scope failed: ${(probe.stderr || (probe.error && probe.error.code) || '').trim().slice(0, 200)}` };
    return {
        kind: 'systemd-user', ok: true,
        prepare(id, limits) {
            const v = values(limits);
            const unit = `ovsbx-${id}`;
            const handle = {
                path: null, unit,
                wrap: (argv, baseEnv) => ({
                    argv: ['systemd-run', '--user', '--scope', '--quiet', '--collect', '--unit', unit,
                        '-p', `MemoryMax=${v.memory}`, '-p', 'MemorySwapMax=0', '-p', `TasksMax=${v.pids}`, '-p', `CPUQuota=${v.cpuPercent}%`, '-p', 'OOMPolicy=continue', '--', ...argv],
                    env: { ...baseEnv, ...env },
                }),
                // systemd-run --scope executes the command in place: the sandbox's first process is in the scope.
                attach(pid) {
                    const line = read(`/proc/${pid}/cgroup`).split('\n').find((l) => l.startsWith('0::'));
                    if (line && line.includes(unit)) handle.path = path.join(root, line.slice(3));
                },
                kill() {
                    if (handle.path) return killCgroup(handle.path);
                    spawnSync('systemctl', ['--user', 'kill', '--signal=SIGKILL', `${unit}.scope`], { env, timeout: 5000 });
                },
                async remove() {
                    if (!handle.path) return;
                    if (!(await waitEmpty(handle.path))) { handle.kill(); await waitEmpty(handle.path); }
                    // systemd collects the scope once it is empty (--collect).
                    const until = Date.now() + 5000;
                    while (fs.existsSync(handle.path) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
                },
            };
            return handle;
        },
    };
}

async function detectLimits({ mode = 'auto', cgroupRoot = '/sys/fs/cgroup' } = {}) {
    if (mode === 'none') return { kind: 'none', ok: false, reason: 'limits are turned off (CODES_SANDBOX_LIMITS=none)' };
    if (mode === 'cgroup') return { kind: 'cgroup', ...tryDelegated(cgroupRoot) };
    if (mode === 'systemd-user') return { kind: 'systemd-user', ...trySystemdUser(cgroupRoot) };
    const delegated = tryDelegated(cgroupRoot);
    if (delegated.ok) return delegated;
    const user = trySystemdUser(cgroupRoot);
    if (user.ok) return user;
    return { kind: 'none', ok: false, reason: `${delegated.reason}; ${user.reason}` };
}

module.exports = { detectLimits, values, CONTROLLERS };
