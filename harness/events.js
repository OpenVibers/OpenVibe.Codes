'use strict';

/**
 * One event shape for every coding agent: Claude Code's stream-json (one JSON object per line), the format its own
 * `--output-format stream-json` prints and the one tools already read. Every adapter turns its agent's output into
 * these, so a run reads the same whichever agent did the work:
 *
 *   { type: 'system', subtype: 'init', session_id, agent, model }      the run started (session_id resumes it)
 *   { type: 'assistant', message: { model, content: [ { type: 'text', text } | { type: 'tool_use', id, name, input } ],
 *                                    usage? } }                        what the agent said or called
 *   { type: 'user', message: { content: [ { type: 'tool_result', tool_use_id, content, is_error } ] } }   a tool's answer
 *   { type: 'system', subtype: 'usage' | 'warning' | 'error' | 'stderr' | 'handoff', ... }               along the way
 *   { type: 'result', subtype: 'success' | 'error', is_error, result, session_id, model, duration_ms, num_turns,
 *     total_cost_usd, usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } }
 *                                                                       the end: exactly one per agent run
 *
 * Tool names are Claude Code's (Bash, Read, Edit, Write, Grep, Glob, LS, WebFetch, WebSearch, Task, TodoWrite) when
 * the agent's tool is one of them, so a reader needs one vocabulary.
 */

const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// Credentials an agent prints or reads (a key in a config file, a token in an error) never reach the event stream:
// provider keys, GitHub tokens, JWTs, private-key blocks and `key=…` / `"token": "…"` pairs become [redacted].
const SECRET_PATTERNS = [
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\b((?:api[_-]?key|access[_-]?token|secret|password|client[_-]?secret)["']?\s*[:=]\s*["']?)[^\s"']{8,}/gi,
];
function scrub(s) {
    let out = String(s == null ? '' : s);
    for (const re of SECRET_PATTERNS) out = out.replace(re, (m, keep) => (typeof keep === 'string' && m.startsWith(keep) ? `${keep}[redacted]` : '[redacted]'));
    return out;
}

const init = (sessionId, agent, model) => ({ type: 'system', subtype: 'init', session_id: sessionId || null, agent, model: model || null });
const text = (t, model, usage) => ({ type: 'assistant', message: { model: model || null, content: [{ type: 'text', text: scrub(t) }], ...(usage ? { usage } : {}) } });
const toolUse = (id, name, input, model) => ({ type: 'assistant', message: { model: model || null, content: [{ type: 'tool_use', id: String(id), name, input: input || {} }] } });
const toolResult = (id, content, isError) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: String(id), content: clip(scrub(content), 4000), is_error: !!isError }] } });
const usageEvent = (agent, usage) => ({ type: 'system', subtype: 'usage', agent, usage });
const warning = (t) => ({ type: 'system', subtype: 'warning', text: clip(scrub(t), 500) });
const error = (t) => ({ type: 'system', subtype: 'error', text: clip(scrub(t), 500) });
const stderr = (t) => ({ type: 'system', subtype: 'stderr', text: clip(scrub(t), 500) });

/** Token usage in the result's shape, from any counts (missing ones are 0). */
function usage({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = {}) {
    const n = (x) => (Number.isFinite(+x) ? Math.max(0, +x) : 0);
    return { input_tokens: n(input), output_tokens: n(output), cache_read_input_tokens: n(cacheRead), cache_creation_input_tokens: n(cacheWrite) };
}

/** The one result line an agent run ends with. */
function result({ ok, text: final, sessionId, model, startedAt, turns = 0, costUsd = 0, usage: u = usage() }) {
    return {
        type: 'result', subtype: ok ? 'success' : 'error', is_error: !ok, result: scrub(final || ''),
        session_id: sessionId || null, model: model || null, duration_ms: startedAt ? Date.now() - startedAt : 0,
        num_turns: turns, total_cost_usd: Math.round((Number(costUsd) || 0) * 1e5) / 1e5, usage: u,
    };
}

/**
 * Follows a stream of events and keeps what a summary needs: the session, the last text, the tools called, the files
 * touched, errors, and the result line. Used by the CLI's printer, the run log and the hand-off note.
 */
function createTally() {
    const t = { sessionId: null, model: null, lastText: '', tools: 0, files: new Set(), errors: [], result: null };
    function add(e) {
        if (!e || typeof e !== 'object') return;
        if (e.type === 'system' && e.subtype === 'init') { t.sessionId = e.session_id || t.sessionId; t.model = e.model || t.model; }
        if (e.type === 'system' && e.subtype === 'error') t.errors.push(e.text);
        if (e.type === 'assistant') {
            for (const c of (e.message && e.message.content) || []) {
                if (c.type === 'text' && String(c.text).trim()) t.lastText = c.text;
                if (c.type === 'tool_use') {
                    t.tools++;
                    const f = c.input && (c.input.file_path || c.input.path);
                    if (f && ['Edit', 'Write', 'Delete'].includes(c.name)) t.files.add(String(f));
                }
            }
        }
        if (e.type === 'result') { t.result = e; t.sessionId = e.session_id || t.sessionId; }
    }
    return { add, get: () => t };
}

module.exports = { init, text, toolUse, toolResult, usageEvent, warning, error, stderr, usage, result, createTally, clip, scrub };
