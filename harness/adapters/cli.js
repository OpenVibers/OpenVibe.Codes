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
const ev = require('../events');
const { spawnAgent, exitReason } = require('../process');

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

module.exports = { claudeCode, codex, opencode, commandCode, aider, jsonLines };
