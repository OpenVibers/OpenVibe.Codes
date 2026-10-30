'use strict';

/**
 * Codex (the codex CLI, the owner's ChatGPT plan).
 *
 * The argv comes from the portal's cx-run.sh:
 *
 *   codex exec --json --skip-git-repo-check -C DIR -s SANDBOX [-m MODEL] -c model_reasoning_effort=EFFORT
 *   codex exec resume SESSION --json --skip-git-repo-check --all [-m MODEL]
 *                -c model_reasoning_effort=EFFORT -c sandbox_mode=SANDBOX
 *                -c sandbox_workspace_write.writable_roots=[…]
 *
 * The prompt goes in on stdin (a long prompt is never an argument). The sandbox is Codex's own: read-only for a
 * read-only job, workspace-write for one that may change files, danger-full-access for the owner's "full" choice.
 * The effort is a -c override (model_reasoning_effort), the portal's way of asking Codex for a reasoning level.
 */

const { effortFor, TOOL_NAMES, emitter } = require('./base');

/** The sandbox, by the Codes permission level. */
const SANDBOX = { read: 'read-only', edit: 'workspace-write', full: 'danger-full-access' };

/**
 * The argv and the environment for one Codex run.
 *
 * @param {object} ctx
 * @param {string} ctx.prompt the brief (on stdin)
 * @param {string} [ctx.model] the model
 * @param {string} [ctx.effort] the wanted reasoning level
 * @param {string} [ctx.resume] the session (thread) to continue
 * @param {string} [ctx.permission] 'read' | 'edit' | 'full'
 * @param {string} ctx.cwd the working directory
 * @param {string} [ctx.extraDir] a directory the job may write (its own notes)
 * @param {string[]} [ctx.config] extra -c key=value overrides
 * @returns {{cmd: string, argv: string[], env: object, stdin: string|null}} what to run
 */
