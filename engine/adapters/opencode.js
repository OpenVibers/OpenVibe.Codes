'use strict';

/**
 * OpenCode (the `opencode` CLI).
 *
 * The argv comes from the portal's oc-run.sh:
 *
 *   opencode run --standalone --format json --auto -m MODEL [--s SESSION] --title TITLE -- BRIEF
 *
 * --standalone gives the attempt its own server, so stopping the attempt stops its work. The permission rules go in the
 * project's .opencode/opencode.json (the portal's way). The effort is the model's variant (model#low or model#high), the
 * portal's way of asking OpenCode for a reasoning level.
 */

const fs = require('fs');
const path = require('path');
const { claudeFeed, TOOL_NAMES, emitter } = require('./base');

/** The shell commands a job may not run (the portal's deny list). */
const DENY_SHELL = ['rm *', 'git commit *', 'git reset *', 'git checkout *', 'git clean *', 'git stash *', 'sudo *',
    'ssh *', 'scp *', 'curl *', 'wget *', 'npm install *', 'npm i *', 'npm ci *', 'npm publish *', 'npm uninstall *',
    'pnpm install *', 'kill *', 'pkill *', 'chmod *', 'tee *', 'dd *'];

/**
 * The model an effort asks for: the variant the portal uses (model#low or model#high), the plain model for anything
 * else.
 *
 * @param {string} model the model
 * @param {string} [effort] the wanted level
 * @returns {string} the model to run
 */
function variantFor(model, effort) {
    const m = String(model || '');
    if (!['low', 'high'].includes(effort) || m.includes('#')) return m;
    return `${m}#${effort}`;
}

/**
 * The argv and the environment for one OpenCode run.
 *
 * @param {object} ctx
 * @param {string} ctx.prompt the brief
 * @param {string} [ctx.model] the model
 * @param {string} [ctx.effort] the wanted reasoning level
 * @param {string} [ctx.resume] the session to continue
 * @param {string} [ctx.permission] 'read' | 'edit' | 'full'
 * @param {string} [ctx.title] the run's title
 * @returns {{cmd: string, argv: string[], env: object, stdin: string|null}} what to run
 */
function build(ctx = {}) {
    const model = variantFor(ctx.model, ctx.effort);
    const argv = ['run', '--standalone', '--format', 'json'];
    if (ctx.permission !== 'read') argv.push('--auto');
    if (model) argv.push('-m', model);
    if (ctx.resume) argv.push('-s', String(ctx.resume));
    if (ctx.title) argv.push('--title', String(ctx.title));
    argv.push('--', ctx.prompt || '');
    return { cmd: ctx.bin || 'opencode', argv, env: {}, stdin: null };
}

/**
 * The permission rules the project's .opencode/opencode.json holds.
 *
 * @param {object} opts
 * @param {string} opts.permission 'read' | 'edit' | 'full'
 * @returns {string} the settings file's content
 */
function settings({ permission = 'edit' } = {}) {
    const rule = (action, resource) => `{ "action": "${action}", "resource": "${resource}", "effect": "deny" }`;
    const rules = [rule('shell', 'git push *')];
    if (permission !== 'full') {
        for (const c of DENY_SHELL) rules.push(rule('shell', c));
        rules.push(rule('read', '.env*'), rule('read', '**/.env*'), rule('edit', '.git/**'));
    }
    if (permission === 'read') rules.push(rule('edit', '*'));
    return `{ "permissions": [ ${rules.join(', ')}] }`;
}

/**
 * Write the permission rules into the project (the portal's way).
 *
 * @param {string} dir the project
 * @param {object} opts the options of settings()
 * @returns {string|null} the file that was written, or null when the repository tracks its own
 */
function writeSettings(dir, opts) {
    const file = path.join(dir, '.opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, settings(opts));
    return file;
}

/** The feed: OpenCode's events are turned into Claude Code's stream-json (the portal's oc-feed.js). */
function feed({ model, onEvent }) {
    const state = { sessionId: null, model, lastText: '', failed: null, steps: 0, usage: null };
    const emit = emitter(onEvent);
    return {
        state,
        line(raw) {
            let e; try { e = JSON.parse(raw); } catch { if (String(raw).trim()) emit({ type: 'system', subtype: 'stderr', text: String(raw).slice(0, 500) }); return; }
            if (!e || typeof e !== 'object') return;
            if (e.sessionID && !state.sessionId) {
                state.sessionId = e.sessionID;
                emit({ type: 'system', subtype: 'init', session_id: state.sessionId, backend: 'opencode', model });
            }
            const p = e.part || {};
            if (e.type === 'tool_use') {
                const st = p.state || {}, err = st.status === 'error';
                const input = { ...((st.input) || {}) };
                if (input.path && !input.file_path) input.file_path = input.path;
                emit({ type: 'assistant', message: { model, content: [{ type: 'tool_use', id: p.id || p.partID, name: TOOL_NAMES[p.tool] || p.tool, input }] } });
                const text = err ? String(st.error || 'the tool failed') : typeof st.output === 'string' ? st.output : JSON.stringify(st.output || '');
                emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: p.id || p.partID, content: text.slice(0, 4000), is_error: err }] } });
            } else if (e.type === 'text' && p.text && String(p.text).trim()) {
                state.lastText = (state.lastText || '') + p.text;
                emit({ type: 'assistant', message: { model, content: [{ type: 'text', text: p.text }] } });
            } else if (e.type === 'step_finish') {
                state.steps++;
                const t = p.tokens || {};
                state.usage = { input_tokens: t.input || 0, output_tokens: (t.output || 0) + (t.reasoning || 0), cache_read_input_tokens: (t.cache && t.cache.read) || 0, cache_creation_input_tokens: (t.cache && t.cache.write) || 0 };
                emit({ type: 'assistant', message: { model, content: [], usage: state.usage } });
            } else if (e.type === 'error') {
                const msg = String((e.error && (e.error.message || e.error.type)) || 'unknown error').slice(0, 400);
                state.failed = msg;
                emit({ type: 'system', subtype: 'error', text: `API Error: ${msg}` });
            }
        },
        end(info) {
            const final = String(state.lastText || '').trim();
            const err = state.failed && !final ? `API Error: ${state.failed}` : null;
            emit({
                type: 'result', subtype: err || !final ? 'error' : 'success', is_error: !!(err || !final),
                result: final || err || 'API Error: OpenCode ended without an answer (a limit, a refusal or a crash: check its exit code)',
                duration_ms: 0, num_turns: state.steps, session_id: state.sessionId, model,
                total_cost_usd: 0, usage: state.usage || { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            });
        },
    };
}

const opencode = { id: 'opencode', name: 'OpenCode', kind: 'cli', bin: 'opencode', portal: 'oc-run.sh', effortLevels: [], build, feed, settings, writeSettings, variantFor };

module.exports = { opencode, variantFor };
