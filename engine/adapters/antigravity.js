'use strict';

/**
 * Antigravity CLI (`agy`), Google's coding agent for people's own accounts. Since 2026-06-18 the free tier and the Google
 * AI Pro / Ultra plans run here, not in Gemini CLI (which is left to Code Assist Standard / Enterprise), so this is the
 * Google harness a person brings (the plan's "Gemini CLI" harness connection, 11-28).
 *
 * Headless (https://antigravity.google/docs/cli/headless):
 *
 *   agy --input-format stream-json --output-format stream-json [--model SLUG] [--effort LEVEL] [--conversation ID] MODE
 *   stdin: {"event":"user","message":{"content":BRIEF}}, then closed (agy answers that turn, sends its result, exits)
 *
 * The brief goes on stdin, never in argv: a machine's process list is readable, and one argument stops at 128 KB. A
 * brief that starts with "/" would be read as one of agy's slash commands (which ends the session), so it is prefixed.
 * MODE is the permission: read → `--mode default` (anything that needs approval is refused in headless, so it reads and
 * answers), edit → `--mode auto` (workspace edits and safe, reversible commands; risky ones are refused),
 * full → `--dangerously-skip-permissions`. A refused action does not end the run: agy notes it on stderr and goes on.
 *
 * The stream is NDJSON with an `event` field: one `init` ({ conversation_id, init: { cwd, tools, permission_mode,
 * model } }), `step_update`s ({ step_type: user_input | agent_response | tool | checkpoint, state: ACTIVE | DONE,
 * text_delta, tool_name, tool_info: { name, parameters, output, error }, usage }) and one `result` ({ status: SUCCESS |
 * ERROR | CANCELED | INTERRUPTED | INVALID | WAITING | RUNNING, response, error, num_turns, usage }). The feed turns it
 * into Claude Code's stream-json, the one transcript shape.
 */

const { TOOL_NAMES, emitter } = require('./base');

/** The reasoning levels `--effort` takes (what a model accepts varies; agy refuses one it does not take). */
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Antigravity's own tool names, as Claude Code's (the ones the transcript and the review know). */
const AGY_TOOLS = {
    run_command: 'Bash', write_to_file: 'Write', replace_file_content: 'Edit', multi_replace_file_content: 'Edit',
    view_file: 'Read', view_file_outline: 'Read', view_code_item: 'Read', list_dir: 'LS', grep_search: 'Grep',
    find_by_name: 'Glob', codebase_search: 'Grep', read_url_content: 'WebFetch', search_web: 'WebSearch',
};

/** The parameter names the transcript reads (file_path, command), from Antigravity's own. */
function inputOf(params) {
    const p = params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : {};
    const file = p.TargetFile || p.AbsolutePath || p.FilePath || p.File || p.path;
    if (file && !p.file_path) p.file_path = file;
    if (p.CommandLine && !p.command) p.command = p.CommandLine;
    if (p.Query && !p.pattern) p.pattern = p.Query;
    return p;
}

/**
 * The argv for one run.
 *
 * @param {object} ctx
 * @param {string} ctx.prompt the brief
 * @param {string} [ctx.model] the model slug (`agy models`)
 * @param {string} [ctx.effort] low | medium | high | xhigh | max (what the model takes)
 * @param {string} [ctx.resume] the conversation to continue
 * @param {string} [ctx.permission] 'read' | 'edit' | 'full'
 * @returns {{cmd: string, argv: string[], env: object, stdin: string|null}} what to run
 */
function build(ctx = {}) {
    const argv = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
    if (ctx.model) argv.push('--model', String(ctx.model));
    if (ctx.effort && LEVELS.includes(ctx.effort)) argv.push('--effort', ctx.effort);
    if (ctx.resume) argv.push('--conversation', String(ctx.resume));
    if (ctx.permission === 'full') argv.push('--dangerously-skip-permissions');
    else argv.push('--mode', ctx.permission === 'read' ? 'default' : 'auto');
    return { cmd: ctx.bin || 'agy', argv, env: {}, stdin: promptLine(ctx.prompt) };
}

/** The one stdin line that asks for the brief: a `user` event (a leading "/" would be a slash command). */
function promptLine(prompt) {
    const text = String(prompt || '');
    return `${JSON.stringify({ event: 'user', message: { content: text.startsWith('/') ? `The brief:\n${text}` : text } })}\n`;
}


