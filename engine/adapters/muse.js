'use strict';

const { effortFor, emitter } = require('./base');

function build(ctx = {}) {
    const argv = ['exec', '--json', '--prompt-file', '-', '--workspace', ctx.cwd || process.cwd(), '--disable-request-user-input', '--contributor-mode', 'off'];
    if (ctx.model) argv.push('--model', ctx.model);
    const effort = effortFor('muse', ctx.effort);
    if (effort) argv.push('--reasoning-effort', effort);
    if (ctx.resume) argv.push('--session-id', String(ctx.resume));
    return { cmd: ctx.bin || 'muse', argv, env: {}, stdin: ctx.prompt || '' };
}

function feed({ model, onEvent }) {
    const state = { sessionId: null, lastText: '', failed: null, usage: null };
    const emit = emitter(onEvent);
    return { state, line(raw) {
        let e; try { e = JSON.parse(raw); } catch { if (String(raw).trim()) emit({ type: 'system', subtype: 'stderr', text: String(raw).slice(0, 500) }); return; }
        if (!e || typeof e !== 'object') return;
        if (e.type === 'run.output.delta') {
            const d = String(e.delta || e.text || ''); if (d) { state.lastText += d; emit({ type: 'assistant', message: { model, content: [{ type: 'text', text: d }] } }); }
        } else if (e.type === 'task.lifecycle.started') {
            state.sessionId = e.session_id || e.sessionId || state.sessionId;
            emit({ type: 'system', subtype: 'init', session_id: state.sessionId, backend: 'muse', model });
        } else if (e.type === 'run.usage') {
            state.usage = e.usage || e;
        } else if (e.type === 'run.terminal.completed' || e.type === 'run.terminal.failed') {
            if (e.session_id || e.sessionId) state.sessionId = e.session_id || e.sessionId;
            if (e.error) state.failed = String(e.error.message || e.error);
        }
    }, end(info) {
        const ok = !state.failed && !!state.lastText && (!info || info.code === 0);
        emit({ type: 'result', subtype: ok ? 'success' : 'error', is_error: !ok,
            result: ok ? state.lastText : (state.failed || 'Muse Code ended without a result (check its sign-in and exit code)'),
            session_id: state.sessionId, model, usage: state.usage || undefined });
    } };
}

const muse = { id: 'muse', name: 'Muse Code', kind: 'cli', bin: 'muse', portal: 'muse', effortLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], build, feed };
module.exports = { muse, build, feed };
