'use strict';

/**
 * What every adapter does the same way.
 *
 * An adapter is one harness: it says how to start its CLI (the argv and the environment the portal's runner scripts
 * use), how to read what that CLI prints (the feed converter, so the transcript normaliser sees one shape) and what its
 * own limits are (the reasoning levels it accepts).
 *
 * The argv and the environment come from the portal's runner scripts, not from guesswork:
 *
 *   cc-run.sh   Command Code      cmd --print=… --yolo -m … --effort … --output-format json --max-turns …
 *   cx-run.sh   Codex             codex exec --json --skip-git-repo-check -C … -s … -c model_reasoning_effort=…
 *   cm-run.sh   Claude Code       claude -p --output-format stream-json --verbose --max-turns … --permission-mode …
 *   mm-run.sh   MiniMax Code      mcode exec --input - --output-format stream-json --prompt-mode coding --permission …
 *   oc-run.sh   OpenCode          opencode run --standalone --format json --auto -m …
 *
 * An adapter never pushes, never commits and never opens a pull request: that is the person's call.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { ORDER } = require('../effort');
const { scrubDeep } = require('../redact');

/** No limit: the turn cap a harness gets when the owner set none (the portal's 100000). */
const NO_TURN_CAP = 100000;

/**
 * The harness's own turn cap, from the task's limits (Settings → Limits): the portal's `--max-turns` value.
 * A missing or zero cap means no limit, never the old 150/200 hard-coded ones.
 *
 * @param {number|string} [value] the cap the job runner derived (steps + 25, or none)
 * @returns {string} the number the CLI's argv carries
 */
function turnCap(value) {
    const n = Number(value);
    return String(Number.isFinite(n) && n > 0 ? Math.round(n) : NO_TURN_CAP);
}

/**
 * Whether this machine has the shared Know MCP server (`ov_know`) registered for Claude Code, so the harness may call
 * its tools (`mcp__ov_know`): `~/.claude.json` → `mcpServers.ov_know`, the portal's own registration.
 *
 * @param {object} [opts]
 * @param {string} [opts.file] the Claude Code config to read (a test, or a Node's own path)
 * @returns {boolean} true when the server is registered
 */
function knowRegistered({ file } = {}) {
    const config = file || process.env.OPENVIBE_CLAUDE_CONFIG || path.join(os.homedir(), '.claude.json');
    try {
        const doc = JSON.parse(fs.readFileSync(config, 'utf8'));
        return !!(doc && doc.mcpServers && doc.mcpServers.ov_know);
    } catch { return false; }
}

/** The reasoning levels each harness accepts (the portal's ds-limits.js / engine/effort.js). */
const EFFORT_LEVELS = {
    'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-other': ['low', 'medium', 'high', 'xhigh', 'max'],
    codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    'command-code': ['off', 'low', 'high', 'max'],
    opencode: [],
    aider: ['low', 'medium', 'high'],
    'minimax-code': ['low', 'medium', 'high', 'xhigh', 'max'],
};

/**
 * The effort this harness may take.
 *
 * The 2026-10-29 incident: a job retried on another harness copied Codex's "medium" to Command Code, which died
 * before its first step ("Unknown effort \"medium\". Supported: off, low, high, max."). The level is fitted to the
 * harness, never handed over as it came.
 *
 * @param {string} id the harness
 * @param {string|null} effort the wanted level
 * @returns {string|null} a level the harness accepts
 */
function effortFor(id, effort) {
    const levels = EFFORT_LEVELS[id] || [];
    if (!effort || !levels.length) return effort;
    if (levels.includes(effort)) return effort;
    // The nearest level this harness accepts (a tie goes up), over the portal's own ordering.
    const at = ORDER.indexOf(effort);
    if (at < 0) return effort;
    for (let d = 0; d < ORDER.length; d++) {
        for (const i of [at + d, at - d]) if (levels.includes(ORDER[i])) return ORDER[i];
    }
    return effort;
}

/** The environment every adapter's child gets: the parent's, plus what the adapter adds. */
function childEnv(extra = {}) {
    const env = { ...process.env, ...extra };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    return env;
}

/**
 * Run a CLI and read its stdout, line by line.
 *
 * @param {object} opts
 * @param {string} opts.cmd the executable
 * @param {string[]} opts.argv its arguments
 * @param {string} [opts.cwd] the working directory
 * @param {object} [opts.env] the environment
 * @param {string} [opts.stdin] what the CLI reads (the brief, for the harnesses that take it on stdin)
 * @param {number} [opts.timeoutMs] how long it may run; 0 (the default) is no limit
 * @param {AbortSignal} [opts.signal] stops it
 * @param {function} opts.onLine every stdout line
 * @param {function} [opts.onEnd] when the process ended ({ code, signal, timedOut, stderr })
 * @returns {{cancel: function, done: Promise<object>}} the run
 */
