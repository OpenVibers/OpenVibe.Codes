'use strict';

/**
 * Per-turn checkpoints in a job's clone: before each model turn (really before each tool batch, which is the closest
 * boundary the stream shows) the working tree is written to a git commit and pinned under
 * `refs/codes/checkpoints/<task>/<run>/<n>`. Nothing is committed to a branch and nothing is pushed: the refs are the
 * run's own history, and the job's clone is thrown away after it.
 *
 *   const cp = createCheckpoints({ cwd, task, run });
 *   cp.capture('start');                    // n = 0, the clone as the agent found it
 *   cp.authored(['src/user.js']);           // paths this turn's tools wrote
 *   cp.capture('turn');                     // n = 1, after the turn
 *   cp.diff(0, 1);                          // { files: [{ path, status, added, removed, authored }], … }
 *   cp.restore(0);                          // put the worktree back to the last good turn (the repair path)
 *
 * The diff marks a path **authored** when a tool call named it in the turn and **imported** otherwise (a patch applied,
 * a dependency install, a formatter or a subagent): the first is the agent's work, the second is something that came
 * from elsewhere, and a review should be told them apart.
 *
 * A checkpoint is built with a temporary index (`GIT_INDEX_FILE`) so it never touches the run's own index:
 * `read-tree HEAD` → `add -A` → `write-tree` → `commit-tree` with the previous checkpoint as parent → `update-ref`.
 * `.gitignore` and `.git/info/exclude` still apply, so build output, node_modules and the owner's `.openvibe/` files
 * stay out.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/** A cap on a run's refs and on a diff's rows, so a very long turn cannot flood the result. */
const MAX_TURNS = 200;
const MAX_FILES = 100;

