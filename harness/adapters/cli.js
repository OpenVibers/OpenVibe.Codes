'use strict';

/**
 * The coding agents that run as a command on the person's machine. Each adapter says how to start its CLI for a task
 * and how to read what it prints into the shared events (harness/events.js):
 *
 *   { id, name, kind: 'cli', bin, start(task, ctx) }     ctx: { env } (the harness's environment: PATH finds the CLI)
 *   task: { prompt, cwd, model, resume, permission: 'read' | 'edit' | 'full', maxTurns, timeoutMs, signal }
 *
 * Permission levels mean the same for every agent, mapped onto what each CLI offers:
 *   read   look and answer: no file is changed and no command that changes anything runs
 *   edit   change files in the working directory; shell commands only as the agent's own rules allow
 *   full   anything the agent can do, unattended (its own guardrails only) — for a sandbox or a throwaway checkout
 * Nothing here pushes, commits or opens a pull request: that is the person's (or a later Improve OpenVibe step's) call.
 */
const { execFileSync } = require('child_process');
const ev = require('../events');
const { spawnAgent, exitReason } = require('../process');
const { effortFor } = require('../../engine/adapters/base');

/** A parser that reads JSON lines, hands each object to onEvent, and ends the run with exactly one result. */
function jsonLines(agent, onEvent, onEnd) {
    let sawResult = false;
    const state = {};
    return {
        line(raw, emit) {
            let o;
            try { o = JSON.parse(raw); } catch { if (raw.trim()) emit(ev.stderr(raw)); return; }
            onEvent(o, (e) => { if (e && e.type === 'result') sawResult = true; emit(e); }, state);
        },
        end(info, emit) {
            if (onEnd) onEnd(info, (e) => { if (e && e.type === 'result') sawResult = true; emit(e); }, state);
            if (!sawResult) emit(ev.result({ ok: false, text: exitReason(info, agent.name), sessionId: state.sessionId, model: state.model, startedAt: state.startedAt }));
        },
    };
}

/**
 * What a CLI says about itself: its version, asked of the binary itself (never read from a file of ours, and never
 * a key). A CLI that cannot answer says nothing: the run says why instead.
 *
 * @param {string} bin the executable
 * @param {object} [env] the environment it runs in (PATH)
 * @param {string[]} [args] the arguments that ask
 * @returns {string|null} the version, one line, cut short
 */