/** The usage of a step or a result, as Claude Code counts it. */
function usageOf(u) {
    const x = u && typeof u === 'object' ? u : {};
    return {
        input_tokens: Math.max(0, (Number(x.input_tokens) || 0) - (Number(x.cache_read_tokens) || 0)),
        output_tokens: (Number(x.output_tokens) || 0) + (Number(x.thinking_tokens) || 0),
        cache_read_input_tokens: Number(x.cache_read_tokens) || 0,
        cache_creation_input_tokens: 0,
    };
}

/** The feed: Antigravity's events as Claude Code's stream-json. */
function feed({ model, onEvent }) {
    const state = { sessionId: null, model, lastText: '', failed: null, steps: 0, usage: null, status: null, tools: 0 };
    const emit = emitter(onEvent);
    return {
        state,
        line(raw) {
            let e; try { e = JSON.parse(raw); } catch { if (String(raw).trim()) emit({ type: 'system', subtype: 'stderr', text: String(raw).slice(0, 500) }); return; }
            if (!e || typeof e !== 'object') return;
            const body = e[e.event] && typeof e[e.event] === 'object' ? e[e.event] : {};
            const conv = e.conversation_id || body.conversation_id;
            if (conv && !state.sessionId) {
                state.sessionId = String(conv);
                if (e.event === 'init' && body.model) state.model = String(body.model);
                emit({ type: 'system', subtype: 'init', session_id: state.sessionId, backend: 'antigravity', model: state.model });
            }
            if (e.event === 'step_update') {
                if (body.step_type === 'agent_response' && typeof body.text_delta === 'string' && body.text_delta) {
                    state.lastText += body.text_delta;
                    emit({ type: 'assistant', message: { model: state.model, content: [{ type: 'text', text: body.text_delta }] } });
                } else if (body.step_type === 'tool' && body.state === 'DONE') {
                    const info = body.tool_info && typeof body.tool_info === 'object' ? body.tool_info : {};
                    const raw = String(info.name || body.tool_name || 'tool');
                    const id = `agy-${state.sessionId || 'run'}-${body.step_index != null ? body.step_index : ++state.tools}`;
                    const err = info.error && typeof info.error === 'object' ? info.error : null;
                    emit({ type: 'assistant', message: { model: state.model, content: [{ type: 'tool_use', id, name: AGY_TOOLS[raw] || TOOL_NAMES[raw] || raw, input: inputOf(info.parameters) }] } });
                    const text = err ? String(err.message || err.type || 'the tool failed') : typeof info.output === 'string' ? info.output : JSON.stringify(info.output || '');
                    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text.slice(0, 4000), is_error: !!err }] } });
                }
                if (body.state === 'DONE' && body.step_type !== 'user_input') state.steps++;
            } else if (e.event === 'result') {
                state.status = String(body.status || '');
                if (body.usage) state.usage = usageOf(body.usage);
                // The whole answer is in `response`; when the deltas missed some of it, the response wins.
                if (typeof body.response === 'string' && body.response.trim() && body.response.trim() !== state.lastText.trim()) state.lastText = body.response;
                if (state.status && state.status !== 'SUCCESS') {
                    const why = typeof body.error === 'string' ? body.error : body.error && (body.error.message || body.error.type);
                    state.failed = String(why || `the run ended ${state.status.toLowerCase()}`).split('\n')[0].slice(0, 400);
                    emit({ type: 'system', subtype: 'error', text: `API Error: ${state.failed}` });
                }
            }
        },
        end() {
            const final = String(state.lastText || '').trim();
            const err = state.failed ? `API Error: ${state.failed}` : null;
            emit({
                type: 'result', subtype: err || !final ? 'error' : 'success', is_error: !!(err || !final),
                result: err || final || 'API Error: Antigravity CLI ended without an answer (a limit, a refusal or a crash: check its exit code)',
                duration_ms: 0, num_turns: state.steps, session_id: state.sessionId, model: state.model,
                total_cost_usd: 0, usage: state.usage || { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            });
        },
    };
}

const antigravity = { id: 'antigravity', name: 'Antigravity CLI', kind: 'cli', bin: 'agy', portal: 'agy', effortLevels: LEVELS, build, feed };

module.exports = { antigravity, AGY_TOOLS, inputOf, promptLine, usageOf };