/** git in the worktree, no prompt and no credential helper; a failure names the command and the last line. */
function git(cwd, args, env = {}) {
    try {
        return execFileSync('git', args, {
            cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (error) {
        const said = String(error.stderr || error.message || '').trim().split('\n').slice(-2).join(' ');
        const err = new Error(`checkpoint: git ${args[0]} failed: ${said}`);
        err.code = 'checkpoint.git';
        throw err;
    }
}

/** A ref path component that git accepts and that a person can read back (a task id is already safe). */
function safeName(value) {
    return String(value == null ? '' : value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'run';
}

/** The file paths a harness event wrote, from its tool calls (Claude Code's names are the shared vocabulary). */
function toolPaths(event) {
    const out = [];
    if (!event || event.type !== 'assistant') return out;
    for (const c of (event.message && event.message.content) || []) {
        if (!c || c.type !== 'tool_use') continue;
        const i = c.input && typeof c.input === 'object' ? c.input : {};
        for (const key of ['file_path', 'path', 'notebook_path']) if (typeof i[key] === 'string' && i[key]) out.push(i[key]);
        // A patch helper names its files in a list; an edit may carry a list of edits for one path.
        if (Array.isArray(i.files)) out.push(...i.files.filter((f) => typeof f === 'string'));
    }
    return out;
}

/**
 * The checkpoints of one run.
 *
 * @param {object} opts
 * @param {string} opts.cwd the clone
 * @param {string} [opts.task] the task id (the ref's first component)
 * @param {string} [opts.run] the run id (the ref's second component)
 * @param {number} [opts.maxTurns] the most refs one run writes
 * @param {number} [opts.maxFiles] the most rows one diff carries
 * @param {() => number} [opts.now]
 */
function createCheckpoints({ cwd, task = 'task', run = 'run', maxTurns = MAX_TURNS, maxFiles = MAX_FILES, now = Date.now } = {}) {
    const root = `refs/codes/checkpoints/${safeName(task)}/${safeName(run)}`;
    const entries = [];
    const pending = new Set();
    // Every path a tool has named in this run: a diff marks a file authored if the agent touched it, however many
    // turns the write and the event that reports it fall apart by (a CLI prints the call before or after it runs).
    const named = new Set();

    const head = () => git(cwd, ['rev-parse', 'HEAD']).trim();

    /**
     * Capture the worktree now as checkpoint `n`. The parent is the previous checkpoint (or HEAD for the first), so the
     * chain is inspectable with `git log`. The paths tools wrote since the previous capture are this checkpoint's
     * authored set.
     *
     * @param {string} [label] what the capture marks (start, turn, final)
     * @returns {object|null} the entry, or null once the cap is reached
     */
    function capture(label = 'turn') {
        if (entries.length >= maxTurns) return null;
        const n = entries.length;
        const index = path.join(os.tmpdir(), `codes-index-${process.pid}-${Date.now()}-${n}`);
        const env = { GIT_INDEX_FILE: index };
        try {
            git(cwd, ['read-tree', 'HEAD'], env);
            git(cwd, ['add', '-A'], env);
            const tree = git(cwd, ['write-tree'], env).trim();
            const parent = entries.length ? entries[entries.length - 1].sha : head();
            const sha = git(cwd, [
                '-c', 'user.name=OpenVibe.Codes', '-c', 'user.email=codes@openvibe.codes',
                'commit-tree', tree, '-p', parent, '-m', `codes checkpoint ${n} ${label}`,
            ]).trim();
            const ref = `${root}/${n}`;
            git(cwd, ['update-ref', ref, sha]);
            const entry = { n, ref, sha, tree, label, at: new Date(now()).toISOString(), authored: [...pending] };
            pending.clear();
            entries.push(entry);
            return entry;
        } finally {
            try { fs.rmSync(index, { force: true }); } catch { /* the temp index is best effort */ }
        }
    }

    /** The paths the current turn's tools wrote: a per-turn snapshot, and the run's cumulative authored set. */
    function authored(paths) {
        for (const p of paths || []) if (p) { pending.add(String(p)); named.add(String(p)); }
    }

    /** Resolve a checkpoint by number, ref or sha. */
    function entryOf(which) {
        if (which && typeof which === 'object') return which;
        return entries.find((e) => e.n === Number(which) || e.ref === which || e.sha === which) || null;
    }

    /**
     * The diff one turn made, with its paths split by provenance.
     *
     * @param {number|string|object} from checkpoint n / ref / sha
     * @param {number|string|object} to checkpoint n / ref / sha
     * @returns {{from: number|null, to: number|null, files: object[], files_total: number, authored: number, imported: number}}
     */
    function diff(from, to) {
        const a = entryOf(from);
        const b = entryOf(to);
        const empty = { from: a ? a.n : null, to: b ? b.n : null, files: [], files_total: 0, authored: 0, imported: 0 };
        if (!a || !b) return empty;
        const status = git(cwd, ['diff', '--name-status', '--find-renames', a.sha, b.sha]).trim();
        if (!status) return empty;
        const stats = new Map();
        for (const row of git(cwd, ['diff', '--numstat', a.sha, b.sha]).trim().split('\n').filter(Boolean)) {
            const [added, removed, p] = row.split('\t');
            if (p == null) continue;
            // A rename's numstat path is `old => new` (or `{old => new}` for a shared prefix): keep the newest path.
            const file = p.includes(' => ') ? p.replace(/^.* => /, '').replace(/[{}]/g, '').trim() : p;
            stats.set(file, { added: Number(added) || 0, removed: Number(removed) || 0 });
        }
        const authoredSet = named;
        const files = [];
        for (const line of status.split('\n')) {
            const parts = line.split('\t');
            const code = String(parts[0] || '').charAt(0);
            const file = code === 'R' || code === 'C' ? parts[2] : parts[1];
            if (!file) continue;
            const nums = stats.get(file) || { added: 0, removed: 0 };
            files.push({ path: file, status: code, added: nums.added, removed: nums.removed, authored: authoredSet.has(file) || (code === 'R' && authoredSet.has(parts[1])) });
        }
        const authored = files.filter((f) => f.authored).length;
        return { from: a.n, to: b.n, files: files.slice(0, maxFiles), files_total: files.length, authored, imported: files.length - authored };
    }

    /**
     * Put the worktree back to a checkpoint: index and tracked files from its tree, then the untracked files a broken
     * turn left are cleaned (ignored files, including `.openvibe/`, stay).
     *
     * @param {number|string|object} which checkpoint n / ref / sha
     * @returns {{n: number, ref: string, sha: string}|null}
     */
    function restore(which) {
        const entry = entryOf(which);
        if (!entry) return null;
        git(cwd, ['read-tree', '--reset', '-u', entry.sha]);
        try { git(cwd, ['clean', '-fdq']); } catch { /* a clean failure leaves the restored tree as is */ }
        return { n: entry.n, ref: entry.ref, sha: entry.sha };
    }

    /** The refs written, oldest first, without the paths (a result carries the diffs separately). */
    function list() {
        return entries.map((e) => ({ n: e.n, ref: e.ref, sha: e.sha, label: e.label, at: e.at }));
    }

    /** The last checkpoint (the last good state before the current turn). */
    function last() {
        return entries[entries.length - 1] || null;
    }

    /** Every turn's diff from the previous checkpoint, one row per ref after the first. */
    function turns() {
        const out = [];
        for (let i = 1; i < entries.length; i++) {
            const d = diff(entries[i - 1], entries[i]);
            out.push({ n: entries[i].n, ref: entries[i].ref, sha: entries[i].sha, label: entries[i].label, at: entries[i].at, ...d });
        }
        return out;
    }

    return { root, capture, authored, diff, restore, list, last, turns, entries, safeName };
}

module.exports = { createCheckpoints, toolPaths, safeName, MAX_TURNS, MAX_FILES };