function versionOf(bin, env = process.env, args = ['--version']) {
    try {
        const out = execFileSync(bin, args, { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
        const line = String(out || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
        return line ? line.slice(0, 120) : null;
    } catch { return null; }
}

// ── Claude Code: `claude -p --output-format stream-json` already prints the shared events ──
const claudeCode = {
    id: 'claude-code', name: 'Claude Code', kind: 'cli', bin: 'claude',
    start(t, ctx = {}) {
        const mode = { read: 'plan', edit: 'acceptEdits', full: 'bypassPermissions' }[t.permission] || 'plan';
        const args = ['-p', t.prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', mode];
        if (t.model) args.push('--model', t.model);
        if (t.resume) args.push('--resume', t.resume);
        if (t.maxTurns) args.push('--max-turns', String(t.maxTurns));
        // Even unattended, a run never pushes: publishing is the person's step.
        args.push('--disallowedTools', 'Bash(git push:*)');
        const parser = jsonLines(claudeCode, (o, emit, st) => {
            if (o.type === 'system' && o.subtype === 'init') { st.sessionId = o.session_id; st.model = o.model; emit(ev.init(o.session_id, 'claude-code', o.model)); return; }
            if (o.type === 'result') { emit({ ...o, result: ev.scrub(o.result || '') }); return; }
            if (o.type === 'assistant' || o.type === 'user') emit(o);
        });
        return spawnAgent({ cmd: this.bin, args, cwd: t.cwd, env: ctx.env, timeoutMs: t.timeoutMs, signal: t.signal, parser });
    },
};

// ── Codex: `codex exec --json` (thread/turn/item events) ──
const CODEX_TOOL = (it) => {
    if (it.type === 'command_execution') return ['Bash', { command: it.command || '' }];
    if (it.type === 'mcp_tool_call') return [`mcp__${it.server || 'mcp'}__${it.tool || 'tool'}`, it.arguments && typeof it.arguments === 'object' ? it.arguments : {}];
    if (it.type === 'web_search') return ['WebSearch', { query: it.query || '' }];
    return [`codex:${it.type || 'item'}`, {}];
};
const codex = {
    id: 'codex', name: 'Codex', kind: 'cli', bin: 'codex',
    start(t, ctx = {}) {
        const sandbox = { read: 'read-only', edit: 'workspace-write', full: 'danger-full-access' }[t.permission] || 'read-only';
        const args = t.resume
            ? ['exec', 'resume', t.resume, '--json', '--skip-git-repo-check']
            : ['exec', '--json', '--skip-git-repo-check', '-C', t.cwd, '-s', sandbox];
        if (t.model) args.push('-m', t.model);
        args.push(t.prompt);
        const startedAt = Date.now();
        const parser = jsonLines(codex, (e, emit, st) => {
            st.startedAt = startedAt;
            st.usage = st.usage || { input: 0, cached: 0, output: 0 };
            st.started = st.started || new Set();
            const item = e.item || {};
            const id = String(item.id || `${item.type}-${st.started.size}`);
            if (e.type === 'thread.started') { st.sessionId = e.thread_id; emit(ev.init(e.thread_id, 'codex', t.model)); }
            else if (e.type === 'turn.started') st.turns = (st.turns || 0) + 1;
            else if (e.type === 'item.completed' && item.type === 'agent_message' && String(item.text || '').trim()) { st.lastText = item.text; emit(ev.text(item.text, t.model)); }
            else if (e.type === 'item.completed' && item.type === 'file_change') {
                (item.changes || [{}]).forEach((ch, i) => {
                    const kind = ch.kind && typeof ch.kind === 'object' ? ch.kind.type : ch.kind;
                    emit(ev.toolUse(`${id}:${i}`, kind === 'add' ? 'Write' : kind === 'delete' ? 'Delete' : 'Edit', { file_path: ch.path || '' }, t.model));
                    emit(ev.toolResult(`${id}:${i}`, item.status === 'failed' ? 'patch failed' : `${kind || 'update'} applied`, item.status === 'failed'));
                });
            } else if ((e.type === 'item.started' || e.type === 'item.completed') && ['command_execution', 'mcp_tool_call', 'web_search'].includes(item.type)) {
                if (!st.started.has(id)) { st.started.add(id); const [name, input] = CODEX_TOOL(item); emit(ev.toolUse(id, name, input, t.model)); }
                if (e.type === 'item.completed') {
                    const failed = item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0);
                    const out = item.type === 'command_execution' ? `${item.aggregated_output || ''}${item.exit_code ? `\n(exit ${item.exit_code})` : ''}` : (item.error ? String(item.error.message || item.error) : 'done');
                    emit(ev.toolResult(id, out, failed));
                }
            } else if (e.type === 'turn.completed') {
                const u = e.usage || {};
                st.usage.input += +u.input_tokens || 0; st.usage.cached += +u.cached_input_tokens || 0; st.usage.output += +u.output_tokens || 0;
            } else if (e.type === 'turn.failed' || e.type === 'error') {
                const why = String((e.error && (e.error.message || e.error)) || e.message || 'turn failed');
                if (why !== st.failed) emit(ev.error(why));      // Codex reports one failure as an error and a failed turn
                st.failed = why;
            }
        }, (info, emit, st) => {
            if (!st.sessionId && !st.lastText) return;     // nothing ran: the generic exit reason says why
            const u = st.usage || { input: 0, cached: 0, output: 0 };
            const ok = !st.failed && !!st.lastText && info.code === 0;
            emit(ev.result({ ok, text: ok ? st.lastText : (st.failed || exitReason(info, 'Codex')), sessionId: st.sessionId, model: t.model, startedAt, turns: st.turns || 0,
                usage: ev.usage({ input: u.input - u.cached, cacheRead: u.cached, output: u.output }) }));
        });
        return spawnAgent({ cmd: this.bin, args, cwd: t.cwd, env: ctx.env, timeoutMs: t.timeoutMs, signal: t.signal, parser });
    },
};

// ── OpenCode: `opencode run --format json` (text, tool_use, step_finish, error parts) ──
const OC_NAMES = { shell: 'Bash', bash: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', patch: 'Edit', multiedit: 'Edit', grep: 'Grep', glob: 'Glob', list: 'LS', webfetch: 'WebFetch', websearch: 'WebSearch', task: 'Task', todowrite: 'TodoWrite' };
const opencode = {
    id: 'opencode', name: 'OpenCode', kind: 'cli', bin: 'opencode',
    start(t, ctx = {}) {
        const args = ['run', '--format', 'json'];
        if (t.permission !== 'read') args.push('--auto');
        if (t.model) args.push('-m', t.model);
        if (t.resume) args.push('-s', t.resume);
        args.push('--', t.prompt);
        const startedAt = Date.now();
        const parser = jsonLines(opencode, (e, emit, st) => {
            st.startedAt = startedAt;
            st.u = st.u || { input: 0, output: 0, read: 0, write: 0, cost: 0 };
            if (e.sessionID && !st.sessionId) { st.sessionId = e.sessionID; emit(ev.init(e.sessionID, 'opencode', t.model)); }
            const p = e.part || {};
            if (e.type === 'tool_use') {
                const s = p.state || {};
                const input = { ...(s.input || {}) };
                if (input.path && !input.file_path) input.file_path = input.path;
                emit(ev.toolUse(p.id || p.partID, OC_NAMES[p.tool] || p.tool, input, t.model));
                emit(ev.toolResult(p.id || p.partID, s.status === 'error' ? String(s.error || 'the tool failed') : typeof s.output === 'string' ? s.output : JSON.stringify(s.output || ''), s.status === 'error'));
            } else if (e.type === 'text' && String(p.text || '').trim()) {
                st.lastText = (st.lastMsg === p.messageID ? `${st.lastText || ''}` : '') + p.text;
                st.lastMsg = p.messageID;
                emit(ev.text(p.text, t.model));
            } else if (e.type === 'step_finish') {
                const k = p.tokens || {};
                st.turns = (st.turns || 0) + 1;
                st.u.input += k.input || 0; st.u.output += (k.output || 0) + (k.reasoning || 0); st.u.read += (k.cache && k.cache.read) || 0; st.u.write += (k.cache && k.cache.write) || 0; st.u.cost += +p.cost || 0;
            } else if (e.type === 'error') {
                st.failed = String((e.error && (e.error.message || e.error.type)) || 'unknown error');
                emit(ev.error(st.failed));
            }
        }, (info, emit, st) => {
            if (!st.sessionId && !st.lastText) return;
            const u = st.u || { input: 0, output: 0, read: 0, write: 0, cost: 0 };
            const final = String(st.lastText || '').trim();
            emit(ev.result({ ok: !!final && !st.failed, text: final || st.failed || exitReason(info, 'OpenCode'), sessionId: st.sessionId, model: t.model, startedAt, turns: st.turns || 0, costUsd: u.cost,
                usage: ev.usage({ input: u.input, output: u.output, cacheRead: u.read, cacheWrite: u.write }) }));
        });
        return spawnAgent({ cmd: this.bin, args, cwd: t.cwd, env: ctx.env, timeoutMs: t.timeoutMs, signal: t.signal, parser });
    },
};

// ── Command Code: `cmd --print --output-format json` (run_start, message_end, tool_* events, result) ──
const CC_NAMES = { read_file: 'Read', shell: 'Bash', run_shell: 'Bash', shell_command: 'Bash', read_directory: 'LS', grep: 'Grep', glob: 'Glob', edit_file: 'Edit', write_file: 'Write', list_directory: 'LS', web_fetch: 'WebFetch', task: 'Task' };
const commandCode = {
    id: 'command-code', name: 'Command Code', kind: 'cli', bin: 'cmd',
    start(t, ctx = {}) {
        const args = [`--print=${t.prompt}`, '--output-format', 'json', '--skip-onboarding', '--no-auto-update', '-t'];
        if (t.permission !== 'read') args.push('--yolo');
        if (t.model) args.push('-m', t.model);
        if (t.resume) args.push('--resume', t.resume);
        if (t.maxTurns) args.push('--max-turns', String(t.maxTurns));
        const startedAt = Date.now();
        const parser = jsonLines(commandCode, (f, emit, st) => {
            st.startedAt = startedAt;
            if (f.type === 'result') {
                const err = f.subtype === 'error' ? String((f.error && (f.error.message || f.error)) || 'unknown error') : null;
                const u = f.usage || {};
                emit(ev.result({ ok: f.subtype === 'success', text: f.finalText || err || '', sessionId: f.sessionId || st.sessionId, model: st.model, startedAt,
                    usage: ev.usage({ input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadTokens, cacheWrite: u.cacheWriteTokens }) }));
                return;
            }
            const e = f.type === 'event' && f.event;
            if (!e) return;
            if (e.type === 'run_start') { st.sessionId = e.sessionId; emit(ev.init(e.sessionId, 'command-code', t.model)); }
            else if (e.type === 'model_request_start') st.model = e.model || st.model;
            else if (e.type === 'message_end') {
                for (const c of e.content || []) {
                    if (c.type === 'text' && String(c.text || '').trim()) emit(ev.text(c.text, st.model));
                    else if (c.type === 'tool_use') emit(ev.toolUse(c.id, CC_NAMES[c.name] || c.name, c.input || {}, st.model));
                }
            } else if (e.type === 'tool_completed') emit(ev.toolResult(e.toolCallId, (e.result || []).map((r) => r.text || '').join('\n'), !!e.isError));
            else if (['tool_denied', 'tool_failed', 'tool_error', 'tool_cancelled'].includes(e.type)) emit(ev.toolResult(e.toolCallId, e.type === 'tool_denied' ? 'denied by the permission level' : String(e.error || e.message || e.type), true));
            else if (e.type === 'error' || e.type === 'run_error') emit(ev.error(typeof (e.message || e.error) === 'object' ? JSON.stringify(e.message || e.error) : String(e.message || e.error || 'unknown')));
        });
        return spawnAgent({ cmd: this.bin, args, cwd: t.cwd, env: ctx.env, timeoutMs: t.timeoutMs, signal: t.signal, parser });
    },
};

// ── Aider: plain text on stdout; the answer is what it printed ──
const aider = {
    id: 'aider', name: 'Aider', kind: 'cli', bin: 'aider',
    start(t, ctx = {}) {
        const args = ['--message', t.prompt, '--yes-always', '--no-pretty', '--no-stream', '--no-check-update', '--no-show-release-notes'];
        if (t.permission === 'read') args.push('--dry-run');
        if (t.model) args.push('--model', t.model);
        const startedAt = Date.now();
        const lines = [];
        let started = false;
        const parser = {
            line(raw, emit) { if (!started) { started = true; emit(ev.init(null, 'aider', t.model)); } lines.push(raw); },
            end(info, emit) {
                const out = lines.join('\n').trim();
                if (out) emit(ev.text(out.slice(-8000), t.model));
                emit(ev.result({ ok: info.code === 0 && !!out, text: info.code === 0 && out ? out.slice(-2000) : exitReason(info, 'Aider'), model: t.model, startedAt }));
            },
        };
        return spawnAgent({ cmd: this.bin, args, cwd: t.cwd, env: ctx.env, timeoutMs: t.timeoutMs, signal: t.signal, parser });
    },
};


// ── MiniMax Code: `mcode exec --input - --output-format stream-json` (the portal's mm-run.sh) ──
// The argv is the portal's own: the brief rides in on stdin (--input -), the rules would ride in the appended system
// prompt, and the permission is one of mcode's own policies (smart, full, off: "ask" needs the TUI, which a job has
// not). The key is the person's own MiniMax sign-in on this machine; nothing of ours is read, and nothing is written.
const MM_PERMISSION = { read: 'off', edit: 'smart', full: 'full' };

const minimaxCode = {
    id: 'minimax-code', name: 'MiniMax Code', kind: 'cli', bin: 'mcode',
    /** The version this machine has (asked of the binary itself, never read from a file of ours). */
    version: (env) => versionOf('mcode', env),
    start(t, ctx = {}) {
        const args = ['exec', '--input', '-', '--output-format', 'stream-json', '--prompt-mode', 'coding',
            '--permission', MM_PERMISSION[t.permission] || 'smart', '--cwd', t.cwd || process.cwd(),
            '--timeout', `${Math.max(1, Math.ceil((t.timeoutMs || 45 * 60_000) / 60_000))}m`,
            '--max-steps', String(t.maxTurns || 150)];
        if (t.model) args.push('--model', t.model);
        const effort = effortFor('minimax-code', t.effort);
        if (effort) args.push('--effort', effort);
        if (t.resume) args.push('--session', String(t.resume));
        // Programmatic Tool Calling: the model batches its tool calls in one round trip (the portal's default).
        args.push('--ptc');
        const startedAt = Date.now();
        const parser = jsonLines(minimaxCode, (o, emit, st) => {
            st.startedAt = startedAt;
            if (o.sessionId) st.sessionId = o.sessionId;
            const it = o.item || {};
            const initOnce = () => { if (!st.inited) { st.inited = true; emit(ev.init(st.sessionId, 'minimax-code', t.model)); } };
            if (o.type === 'item.started' && (it.type === 'agent_message' || it.type === 'reasoning')) initOnce();
            else if (o.type === 'item.completed' && it.type === 'agent_message') {
                initOnce();
                const text = String(it.content || it.contentDelta || it.text || '');
                if (text.trim()) { st.lastText = text; emit(ev.text(text, t.model)); }
            } else if (o.type === 'item.completed' && (it.type === 'tool_use' || it.type === 'tool_call')) {
                initOnce();
                emit(ev.toolUse(it.id || it.toolCallId || it.callId || '', it.name || it.toolName || 'tool', it.input || it.arguments || {}, t.model));
            } else if (o.type === 'item.completed' && it.type === 'tool_result') {
                emit(ev.toolResult(it.toolCallId || it.callId || it.id || '', String(it.output || it.content || it.result || ''), !!(it.isError || it.status === 'failed')));
            } else if (o.type === 'turn.failed') {
                st.failed = String((o.error && (o.error.message || o.error)) || 'turn failed');
                emit(ev.error(st.failed));
            } else if (o.type === 'exec.completed') {
                initOnce();
                const r = o.result || {};
                const answer = String(r.answer || r.output || '');
                if (answer) { st.answer = answer; st.lastText = answer; }
                if (r.status) st.status = String(r.status);
            } else if (o.type === 'result') {
                initOnce();
                st.answer = String(o.result || '') || st.answer;
            }
        }, (info, emit, st) => {
            if (!st.sessionId && !st.lastText && !st.answer) return;   // nothing ran: the generic exit reason says why
            const text = String(st.answer || st.lastText || '');
            const bad = st.status && st.status !== 'succeeded';
            const ok = !st.failed && !bad && info.code === 0 && !!text;
            const why = st.failed || (bad ? `MiniMax Code stopped with the status ${st.status}` : null) || exitReason(info, 'MiniMax Code');
            emit(ev.result({ ok, text: ok ? text : why, sessionId: st.sessionId, model: t.model, startedAt }));
        });
        return spawnAgent({ cmd: this.bin, args, cwd: t.cwd, env: ctx.env, timeoutMs: t.timeoutMs, signal: t.signal, parser, stdin: t.prompt });
    },
};

// ── Claude Code on another provider: the same CLI, the cm-style environment (the portal's cm-run.sh) ──
// The endpoint and the model come from the person's own connection (Codes C3): the base URL and the run token travel
// in the environment, and the model id rides in ANTHROPIC_MODEL. No provider is named here: this harness is whatever
// Anthropic-compatible endpoint the person connected, not one of ours.
const ANTHROPIC_ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS'];

const claudeOther = {
    id: 'claude-other', name: 'Claude Code (another provider)', kind: 'cli', bin: 'claude',
    /** The version this machine has (asked of the binary itself). */
    version: (env) => versionOf('claude', env),
    /** What this harness needs before it can run: the connection's endpoint and its token. */
    check(env) {
        if (!env.ANTHROPIC_BASE_URL) return { available: false, reason: 'set ANTHROPIC_BASE_URL (the endpoint of your connection)' };
        if (!env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) return { available: false, reason: 'set ANTHROPIC_AUTH_TOKEN (the run token of your connection)' };
        return { available: true };
    },
    start(t, ctx = {}) {
        const env = ctx.env || {};
        const mode = { read: 'plan', edit: 'acceptEdits', full: 'bypassPermissions' }[t.permission] || 'plan';
        const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
            '--permission-mode', mode, '--exclude-dynamic-system-prompt-sections'];
        if (t.maxTurns) args.push('--max-turns', String(t.maxTurns));
        if (t.resume) args.push('--resume', String(t.resume));
        // Even unattended, a run never pushes: publishing is the person's step.
        args.push('--disallowedTools', 'Bash(git push:*)');
        // The harness's environment (PATH finds the CLI), with the connection's own names on top: the endpoint, the
        // token and the model id. The key travels in the environment, never in argv: the process list of this machine
        // is readable.
        const childEnv = { ...env };
        for (const name of ANTHROPIC_ENV) if (env[name]) childEnv[name] = env[name];
        const model = t.model || env.ANTHROPIC_MODEL || null;
        if (model) childEnv.ANTHROPIC_MODEL = model;
        const effort = effortFor('claude-other', t.effort);
        if (effort) childEnv.CLAUDE_CODE_EFFORT_LEVEL = effort;
        const startedAt = Date.now();
        const parser = jsonLines(claudeOther, (o, emit, st) => {
            if (o.type === 'system' && o.subtype === 'init') {
                st.sessionId = o.session_id; st.model = o.model || model;
                emit(ev.init(o.session_id, 'claude-other', st.model));
                return;
            }
            if (o.type === 'result') { st.sawResult = true; st.answer = String(o.result || ''); emit({ ...o, result: ev.scrub(o.result || '') }); return; }
            if (o.type === 'assistant' || o.type === 'user') emit(o);
        }, (info, emit, st) => {
            if (st.sawResult) return;                 // Claude Code's own result line already ended the run
            if (!st.sessionId && !st.answer) return;  // nothing ran: the generic exit reason says why
            const text = String(st.answer || '');
            const ok = info.code === 0 && !!text;
            emit(ev.result({ ok, text: ok ? text : exitReason(info, 'Claude Code'), sessionId: st.sessionId, model: st.model || model, startedAt }));
        });
        return spawnAgent({ cmd: this.bin, args, cwd: t.cwd, env: childEnv, timeoutMs: t.timeoutMs, signal: t.signal, parser, stdin: t.prompt });
    },
};

module.exports = { claudeCode, claudeOther, codex, opencode, commandCode, aider, minimaxCode, jsonLines, versionOf };