function build(ctx = {}) {
    const effort = effortFor('codex', ctx.effort);
    const sandbox = SANDBOX[ctx.permission] || SANDBOX.read;
    const argv = ['exec'];
    if (ctx.resume) {
        // A resume takes its own flag set: no -C, no -s, no --add-dir. The sandbox and the extra writable roots go in
        // as -c overrides, and the CLI's working directory is the one the session was recorded under.
        const roots = [ctx.cwd];
        if (ctx.extraDir) roots.push(ctx.extraDir);
        argv.push('resume', String(ctx.resume), '--json', '--skip-git-repo-check', '--all');
        if (ctx.model) argv.push('-m', ctx.model);
        argv.push('-c', `model_reasoning_effort=${effort || 'medium'}`);
        argv.push('-c', `sandbox_mode=${sandbox}`);
        argv.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`);
    } else {
        argv.push('--json', '--skip-git-repo-check', '-C', ctx.cwd, '-s', sandbox);
        if (ctx.model) argv.push('-m', ctx.model);
        argv.push('-c', `model_reasoning_effort=${effort || 'medium'}`);
        if (ctx.permission === 'edit' && ctx.extraDir) argv.push('--add-dir', ctx.extraDir);
    }
    for (const kv of (ctx.config || [])) argv.push('-c', kv);
    argv.push('-');                                  // the prompt comes on stdin
    return { cmd: ctx.bin || 'codex', argv, env: {}, stdin: ctx.prompt || '' };
}

/** The feed: Codex's events are turned into Claude Code's stream-json (the portal's cx-feed.js). */
function feed({ model, onEvent }) {
    const state = { sessionId: null, lastText: '', failed: null, usage: null, turns: 0, started: new Set(), done: new Set() };
    const emit = emitter(onEvent);
    const tool = (id, name, input) => { if (state.started.has(id)) return; state.started.add(id); emit({ type: 'assistant', message: { model, content: [{ type: 'tool_use', id, name, input }] } }); };
    const result = (id, content, isError) => { if (state.done.has(id)) return; state.done.add(id); emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: String(content || '').slice(0, 4000), is_error: !!isError }] } }); };
    const describe = (it) => {
        const t = it.type;
        if (t === 'command_execution') return ['Bash', { command: it.command || '' }];
        if (t === 'mcp_tool_call') return [`mcp__${it.server || 'mcp'}__${it.tool || 'tool'}`, it.arguments && typeof it.arguments === 'object' ? it.arguments : {}];
        if (t === 'web_search') return ['WebSearch', { query: it.query || '' }];
        if (t === 'collab_tool_call') return ['Task', { description: String(it.prompt || it.tool || 'subagent').slice(0, 200) }];
        return [`codex:${t || 'item'}`, it];
    };
    const itemResult = (it) => {
        const t = it.type, s = String(it.status || '');
        if (t === 'command_execution') {
            const code = it.exit_code, txt = String(it.aggregated_output || '');
            return [txt + (code != null && code !== 0 ? `\n(exit ${code})` : ''), s === 'failed' || (code != null && code !== 0)];
        }
        if (t === 'mcp_tool_call') {
            if (it.error) return [String(it.error.message || it.error), true];
            const c = (it.result && it.result.content) || [];
            return [c.map((x) => (x && x.text) || (typeof x === 'string' ? x : JSON.stringify(x))).join('\n'), s === 'failed'];
        }
        if (t === 'web_search') return [Array.isArray(it.results) ? `${it.results.length} results` : 'searched', s === 'failed'];
        return [s || 'done', s === 'failed'];
    };
    const onItem = (phase, it) => {
        if (!it || typeof it !== 'object') return;
        const id = String(it.id || `${it.type}-${state.started.size}`), t = it.type;
        if (t === 'reasoning') return;
        if (t === 'agent_message') {
            if (phase === 'completed' && String(it.text || '').trim()) {
                state.lastText = it.text;
                emit({ type: 'assistant', message: { model, content: [{ type: 'text', text: it.text }] } });
            }
            return;
        }
        if (t === 'error') { emit({ type: 'system', subtype: 'warning', text: String(it.message || '').slice(0, 500) }); return; }
        if (t === 'file_change') {
            if (phase !== 'completed') return;
            const failed = it.status === 'failed';
            (it.changes || [{}]).forEach((ch, i) => {
                const cid = `${id}:${i}`, kind = ch.kind && typeof ch.kind === 'object' ? ch.kind.type : ch.kind;
                tool(cid, kind === 'add' ? 'Write' : kind === 'delete' ? 'Delete' : 'Edit', { file_path: ch.path || '', change: kind || 'update' });
                result(cid, failed ? 'patch failed' : `${kind || 'update'} applied`, failed);
            });
            return;
        }
        const [name, input] = describe(it);
        tool(id, name, input);
        if (phase === 'completed') { const [txt, err] = itemResult(it); result(id, txt, err); }
    };
    return {
        state,
        line(raw) {
            let e; try { e = JSON.parse(raw); } catch { if (String(raw).trim()) emit({ type: 'system', subtype: 'stderr', text: String(raw).slice(0, 500) }); return; }
            if (!e || typeof e !== 'object') return;
            switch (e.type) {
                case 'thread.started':
                    state.sessionId = e.thread_id || null;
                    emit({ type: 'system', subtype: 'init', session_id: state.sessionId, backend: 'codex', model });
                    break;
                case 'turn.started': state.turns++; break;
                case 'item.started': onItem('started', e.item); break;
                case 'item.updated': onItem('updated', e.item); break;
                case 'item.completed': onItem('completed', e.item); break;
                case 'turn.completed': {
                    const u = e.usage || {}, n = (x) => (Number.isFinite(+x) ? +x : 0);
                    state.usage = { input: n(u.input_tokens), cached: n(u.cached_input_tokens), output: n(u.output_tokens) };
                    emit({ type: 'system', subtype: 'usage', backend: 'codex', usage: state.usage });
                    break;
                }
                case 'turn.failed':
                    state.failed = String((e.error && (e.error.message || e.error)) || 'turn failed');
                    emit({ type: 'system', subtype: 'error', text: `API Error: ${state.failed.slice(0, 400)}` });
                    break;
                case 'error':
                    state.failed = String(e.message || e.error || 'error');
                    emit({ type: 'system', subtype: 'error', text: `API Error: ${state.failed.slice(0, 400)}` });
                    break;
                default: break;
            }
        },
        end(info) {
            for (const id of state.started) if (!state.done.has(id)) result(id, 'cut off', true);
            const ok = !state.failed && !!state.lastText && (!info || info.code === 0);
            emit({
                type: 'result', subtype: ok ? 'success' : 'error', is_error: !ok,
                result: ok ? state.lastText : (state.failed || 'Codex ended without a result (a limit, the sandbox or a crash: check its exit code)'),
                session_id: state.sessionId, model, duration_ms: 0, num_turns: state.turns,
                usage: { input_tokens: Math.max(0, (state.usage && state.usage.input) || 0), output_tokens: (state.usage && state.usage.output) || 0, cache_read_input_tokens: (state.usage && state.usage.cached) || 0, cache_creation_input_tokens: 0 },
            });
        },
    };
}

const codex = { id: 'codex', name: 'Codex', kind: 'cli', bin: 'codex', portal: 'cx-run.sh', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], build, feed, SANDBOX };

module.exports = { codex, SANDBOX, TOOL_NAMES };
