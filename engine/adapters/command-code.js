'use strict';

/**
 * Command Code (the `cmd` CLI).
 *
 * The argv comes from the portal's cc-run.sh:
 *
 *   cmd --print=BRIEF [--resume SESSION] [--yolo] -m MODEL --effort EFFORT --config compact-mode=fast
 *       --output-format json --max-turns N --skip-onboarding --no-auto-update -t
 *
 * The effort levels are the portal's for this harness: off, low, high and max (the 2026-10-29 incident: a job that
 * copied Codex's "medium" here died before its first step). The permission rules go in the project's
 * .commandcode/settings.local.json (the portal's way), never on the command line.
 */

const fs = require('fs');
const path = require('path');
const { effortFor, claudeFeed, TOOL_NAMES, emitter } = require('./base');

/** The tools a job may not use (the portal's deny list). */
const DENY = ['Shell(rm:*)', 'Shell(git push:*)', 'Shell(git commit:*)', 'Shell(git reset:*)', 'Shell(git checkout:*)',
    'Shell(git clean:*)', 'Shell(git stash:*)', 'Shell(sudo:*)', 'Shell(ssh:*)', 'Shell(scp:*)', 'Shell(npm test:*)',
    'Shell(npm install:*)', 'Shell(npm i:*)', 'Shell(npm ci:*)', 'Shell(pnpm install:*)', 'Shell(kill:*)', 'Shell(pkill:*)',
    'Shell(chmod:*)', 'Shell(tee:*)', 'Shell(dd:*)', 'Read(.env*)', 'Read(**/.env*)', 'Edit(.git/**)'];

/**
 * The argv and the environment for one Command Code run.
 *
 * @param {object} ctx
 * @param {string} ctx.prompt the brief (as --print=…, the portal's way)
 * @param {string} [ctx.model] the model
 * @param {string} [ctx.effort] the wanted reasoning level
 * @param {string} [ctx.resume] the session to continue
 * @param {string} [ctx.permission] 'read' | 'edit' | 'full'
 * @param {number} [ctx.maxTurns] the turn limit
 * @returns {{cmd: string, argv: string[], env: object, stdin: string|null}} what to run
 */
function build(ctx = {}) {
    const effort = effortFor('command-code', ctx.effort);
    const argv = [`--print=${ctx.prompt || ''}`];
    if (ctx.resume) argv.push('--resume', String(ctx.resume));
    if (ctx.permission === 'full') argv.push('--yolo');
    if (ctx.model) argv.push('-m', ctx.model);
    argv.push('--effort', effort || 'high');
    argv.push('--config', 'compact-mode=fast');
    argv.push('--output-format', 'json');
    argv.push('--max-turns', String(ctx.maxTurns || 150));
    argv.push('--skip-onboarding', '--no-auto-update', '-t');
    return { cmd: ctx.bin || 'cmd', argv, env: {}, stdin: null };
}

/**
 * The permission rules the project's .commandcode/settings.local.json holds.
 *
 * The portal writes them there (globally git-ignored) so they survive --yolo, and a read-only job may not edit or write
 * in the repository at all.
 *
 * @param {object} opts
 * @param {string} opts.permission 'read' | 'edit' | 'full'
 * @returns {string} the settings file's content
 */
function settings({ permission = 'edit' } = {}) {
    const deny = permission === 'full' ? ['Shell(git push:*)', 'Shell(pkill:*)', 'Shell(killall:*)'] : DENY.slice();
    if (permission === 'read') deny.push('Edit(**)', 'Write(**)');
    return `{ "permissions": { "deny": [${deny.map((d) => JSON.stringify(d)).join(', ')}] } }`;
}

/**
 * Write the permission rules into the project (the portal's way).
 *
 * @param {string} dir the project
 * @param {object} opts the options of settings()
 * @returns {string} the file that was written
 */
function writeSettings(dir, opts) {
    const file = path.join(dir, '.commandcode', 'settings.local.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, settings(opts));
    return file;
}

/** The feed: Command Code's events are turned into Claude Code's stream-json (the portal's cc-feed.js). */
function feed({ model, onEvent }) {
    const state = { sessionId: null, model, lastText: '', usage: null, failed: null };
    const emit = emitter(onEvent);
    return {
        state,
        line(raw) {
            let f; try { f = JSON.parse(raw); } catch { if (String(raw).trim()) emit({ type: 'system', subtype: 'stderr', text: String(raw).slice(0, 500) }); return; }
            if (!f || typeof f !== 'object') return;
            if (f.type === 'result') {
                const err = f.subtype === 'error' ? `API Error: ${String((f.error && (f.error.message || f.error)) || 'unknown error').slice(0, 300)}` : null;
                state.lastText = f.finalText || err || '';
                emit({ type: 'result', subtype: f.subtype, is_error: f.subtype !== 'success', result: f.finalText || err || '', duration_ms: f.durationMs || 0, usage: f.usage || null, session_id: f.sessionId || state.sessionId, model: state.model });
                return;
            }
            const e = f.type === 'event' && f.event;
            if (!e) return;
            if (e.type === 'run_start') { state.sessionId = e.sessionId; emit({ type: 'system', subtype: 'init', session_id: state.sessionId, backend: 'command-code' }); }
            else if (e.type === 'model_request_start') state.model = e.model || state.model;
            else if (e.type === 'model_request_end') state.usage = e.usage || null;
            else if (e.type === 'message_end') {
                const content = [];
                for (const c of e.content || []) {
                    if (c.type === 'text' && c.text && c.text.trim()) content.push({ type: 'text', text: c.text });
                    else if (c.type === 'tool_use') content.push({ type: 'tool_use', id: c.id, name: TOOL_NAMES[c.name] || c.name, input: c.input || {} });
                }
                if (content.length) emit({ type: 'assistant', message: { model: state.model, content, usage: state.usage } });
            } else if (e.type === 'tool_completed') {
                const text = (e.result || []).map((r) => r.text || '').join('\n');
                emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: e.toolCallId, content: text.slice(0, 4000), is_error: !!e.isError }] } });
            } else if (['tool_denied', 'tool_failed', 'tool_error', 'tool_cancelled'].includes(e.type)) {
                const why = e.type === 'tool_denied' ? "Denied by the job's permission rules" : String(e.error || e.message || e.type).slice(0, 400);
                emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: e.toolCallId, content: why, is_error: true }] } });
            } else if (e.type === 'error' || e.type === 'run_error') {
                const msg = typeof (e.message || e.error) === 'object' ? JSON.stringify(e.message || e.error) : String(e.message || e.error || 'unknown');
                state.failed = msg;
                emit({ type: 'system', subtype: 'error', text: `API Error: ${msg.slice(0, 300)}` });
            }
        },
        end(info) {
            if (!state.lastText && !state.failed) {
                emit({ type: 'result', subtype: 'error', is_error: true, result: 'API Error: Command Code ended without a result (credits, rate limit or a crash: check its exit code)', session_id: state.sessionId, model: state.model });
            }
        },
    };
}

const commandCode = { id: 'command-code', name: 'Command Code', kind: 'cli', bin: 'cmd', portal: 'cc-run.sh', effortLevels: ['off', 'low', 'high', 'max'], build, feed, settings, writeSettings, DENY };

module.exports = { commandCode, DENY };
