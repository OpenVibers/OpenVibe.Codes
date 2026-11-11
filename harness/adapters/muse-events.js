'use strict';
const ev = require('../events');
const names = { shell: 'Bash', exec: 'Bash', read: 'Read', read_file: 'Read', write_file: 'Write', edit_file: 'Edit', apply_patch: 'Edit', web_search: 'WebSearch', web_fetch: 'WebFetch', grep: 'Grep', glob: 'Glob' };
const resultText = (v) => typeof v === 'string' ? v : v && (v.stdout || v.text || v.output) || JSON.stringify(v || '');
/** Muse's recorded session envelopes (mu-feed.js), plus the flat form used by older builds. */
function museEvent(o, emit, st, model) {
    const type = o.payload_type || o.type;
    const p = o.payload || o;
    const e = p.event || p;
    st.tools = st.tools || {};
    st.answered = st.answered || new Set();
    const session = o.stream && o.stream.id || p.session_id || p.sessionId;
    if (session && !st.sessionId) { st.sessionId = session; emit(ev.init(session, 'muse', model)); }
    const id = e.task_id || p.call_id || p.tool_call_id || p.task_id;
    const call = (name, input) => {
        if (!id || st.tools[id] || st.answered.has(id)) return;
        st.tools[id] = name;
        let args = input || {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { description: args }; } }
        emit(ev.toolUse(id, names[name] || name, args, model));
    };
    if (type === 'run.output.delta') {
        const text = String(p.delta || p.text || '');
        if (text) { st.lastText = (st.lastText || '') + text; emit(ev.text(text, model)); }
    } else if (type === 'run.usage') st.usage = p.usage || p;
    else if (/^run.terminal.(failed|cancelled)$/.test(type)) st.failed = String(p.error?.message || p.error || p.text || 'Muse run failed');
    else if (type === 'run.terminal.completed' && (p.text || p.final_text)) st.lastText = p.text || p.final_text;
    else if (type === 'task.lifecycle.started') {
        const kind = String(e.task_kind || p.task_kind || '');
        if (/^(tool[._:]|shell$|read_file$|web_search$)/.test(kind)) call(kind.replace(/^tool[._:]/, ''), e.arguments || e.input || p.arguments || p.input);
    } else if (type === 'tool.result' || /^task.lifecycle.(completed|failed|cancelled|timed_out|output|tool_output_ref)$/.test(type)) {
        if (st.answered.has(id)) return;
        const output = e.final_result ?? e.output ?? e.result ?? p.result ?? p.output ?? p.content ?? p.text;
        let decoded = output;
        if (typeof output === 'string') { try { decoded = JSON.parse(output); } catch { /* plain output */ } }
        if (type === 'tool.result' && !st.tools[id]) {
            // Some builds reveal the tool only in its result blob.
            const input = decoded && typeof decoded === 'object' && decoded.command ? { command: decoded.command } : e.arguments || p.arguments;
            call(input && input.command ? 'shell' : p.tool_name || e.tool_name || 'tool', input);
        }
        if (!st.tools[id]) return;
        st.answered.add(id);
        emit(ev.toolResult(id, resultText(output), !!p.is_error || !!e.is_error || /failed|cancelled|timed_out/.test(type)));
    } else if (o.type === 'assistant' || o.type === 'user') emit(o);
}
module.exports = { museEvent };
