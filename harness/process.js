'use strict';

/**
 * Runs one agent CLI and turns its output into events (harness/events.js) as they come.
 *
 *   const run = spawnAgent({ cmd, args, cwd, env, timeoutMs, signal, parser });
 *   for await (const event of run) …;      // ends after the parser's end() and the process exit
 *   run.cancel();                         // SIGTERM, then SIGKILL after 5 s
 *
 * parser: { line(raw, emit), end({ code, signal, timedOut, stderr }, emit) } — line() sees every stdout line, end()
 * runs once when the process has exited and must emit the run's one `result` event if line() did not. stderr is kept
 * (the last 4 kB) for end(); whatever of it is shown goes through events.scrub() first.
 */
const { spawn } = require('child_process');
const readline = require('readline');
const { scrub } = require('./events');

function spawnAgent({ cmd, args = [], cwd, env, timeoutMs = 45 * 60_000, signal, parser, stdin = null }) {
    const queue = [];
    let wake = null;
    let finished = false;
    const emit = (e) => { if (e) { queue.push(e); if (wake) { wake(); wake = null; } } };
    const finish = () => { finished = true; if (wake) { wake(); wake = null; } };

    let child;
    try {
        child = spawn(cmd, args, { cwd, env: { ...process.env, ...(env || {}) }, stdio: [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (err) {
        parser.end({ code: null, signal: null, timedOut: false, stderr: '', spawnError: err.message }, emit);
        finish();
    }
    let stderrBuf = '';
    let timedOut = false;
    let killTimer = null;
    const cancel = () => {
        if (!child || child.exitCode !== null || child.signalCode) return;
        try { child.kill('SIGTERM'); } catch { /* gone */ }
        killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
        killTimer.unref();
    };
    if (child) {
        if (stdin != null) { child.stdin.end(stdin); }
        const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
        timer.unref();
        if (signal) { if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true }); }
        readline.createInterface({ input: child.stdout }).on('line', (raw) => { try { parser.line(raw, emit); } catch (err) { emit({ type: 'system', subtype: 'warning', text: `unreadable line: ${err.message}` }); } });
        child.stderr.on('data', (d) => { stderrBuf = (stderrBuf + d.toString()).slice(-4096); });
        child.on('error', (err) => { stderrBuf += `\n${err.message}`; });
        child.on('close', (code, sig) => {
            clearTimeout(timer);
            if (killTimer) clearTimeout(killTimer);
            // Let readline drain the last stdout lines before the parser ends the run.
            setImmediate(() => {
                try { parser.end({ code, signal: sig, timedOut, stderr: stderrBuf }, emit); } catch (err) { emit({ type: 'system', subtype: 'error', text: err.message }); }
                finish();
            });
        });
    }

    const iterator = (async function* events() {
        while (true) {
            if (queue.length) { yield queue.shift(); continue; }
            if (finished) return;
            await new Promise((r) => { wake = r; });
        }
    }());
    iterator.cancel = cancel;
    iterator.pid = child ? child.pid : null;
    return iterator;
}

/** Why an agent's process ended without a result, in words a person can act on. */
function exitReason({ code, signal, timedOut, stderr, spawnError }, name) {
    if (spawnError) return `${name} could not start: ${spawnError}`;
    if (timedOut) return `${name} ran past its time limit and was stopped`;
    if (signal) return `${name} was stopped (${signal})`;
    const last = String(stderr || '').trim().split('\n').filter(Boolean).pop();
    return `${name} ended without a result (exit ${code})${last ? `: ${scrub(last).slice(0, 200)}` : ''}`;
}

module.exports = { spawnAgent, exitReason };
