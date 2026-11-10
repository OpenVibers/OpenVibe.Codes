'use strict';

/**
 * The deterministic half of a goal (AL1): the check runs in the task's own workspace, not in the model's words.
 *
 * A worker proposes completion; the harness then runs the task's typed check against the clone the worker worked in
 * and carries the output back as evidence. The check is the machine's act, not the agent's: the agent may write the
 * file, but it cannot write the command's exit code. An independent verifier reads this output with a bounded evidence
 * window (engine/goal.js) and accepts or rejects.
 *
 *   runCheck(check, { cwd, timeoutMs, fetchImpl }) → { kind, value, ok, output, exit_code?, status?, at }
 *
 * A `command` runs through bash in the workspace; a `url` is a GET and passes on a 2xx; a `rubric` has no
 * deterministic machine check, so its output says the verifier reads the evidence and `ok` is null. An unknown kind
 * fails the check instead of hanging the run.
 */

const { execFile } = require('child_process');

/** What a check's own output may take of the result channel: the verifier's evidence window is 256 KB. */
const MAX_OUTPUT = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

/** A string cut to the evidence window, never split mid-character. */
function bounded(value, max = MAX_OUTPUT) {
    const text = typeof value === 'string' ? value : String(value == null ? '' : value);
    const bytes = Buffer.from(text, 'utf8');
    return bytes.length <= max ? text : bytes.subarray(0, max).toString('utf8');
}

/** One command in the workspace. Rejects only on a check it could not start; a non-zero exit is an answer. */
function command(value, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
    return new Promise((resolve) => {
        execFile('/bin/bash', ['-lc', value], {
            cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT * 2, env: { ...env, CI: '1', GIT_TERMINAL_PROMPT: '0' },
        }, (err, stdout, stderr) => {
            const out = `${String(stdout || '')}${String(stderr || '')}`;
            const timedOut = !!(err && (err.killed || err.signal === 'SIGTERM'));
            resolve({
                ok: !err,
                exit_code: err && typeof err.code === 'number' ? err.code : (err ? null : 0),
                timed_out: timedOut,
                output: bounded(out.trim() ? out : (err ? String(err.message) : '(no output)')),
            });
        });
    });
}

/** One GET of the URL assertion. 2xx is the check's pass; anything else is its answer. */
async function url(value, { fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
    let target;
    try { target = new URL(value); } catch { return { ok: false, output: 'the check is not a URL' }; }
    if (!/^https?:$/.test(target.protocol)) return { ok: false, output: 'the check URL must be http or https' };
    if (typeof fetchImpl !== 'function') return { ok: false, output: 'this machine cannot fetch the check URL' };
    try {
        const res = await fetchImpl(target.toString(), { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
        const body = await res.text().catch(() => '');
        return {
            ok: res.ok,
            status: res.status,
            output: bounded(`HTTP ${res.status} ${res.statusText || ''}\n${String(body || '').slice(0, 4000)}`),
        };
    } catch (e) {
        return { ok: false, output: bounded(`the URL check failed: ${e && e.message ? e.message : e}`) };
    }
}

/**
 * Run one typed check. Never throws for a check that fails: a failure is the answer the verifier needs.
 *
 * @param {object} check { kind, value }
 * @param {object} [what] { cwd, timeoutMs, fetchImpl, env }
 * @returns {Promise<object>} the check's own record, suitable as evidence
 */
async function runCheck(check, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch, env = process.env } = {}) {
    const kind = String((check && check.kind) || '');
    const value = String((check && check.value) || '');
    const at = new Date().toISOString();
    if (!value.trim()) return { kind, value, ok: false, output: 'the check is empty', at };
    if (kind === 'command') {
        if (!cwd) return { kind, value, ok: false, output: 'the check has no workspace to run in', at };
        return { kind, value, at, ...(await command(value, { cwd, timeoutMs, env })) };
    }
    if (kind === 'url') return { kind, value, at, ...(await url(value, { fetchImpl, timeoutMs: Math.min(timeoutMs, 30_000) })) };
    if (kind === 'rubric') return { kind, value, ok: null, output: 'A rubric has no machine check: the independent verifier reads the evidence.', at };
    return { kind, value, ok: false, output: `unknown check kind ${JSON.stringify(kind)}`, at };
}

module.exports = { runCheck, bounded, MAX_OUTPUT, DEFAULT_TIMEOUT_MS };
