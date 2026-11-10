'use strict';

/**
 * `--for-agent`: the machine face of `openvibe-codes`.
 *
 * A supervising agent asks the CLI with `--for-agent` and reads one compact JSON object per line: no ANSI, no pretty
 * printing, no full event dump. The fields are fixed so a caller can branch on them without parsing words:
 *
 *   run      the run id (the same one `show` and `resume` take)
 *   seq      the line's number in this run, from 1
 *   event    init | text | tool | tool_error | progress | handoff | warning | stderr | result | run | attempt | error
 *   agent    the harness that produced the line (init, result and the run summaries)
 *   session  the harness's session id, when it has one (the key `resume` needs)
 *   ref      what a tool call points at: a file, a pattern, a URL or the first line of a command
 *   ok       on a result: did the agent finish without an error
 *   error    on a failure: { code, retry, suggestion }; retry is true only when repeating the same command is safe
 *
 * Text is bounded (MAX_TEXT) because a supervising agent pays for every token of it: the human log stays the full one.
 * The guide that explains these fields ships with the binary and matches its version: `openvibe-codes skills get`.
 */

const MAX_TEXT = 400;
const MAX_REF = 200;

// The closed set of codes. A caller branches on the code, never on the message.
const ERRORS = {
    no_prompt: { retry: false, suggestion: 'pass the task as an argument, or "-" and write it on stdin' },
    bad_agent: { retry: false, suggestion: 'run `openvibe-codes agents --for-agent` and pick an id it lists as available' },
    unavailable: { retry: false, suggestion: 'run `openvibe-codes agents --for-agent`; the harness is not installed or signed in here' },
    agent_failed: { retry: false, suggestion: 'read the result, then continue the same session with `openvibe-codes resume <run> "<follow-up>"`' },
    no_run: { retry: false, suggestion: 'run `openvibe-codes runs --for-agent` and use an id from it' },
    usage: { retry: false, suggestion: 'run `openvibe-codes skills get` for the command and output reference' },
    internal: { retry: false, suggestion: 'run the same command without --for-agent to see the full error' },
};

const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** One JSON line. `undefined` fields are left out, so the envelope stays small. */
function line(doc) {
    const out = {};
    for (const [k, v] of Object.entries(doc)) if (v !== undefined && v !== null && v !== '') out[k] = v;
    return JSON.stringify(out);
}

/** A failure the caller can act on: a code, whether repeating the command is safe, and what to do. */
function errorLine(code, message, extra = {}) {
    const known = ERRORS[code] || ERRORS.internal;
    return line({
        event: 'error', code, retry: extra.retry != null ? !!extra.retry : known.retry,
        suggestion: extra.suggestion || known.suggestion, message: clip(message, MAX_TEXT),
        ...(extra.run ? { run: extra.run } : {}), ...(extra.seq ? { seq: extra.seq } : {}),
    });
}

/** What a tool call points at, in the harness's own vocabulary (Claude Code's names are the shared ones). */
function refOf(input) {
    const i = input && typeof input === 'object' ? input : {};
    for (const key of ['file_path', 'path', 'notebook_path', 'pattern', 'query', 'url', 'command', 'description']) {
        const v = i[key];
        if (typeof v === 'string' && v.trim()) return clip(v.split('\n')[0].trim(), MAX_REF);
    }
    return undefined;
}

/** The lines one harness event becomes. An assistant message may hold text and tool calls: one line each. */
function eventLines(runId, seq, e) {
    if (!e || typeof e !== 'object') return [];
    const base = { run: runId, ...(seq == null ? {} : { seq }) };
    const lines = [];
    if (e.type === 'system') {
        if (e.subtype === 'init') lines.push(line({ ...base, event: 'init', agent: e.agent, model: e.model, session: e.session_id }));
        else if (e.subtype === 'handoff') lines.push(line({ ...base, event: 'handoff', from: e.from, reason: clip(e.reason, MAX_TEXT) }));
        else if (e.subtype === 'warning' || e.subtype === 'error') lines.push(line({ ...base, event: 'warning', level: e.subtype, message: clip(e.text, MAX_TEXT) }));
        else if (e.subtype === 'stderr') lines.push(line({ ...base, event: 'stderr', message: clip(e.text, MAX_TEXT) }));
        else if (e.subtype === 'tool_progress') lines.push(line({ ...base, event: 'progress', tool: e.tool_use_id, text: clip(e.text, MAX_TEXT) }));
        return lines;
    }
    if (e.type === 'assistant') {
        for (const c of (e.message && e.message.content) || []) {
            if (c.type === 'text' && String(c.text || '').trim()) lines.push(line({ ...base, event: 'text', agent: e._agent, text: clip(c.text, MAX_TEXT) }));
            else if (c.type === 'tool_use') lines.push(line({ ...base, event: 'tool', agent: e._agent, tool: c.name, ref: refOf(c.input) }));
        }
        return lines;
    }
    if (e.type === 'user') {
        for (const c of (e.message && e.message.content) || []) {
            if (c.type === 'tool_result' && c.is_error) lines.push(line({ ...base, event: 'tool_error', text: clip(c.content, MAX_TEXT) }));
        }
        return lines;
    }
    if (e.type === 'result') {
        const failed = !!e.is_error;
        // "X is not available here" is the harness refusing before an agent ran, not an agent's own failure.
        const code = failed && /is not available here/.test(String(e.result || '')) ? 'unavailable' : 'agent_failed';
        lines.push(line({
            ...base,
            event: 'result',
            agent: e._agent,
            ok: !failed,
            session: e.session_id,
            text: clip(e.result, MAX_TEXT),
            cost_usd: Number(e.total_cost_usd) || undefined,
            ...(failed ? { code, retry: false, suggestion: (ERRORS[code] || ERRORS.agent_failed).suggestion } : {}),
        }));
        return lines;
    }
    return lines;
}

/** A run's own one-line header, for `show` and `runs` (not the full event stream). */
function runLine(r) {
    return line({
        event: 'run', run: r.run_id, cwd: r.cwd, task: r.task, permission: r.permission,
        agents: (r.attempts || []).map((a) => a.agent), ok: !!(r.result && !r.result.is_error),
        prompt: clip(String(r.prompt || '').split('\n')[0], MAX_REF),
    });
}

function attemptLine(runId, a) {
    return line({
        event: 'attempt', run: runId, n: a.attempt, agent: a.agent, ok: !!a.ok,
        session: a.session_id, error: a.error ? clip(a.error, MAX_TEXT) : undefined,
    });
}

/** `show --for-agent`: the header, each attempt, then the result (nothing else, unlike --json). */
function showLines(r) {
    const lines = [runLine(r)];
    for (const a of r.attempts || []) lines.push(attemptLine(r.run_id, a));
    if (r.result) lines.push(line({
        event: 'result', run: r.run_id, ok: !r.result.is_error, session: r.result.session_id,
        text: clip(r.result.result, MAX_TEXT),
        ...(r.result.is_error ? { code: 'agent_failed', retry: false, suggestion: ERRORS.agent_failed.suggestion } : {}),
    }));
    return lines;
}

module.exports = { MAX_TEXT, MAX_REF, ERRORS, clip, line, errorLine, refOf, eventLines, runLine, attemptLine, showLines };
