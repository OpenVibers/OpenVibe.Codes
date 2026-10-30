'use strict';
// Every job and chat turn runs in its own systemd scope inside ovjobs.slice (2026-10-30).
//
// Why: an agent that starts a server in the background (`node server/index.js &`, setsid, nohup) leaves it behind when
// its shell exits. The server is reparented to the user's systemd, so it is no longer in the job's process group or
// tree and procgroup.stopTree never sees it. Fifteen such servers and headless browsers (8-16 h old, ~7 GB) ran the
// workstation out of memory on 2026-10-30 01:38 UTC: the kernel killed the IDE, the portal and every running job.
//
// A scope is a cgroup: everything the job starts stays in it, however it detaches. When the job's own process is gone,
// reap() stops the scope, which ends whatever is left. ovjobs.slice caps all jobs together (MemoryHigh 15G, MemoryMax
// 18G) and each scope caps one job (6G/8G, OOMPolicy=continue: an out-of-memory kill takes one process, like a test
// runner, not the whole job), so no job can take the machine down again.
//
// `systemd-run --scope` execs the command in place: the pid, process group, cwd, env and stdio are the same as a
// plain spawn, so the rest of the runner (pid files, stopTree) is unchanged. Without systemd-run (or a user manager)
// wrap() returns the command as it was, and this module does nothing anywhere but Linux.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const SLICE = 'ovjobs.slice';
const PER_JOB = ['-p', 'MemoryHigh=6G', '-p', 'MemoryMax=8G', '-p', 'OOMPolicy=continue', '-p', 'TimeoutStopSec=15'];

// Where the map of scopes lives: which process leads which scope, so reap() knows when a job itself is over.
const MAP = process.env.OV_JOB_SCOPE_MAP || path.join(os.homedir(), '.openvibe-codes', 'job-scopes.json');

let usable = null;

/** Are scopes available here? (Linux with a systemd user manager: false everywhere else.) */
function available() {
    if (usable !== null) return usable;
    if (process.platform !== 'linux') return (usable = false);
    if (process.env.OV_NO_JOB_SCOPES) return (usable = false);
    try {
        execFileSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--slice=${SLICE}`, '--', 'true'], { timeout: 8000, stdio: 'ignore' });
        usable = true;
    } catch { usable = false; }
    return usable;
}

const unitName = (label) => `ovjob-${String(label || 'job').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 90)}-${Date.now().toString(36)}.scope`;

/**
 * The command to spawn instead of (cmd, args), and the scope it will run in (null when scopes are not available).
 *
 * @param {string} cmd the command
 * @param {string[]} args its arguments
 * @param {string} label a name for the scope
 * @returns {{cmd: string, args: string[], unit: string|null}} what to spawn
 */
function wrap(cmd, args, label) {
    if (!available()) return { cmd, args, unit: null };
    const unit = unitName(label);
    return {
        cmd: 'systemd-run',
        args: ['--user', '--scope', '--quiet', '--collect', `--unit=${unit.replace(/\.scope$/, '')}`, `--slice=${SLICE}`, `--description=ovjob ${label}`, ...PER_JOB, '--', cmd, ...args],
        unit,
    };
}

function load() { try { return JSON.parse(fs.readFileSync(MAP, 'utf8')); } catch { return {}; } }
function save(map) {
    try {
        fs.mkdirSync(path.dirname(MAP), { recursive: true });
        fs.writeFileSync(`${MAP}.tmp`, JSON.stringify(map));
        fs.renameSync(`${MAP}.tmp`, MAP);
    } catch { /* best effort */ }
}

/** Record which process leads a scope, so reap() knows when the job itself is over. */
function remember(unit, pid, label) {
    if (!unit || !(pid > 1)) return;
    const map = load();
    map[unit] = { pid, label: label || '', at: Date.now() };
    save(map);
}

const run = (args) => new Promise((resolve) => execFile('systemctl', ['--user', ...args], { timeout: 20000 }, (e, out) => resolve(e ? null : String(out || ''))));

// The scope's leader is still the job: alive and still in that cgroup (a reused pid is somebody else).
function leads(pid, unit) {
    try { return fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').includes(`/${unit}`); } catch { return false; }
}

/**
 * Stop every scope whose job has ended, ending what it left behind.
 *
 * @param {object} [opts]
 * @param {Function} [opts.log] where the notice goes
 * @returns {Promise<string[]>} the scopes stopped
 */
async function reap({ log = () => {} } = {}) {
    if (!available()) return [];
    const out = await run(['list-units', '--type=scope', '--plain', '--no-legend', '--all', 'ovjob-*']);
    if (out === null) return [];
    const live = new Set(out.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((u) => /^ovjob-.*\.scope$/.test(u)));
    const map = load();
    const stopped = [];
    for (const [unit, rec] of Object.entries(map)) {
        if (!live.has(unit)) { delete map[unit]; continue; }          // gone already (nothing was left behind)
        if (leads(rec.pid, unit)) continue;                            // the job is still running
        if (await run(['stop', unit]) !== null) { stopped.push(unit); delete map[unit]; log(`jobscope: ${rec.label || unit} ended; stopped its scope (left-behind processes)`); }
    }
    save(map);
    return stopped;
}

/** Stop one job's scope now (the owner pressed Stop, or the budget ended it). */
async function stopFor(pid) {
    const map = load();
    for (const [unit, rec] of Object.entries(map)) if (rec.pid === Number(pid)) { await run(['stop', unit]); delete map[unit]; save(map); return unit; }
    return null;
}

module.exports = { available, wrap, remember, reap, stopFor, SLICE, MAP };