function runCli({ cmd, argv, cwd, env, stdin, timeoutMs = 0, signal, onLine, onEnd }) {
    let child;
    let stderrBuf = '';
    let timedOut = false;
    let cancelled = false;
    const done = new Promise((resolve) => {
        const finish = (info) => {
            try { if (onEnd) onEnd(info); } catch { /* the reader's own error never hides the run */ }
            resolve(info);
        };
        try {
            child = spawn(cmd, argv, { cwd, env: childEnv(env), stdio: [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
        } catch (err) {
            finish({ code: null, signal: null, timedOut: false, stderr: '', spawnError: err.message });
            return;
        }
        const cancel = () => {
            if (!child || child.exitCode !== null || child.signalCode || cancelled) return;
            cancelled = true;
            try { child.kill('SIGTERM'); } catch { /* gone */ }
            setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5000).unref();
        };
        // A wall clock the owner set (the cap is its limit plus five minutes); no limit is no timer at all.
        const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; cancel(); }, timeoutMs) : null;
        if (timer) timer.unref();
        if (signal) {
            if (signal.aborted) cancel();
            else signal.addEventListener('abort', cancel, { once: true });
        }
        if (stdin != null) { child.stdin.on('error', () => { /* the CLI may not read it */ }); child.stdin.end(stdin); }
        readline.createInterface({ input: child.stdout }).on('line', (raw) => {
            try { onLine(raw); } catch { /* one odd line never stops the run */ }
        });
        readline.createInterface({ input: child.stderr }).on('line', (raw) => {
            stderrBuf = (stderrBuf + raw + '\n').slice(-8000);
        });
        child.on('error', (err) => { clearTimeout(timer); finish({ code: null, signal: null, timedOut, stderr: stderrBuf, spawnError: err.message }); });
        child.on('close', (code, sig) => { clearTimeout(timer); finish({ code, signal: sig, timedOut, stderr: stderrBuf, cancelled }); });
    });
    return { cancel: () => { if (child) { try { child.kill('SIGTERM'); } catch { /* gone */ } } }, done };
}

/**
 * A feed converter: the harness's own lines into the one shape the transcript normaliser reads
 * (Claude Code's stream-json, which is what the portal's feed converters produce).
 *
 * @param {object} opts
 * @param {string} opts.model the model in play
 * @param {function} [opts.onEvent] every event, already scrubbed
 * @returns {{line: function, end: function, state: object}} the converter
 */
function claudeFeed({ model, onEvent = () => {} }) {
    const state = { sessionId: null, model, lastText: '', failed: null, usage: null, turns: 0, tools: new Set(), done: new Set() };
    const emit = (o) => onEvent(scrubDeep({ ...o, _ts: Date.now() }));
    return {
        state,
        line(raw) {
            let f; try { f = JSON.parse(raw); } catch { if (String(raw).trim()) emit({ type: 'system', subtype: 'stderr', text: String(raw).slice(0, 500) }); return; }
            if (!f || typeof f !== 'object') return;
            const t = f.type;
            if (t === 'system') {
                if (f.subtype === 'init') { state.sessionId = f.session_id || state.sessionId; state.model = f.model || state.model; emit(f); }
                else emit(f);
                return;
            }
            if (t === 'assistant' || t === 'user') { emit(f); return; }
            if (t === 'result') { state.lastText = f.result || state.lastText; emit(f); return; }
            emit(f);
        },
        end(info) {
            if (!state.sessionId && !state.lastText && !state.failed) {
                emit({ type: 'result', subtype: 'error', is_error: true, result: info && info.spawnError ? String(info.spawnError) : 'the harness ended without a result', session_id: state.sessionId, model: state.model });
            }
        },
    };
}

/**
 * The emitter every feed uses: an event with every secret it holds replaced.
 *
 * An agent that quotes a key it read in a config file puts it in its own output, and the feed is what the page, the
 * session log and the result all show. So nothing is emitted before it is scrubbed.
 */
function emitter(onEvent) {
    return (event) => { if (event) onEvent(scrubDeep(event)); };
}

/** The tool name a harness's tool maps to (Claude Code's vocabulary, so a reader needs one). */
const TOOL_NAMES = {
    read_file: 'Read', read: 'Read', view: 'Read', cat: 'Read',
    shell: 'Bash', run_shell: 'Bash', shell_command: 'Bash', exec: 'Bash', bash: 'Bash', command_execution: 'Bash',
    read_directory: 'LS', list_directory: 'LS', list: 'LS',
    grep: 'Grep', glob: 'Glob', search: 'Grep',
    edit_file: 'Edit', write_file: 'Write', patch: 'Edit', multiedit: 'Edit', file_change: 'Edit',
    web_fetch: 'WebFetch', web_search: 'WebSearch',
    task: 'Task', todowrite: 'TodoWrite', todo_list: 'TodoWrite',
};

module.exports = { EFFORT_LEVELS, NO_TURN_CAP, effortFor, turnCap, knowRegistered, runCli, claudeFeed, childEnv, emitter, TOOL_NAMES };
