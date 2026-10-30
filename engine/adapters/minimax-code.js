'use strict';

/**
 * MiniMax Code (the `mcode` CLI, the owner's M Plan).
 *
 * The argv comes from the portal's mm-run.sh:
 *
 *   mcode exec --input - --output-format stream-json --prompt-mode coding --permission MODE --cwd DIR
 *         --timeout 45m --max-steps N --append-system-prompt-file RULES -o LAST [--ptc] [--mode lightweight]
 *         [--model MODEL] [--effort EFFORT] [--session SESSION]
 *
 * The rules ride in the appended system prompt (the stable, best-cached prefix) and the brief alone is the user turn.
 * --ptc is Programmatic Tool Calling (the model batches its tool calls in one round trip). The permission is smart for a
 * guarded job and full for the owner's "full" choice.
 */

const { effortFor, emitter } = require('./base');

/**
 * The argv and the environment for one MiniMax Code run.
 *
 * @param {object} ctx
 * @param {string} ctx.prompt the brief (on stdin)
 * @param {string} [ctx.model] the model
 * @param {string} [ctx.effort] the wanted reasoning level
 * @param {string} [ctx.resume] the session to continue
 * @param {string} [ctx.permission] 'read' | 'edit' | 'full'
 * @param {number} [ctx.maxSteps] the step limit
 * @param {string} [ctx.rules] the rules file (appended to the system prompt)
 * @param {string} [ctx.cwd] the working directory
 * @param {string} [ctx.out] the file the last answer is written to
 * @param {boolean} [ctx.ptc] Programmatic Tool Calling (on by default, the portal's choice)
 * @param {boolean} [ctx.light] the lightweight mode (a smaller context)
 * @returns {{cmd: string, argv: string[], env: object, stdin: string|null}} what to run
 */
function build(ctx = {}) {
    const effort = effortFor('minimax-code', ctx.effort);
    const perm = ctx.permission === 'full' ? 'full' : 'smart';
    const argv = ['exec', '--input', '-', '--output-format', 'stream-json', '--prompt-mode', 'coding',
        '--permission', perm, '--cwd', ctx.cwd || process.cwd(), '--timeout', ctx.timeout || '45m',
        '--max-steps', String(ctx.maxSteps || 150)];
    if (ctx.rules && String(ctx.rules).trim()) argv.push('--append-system-prompt-file', String(ctx.rules).trim());
    if (ctx.out) argv.push('-o', ctx.out);
    if (ctx.ptc !== false) argv.push('--ptc');
    if (ctx.light) argv.push('--mode', 'lightweight');
    if (ctx.model) argv.push('--model', ctx.model);
    if (effort) argv.push('--effort', effort);
    if (ctx.resume) argv.push('--session', String(ctx.resume));
    return { cmd: ctx.bin || 'mcode', argv, env: {}, stdin: ctx.prompt || '' };
}

/**
 * The feed: MiniMax Code's stream-json (schemaVersion 1 events) is what the transcript normaliser reads.
 *
 * @param {object} opts
 * @param {string} opts.model the model
 * @param {function} opts.onEvent every event
 * @returns {{line: function, end: function, state: object}} the feed
 */
function feed({ model, onEvent }) {
    const state = { sessionId: null, model, lastText: '', failed: null };
    const emit = emitter(onEvent);
    return {
        state,
        line(raw) {
            let e; try { e = JSON.parse(raw); } catch { if (String(raw).trim()) emit({ type: 'system', subtype: 'stderr', text: String(raw).slice(0, 500) }); return; }
            if (!e || typeof e !== 'object') return;
            // MiniMax Code's own events (schemaVersion 1): item.started / item.completed / turn.* / exec.completed.
            if (e.schemaVersion && typeof e.type === 'string' && e.type.includes('.')) {
                if (e.sessionId) state.sessionId = e.sessionId;
                const it = e.item || {};
                if (e.type === 'item.started' && (it.type === 'agent_message' || it.type === 'reasoning')) {
                    emit({ type: 'system', subtype: 'init', session_id: state.sessionId, backend: 'minimax-code', model });
                } else if (e.type === 'item.completed' && it.type === 'agent_message') {
                    const text = String(it.content || it.contentDelta || '');
                    if (text.trim()) { state.lastText = text; emit({ type: 'assistant', message: { model, content: [{ type: 'text', text }] } }); }
                } else if (e.type === 'turn.failed') {
                    state.failed = String((e.error && (e.error.message || e.error)) || 'turn failed');
                    emit({ type: 'system', subtype: 'error', text: state.failed });
                } else if (e.type === 'exec.completed' && e.result) {
                    const r = e.result;
                    const answer = String(r.answer || r.output || '');
                    state.lastText = answer || state.lastText;
                    emit({ type: 'result', subtype: r.status && r.status !== 'succeeded' ? 'error' : 'success', is_error: !!(r.status && r.status !== 'succeeded'), result: answer, session_id: state.sessionId, model, duration_ms: r.durationMs || 0 });
                } else if (e.type === 'item.completed' && it.type === 'tool_result') {
                    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: it.toolCallId || it.callId || it.id, content: String(it.output || it.content || it.result || ''), is_error: !!(it.isError || it.status === 'failed') }] } });
                }
                return;
            }
            // The plain shape (a text or a result line).
            if (e.type === 'result') { state.lastText = e.result || state.lastText; emit(e); return; }
            emit(e);
        },
        end(info) {
            if (!state.lastText && !state.failed) {
                emit({ type: 'result', subtype: 'error', is_error: true, result: 'MiniMax Code ended without an answer (a limit, a plan window or a crash: check its exit code)', session_id: state.sessionId, model });
            }
        },
    };
}

const minimaxCode = { id: 'minimax-code', name: 'MiniMax Code', kind: 'cli', bin: 'mcode', portal: 'mm-run.sh', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], build, feed };

module.exports = { minimaxCode };
