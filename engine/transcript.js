'use strict';

/**
 * One conversation shape for every harness's log, so a task reads the same whoever worked on it.
 *
 * The harnesses speak different languages: Claude Code stream-json (Claude, Claude on DeepSeek), the runners'
 * converted feeds (Codex, Command Code, OpenCode Go), DeepSeek's `dsh --json` and MiniMax Code's
 * `mcode exec --output-format stream-json`. This module turns all of them into one event shape:
 *
 *   { t, text, name, input, output, at, … }
 *
 * `t` is the kind of event ('user', 'text', 'thinking', 'tool', 'error', 'final', 'meta'), `at` is when it happened
 * (ISO 8601), and a tool event carries its `name`, its `input` and, once it arrives, its `output`. The whole shape is
 * described in transcript.schema.json.
 *
 * Parsing is incremental per file: only the bytes added since the last read are parsed, so polling a running task
 * every second or two stays cheap. `parseText` does the same for a stream that is already in memory.
 */

const fs = require('fs');

const OUT_CAP = 8000;
const CACHE_BYTES = 32 * 1024 * 1024;
const cache = new Map();
let cacheBytes = 0;

/** Forget a file's parsed state (its log was truncated or removed). */
function forget(file) {
    const entry = cache.get(file);
    if (entry) cacheBytes -= entry.bytes;
    cache.delete(file);
}

/** Remember a file's parsed state, within the cache's size. */
function remember(file, state) {
    forget(file);
    const bytes = state.events.reduce((total, event) => total + JSON.stringify(event).length * 2 + 512, 1024)
        + state.byId.size * 128;
    if (bytes > CACHE_BYTES) return;
    while (cache.size >= 60 || cacheBytes + bytes > CACHE_BYTES) forget(cache.keys().next().value);
    cache.set(file, { state, bytes });
    cacheBytes += bytes;
}

/** A value as text, clipped, with the ANSI colours stripped. */
function clip(v, n = OUT_CAP) {
    let s = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v, null, 2);
    s = s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    return s.length > n ? { text: s.slice(0, n), more: s.length - n } : { text: s, more: 0 };
}

/** The kind of a tool, from its name. */
function kindOf(name) {
    const n = String(name || '').toLowerCase();
    if (/bash|shell|exec|command|terminal|run_?cmd/.test(n)) return 'shell';
    if (/^(read|view|cat|read_?file|open)/.test(n)) return 'read';
    if (/edit|write|patch|create_?file|replace|multiedit|str_replace/.test(n)) return 'edit';
    if (/grep|glob|search_?files|find|list|ls|rg/.test(n) && !/web/.test(n)) return 'search';
    if (/web|fetch|browse|url|http/.test(n)) return 'web';
    if (/todo|task|agent|plan/.test(n)) return 'plan';
    return 'tool';
}

/** One line about what a tool was asked to do. */
function summary(name, input) {
    if (input == null) return '';
    if (typeof input !== 'object') return String(input).replace(/\s+/g, ' ').slice(0, 220);
    let v = input.command || input.cmd || input.file_path || input.filePath || input.path || input.pattern || input.query || input.url
        || input.description || input.prompt || Object.values(input).find((x) => typeof x === 'string');
    if (Array.isArray(v)) v = v.join(' ');
    v = String(v || '');
    // Codex wraps every command as /bin/bash -lc "…".
    const m = v.match(/^\/bin\/(?:ba)?sh -lc (['"])([\s\S]*)\1$/);
    if (m) v = m[2];
    // "cd <job folder> && …" says nothing new: show the command itself.
    v = v.replace(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(&&|;)\s*/, '');
    return v.replace(/\s+/g, ' ').slice(0, 220);
}

/** The text of a content block, of any shape. */
function textOf(c) {
    if (c == null) return '';
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : b && (b.text || b.content || (b.type === 'image' ? '[image]' : '')) || '')).join('\n');
    if (typeof c === 'object') return c.text || c.content || c.output || JSON.stringify(c, null, 2);
    return String(c);
}

/** A tool input as data, when it is a JSON string. */
function inputOf(raw) {
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return raw; } }
    return raw;
}

/** An empty parse state. */
function freshState() {
    return { offset: 0, line: 0, events: [], byId: new Map(), session: null, model: null, cwd: null, usage: { input: 0, output: 0, cached: 0 }, cost: null };
}

/** When an event happened, as ISO 8601. */
function atOf(ts) {
    if (ts == null || !Number.isFinite(Number(ts))) return null;
    try { return new Date(Number(ts)).toISOString(); } catch { return null; }
}

/** Add an event to the state, merging the ones that belong together. */
function push(st, ev) {
    if (ev.at === undefined) ev.at = atOf(ev.ts);
    const last = st.events[st.events.length - 1];
    // The same error reported twice in a row (a system error, then the result) shows once.
    if (ev.t === 'error' && st.events.slice(-3).some((e) => e.t === 'error' && e.text.trim() === String(ev.text).trim())) return st.events[st.events.length - 1];
    // Consecutive thinking (dsh emits one per step) and streamed message deltas merge into one block.
    if (last && ev.t === last.t && !ev.mid && !last.mid && (ev.t === 'thinking' || (ev.t === 'text' && ev.delta && last.delta))) {
        last.text = (last.text + (ev.t === 'thinking' && !ev.delta ? '\n\n' : '') + ev.text).slice(-20000);
        return last;
    }
    ev.i = st.events.length;
    st.events.push(ev);
    return ev;
}

/** Add a tool call. */
function addTool(st, id, name, input, line, ts) {
    const inp = inputOf(input);
    const ev = push(st, { t: 'tool', id: id || `t${st.events.length}`, name: name || 'tool', kind: kindOf(name), summary: summary(name, inp), input: clip(inp, 6000), pending: true, line, ts });
    st.byId.set(ev.id, ev.i);
    return ev;
}

/** Add the result of a tool call. */
function setResult(st, id, output, isError) {
    const i = st.byId.get(id);
    if (i == null) return false;
    const ev = st.events[i];
    const out = clip(textOf(output));
    ev.output = out;
    ev.pending = false;
    ev.isError = !!isError || /\[exit code: [1-9]\d*\]|^Exit code [1-9]|\bexit_code["']?:\s*[1-9]/.test(out.text.slice(-200));
    const m = out.text.match(/\[exit code: (\d+)\]|Exit code (\d+)/);
    if (m) ev.exit = Number(m[1] || m[2]);
    ev.v = (ev.v || 0) + 1;
    return true;
}

// A streamed piece of a message (Claude Code with --include-partial-messages): it grows in one place and is
// replaced by the whole message when that arrives, so the same words are never shown twice.
function pushDelta(st, ev) {
    for (let i = st.events.length - 1; i >= 0; i--) {
        const e = st.events[i];
        if (e.t !== ev.t) continue;
        if (e.partial) { e.text = (e.text + ev.text).slice(-20000); e.v = (e.v || 0) + 1; return e; }
        break;
    }
    // mid keeps the delta apart from the block before it (push merges two thinking blocks otherwise).
    const p = { ...ev, partial: true, mid: true };
    ev.i = st.events.length;
    st.events.push(p);
    return p;
}

const lastPartial = (st, t) => {
    for (let i = st.events.length - 1; i >= 0; i--) if (st.events[i].t === t && st.events[i].partial) return st.events[i];
    return null;
};

function finalEv(st, text, extra, line, ts) {
    let t = String(text || '').trim();
    if (t && st.events.slice(-4).some((e) => e.t === 'error' && e.text.trim() === t)) t = '';
    const last = [...st.events].reverse().find((e) => e.t === 'text');
    // Claude's result repeats its last message: mark that message as the answer instead of printing it twice.
    if (last && t && last.text.trim() === t) { last.answer = true; last.v = (last.v || 0) + 1; return push(st, { t: 'final', text: '', ...extra, line, ts }); }
    return push(st, { t: 'final', text: t, ...extra, line, ts });
}

// MiniMax repeats a turn's usage in exec.completed, including partial usage when
// turn.failed has none. Account for each turn once, adding only newly reported tokens.
function minimaxUsage(st, e, payload = e) {
    const u = payload.usage;
    if (!u) return;
    const key = `${e.runId || payload.runId || ''}:${e.turnId || payload.turnId || ''}`;
    if (!st.minimaxUsage) st.minimaxUsage = new Map();
    const previous = st.minimaxUsage.get(key) || { input: 0, output: 0, cached: 0 };
    const cached = Number(u.cacheReadTokens || u.cachedInputTokens || u.cache_read_input_tokens || 0);
    const current = { input: Number(u.inputTokens || u.input_tokens || 0) + cached,
        output: Number(u.outputTokens || u.output_tokens || 0), cached };
    for (const field of ['input', 'output', 'cached']) {
        current[field] = Math.max(previous[field], current[field]);
        st.usage[field] += current[field] - previous[field];
    }
    st.minimaxUsage.set(key, current);
}

/** Read one event of a harness' feed. */
function handle(st, e, line) {
    const ts = e._ts || e.timestampMs || (e.timestamp ? Date.parse(e.timestamp) : null) || null;
    const type = e.type;
    // MiniMax Code (schemaVersion 1 events).
    if (e.schemaVersion && typeof type === 'string' && /\./.test(type)) {
        if (e.sessionId) st.session = e.sessionId;
        // A tool call arrives as item.started / item.updated / item.completed with its input and output inside toolCall
        // (status 2 = done); tools run inside Programmatic Tool Calling's run_code carry parentToolCallId.
        if (/^item\./.test(type) && e.item && e.item.type === 'tool_call' && e.item.toolCall) {
            const tc = e.item.toolCall, id = tc.id || e.item.id;
            let i = st.byId.get(id);
            if (i == null) { const ev = addTool(st, id, tc.name || tc.toolName, tc.input || tc.arguments, line, ts); if (tc.parentToolCallId) ev.nested = true; i = ev.i; }
            const ev = st.events[i];
            if (tc.input != null && !ev.summary) { const inp = inputOf(tc.input); ev.input = clip(inp, 6000); ev.summary = summary(ev.name, inp); ev.v = (ev.v || 0) + 1; }
            if (tc.output != null || type === 'item.completed') setResult(st, id, tc.output != null ? (tc.output.content || tc.output) : '', tc.isError || tc.status === 3 || /fail|error/i.test(String(tc.status)));
            return;
        }
        // A message or thought takes its place when it starts (so it precedes the tools it announces) and its text when complete.
        if (type === 'item.started' && e.item && (e.item.type === 'agent_message' || e.item.type === 'reasoning')) {
            const ev = push(st, { t: e.item.type === 'agent_message' ? 'text' : 'thinking', text: '', mid: e.item.id, line, ts });
            st.byId.set('m:' + e.item.id, ev.i);
            return;
        }
        if (type === 'item.completed' && e.item && st.byId.has('m:' + e.item.id)) {
            const ev = st.events[st.byId.get('m:' + e.item.id)];
            ev.text = textOf(e.item.content || e.item.contentDelta) || ev.text; ev.v = (ev.v || 0) + 1;
            return;
        }
        if (type === 'item.completed' && e.item) {
            const it = e.item;
            if (it.type === 'agent_message') push(st, { t: 'text', text: textOf(it.content || it.contentDelta), line, ts });
            else if (it.type === 'reasoning') push(st, { t: 'thinking', text: textOf(it.content || it.contentDelta), line, ts });
            else if (/tool_result|tool_output/.test(it.type)) setResult(st, it.toolCallId || it.callId || it.id, it.output || it.content || it.result, it.isError || it.status === 'failed');
        } else if (type === 'turn.completed') {
            if (e.model && e.model.modelId) st.model = e.model.modelId;
            minimaxUsage(st, e);
        } else if (type === 'turn.failed') push(st, { t: 'error', text: textOf(e.error && (e.error.message || e.error)) || `turn ${e.status || 'failed'}`, line, ts });
        else if (type === 'exec.completed' && e.result) {
            if (e.result.model && e.result.model.modelId) st.model = e.result.model.modelId;
            minimaxUsage(st, e, e.result);
            finalEv(st, e.result.answer || e.result.output || '', { isError: e.result.status && e.result.status !== 'succeeded', ms: e.result.durationMs }, line, ts);
        }
        return;
    }
    // DeepSeek's official harness (dsh --json).
    if (type === 'session' && e.sessionId) { st.session = e.sessionId; st.cwd = e.cwd || st.cwd; push(st, { t: 'meta', kind: 'start', session: e.sessionId, cwd: e.cwd, line, ts }); return; }
    if (type === 'tool_call') { addTool(st, e.callId, e.tool || e.name, e.input || e.arguments, line, ts); return; }
    if (type === 'tool_result' && e.callId) { setResult(st, e.callId, e.result != null ? e.result : e.output, e.status && e.status !== 'completed'); return; }
    if (type === 'thinking') { push(st, { t: 'thinking', text: String(e.text || ''), line, ts }); return; }
    if (type === 'text' && typeof e.text === 'string') { push(st, { t: 'text', text: e.text, line, ts }); return; }
    if (type === 'final') { finalEv(st, e.text, {}, line, ts); return; }
    if (type === 'status') { if (e.usage && e.phase === 'step_end') { const c = Number(e.usage.cacheReadTokens || 0); st.usage.input += Number(e.usage.inputTokens || e.usage.promptTokens || 0) + c; st.usage.output += Number(e.usage.outputTokens || e.usage.completionTokens || 0); st.usage.cached += c; } return; }
    if (type === 'error') { push(st, { t: 'error', text: textOf(e.message || e.text || e.error), line, ts }); return; }
    // Claude Code stream-json and the runners' feeds (the same shape).
    if (type === 'system') {
        if (e.subtype === 'init') {
            st.session = e.session_id || st.session; st.model = e.model || st.model; st.cwd = e.cwd || st.cwd;
            push(st, { t: 'meta', kind: 'start', session: e.session_id, model: e.model, backend: e.backend, cwd: e.cwd, permission: e.permissionMode, line, ts });
        } else if (e.subtype === 'error') push(st, { t: 'error', text: String(e.text || e.message || 'error'), line, ts });
        else if (e.subtype === 'usage' && e.usage) { st.usage.input += Number(e.usage.input || 0); st.usage.output += Number(e.usage.output || 0); st.usage.cached += Number(e.usage.cached || 0); }
        else if (e.subtype === 'compact_boundary') push(st, { t: 'meta', kind: 'compact', line, ts });
        return;
    }
    // Claude Code's partial messages: the text and the thinking arrive as deltas while the turn runs.
    if (type === 'stream_event') {
        const ev = e.event || {};
        if (ev.type === 'content_block_delta') {
            const d = ev.delta || {};
            if (d.type === 'text_delta' && d.text) pushDelta(st, { t: 'text', text: d.text, line, ts });
            else if (d.type === 'thinking_delta' && (d.thinking || d.text)) pushDelta(st, { t: 'thinking', text: d.thinking || d.text, line, ts });
        }
        return;
    }
    if (type === 'assistant' && e.message) {
        if (e.message.model && e.message.model !== '<synthetic>') st.model = e.message.model;   // Claude Code's own error messages say <synthetic>
        const u = e.message.usage;
        // Command Code's feed says includes_cache: input_tokens already holds the cached tokens, so adding them again
        // doubled its prompt volume and halved its shown cache rate (session-analysis 2026-10-29 §1.1).
        if (u) { const inc = u.includes_cache === true; st.usage.input += Number(u.input_tokens || 0) + (inc ? 0 : Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0)); st.usage.output += Number(u.output_tokens || 0); st.usage.cached += Number(u.cache_read_input_tokens || 0); }
        const content = Array.isArray(e.message.content) ? e.message.content : [{ type: 'text', text: textOf(e.message.content) }];
        for (const b of content) {
            if (!b) continue;
            if (b.type === 'text' && b.text && b.text.trim()) {
                // The whole message replaces what was streamed, so the words appear once.
                const p = lastPartial(st, 'text');
                if (p) { p.text = b.text; p.partial = false; p.v = (p.v || 0) + 1; }
                else push(st, { t: 'text', text: b.text, line, ts });
            }
            else if ((b.type === 'thinking' || b.type === 'reasoning') && (b.thinking || b.text)) {
                const p = lastPartial(st, 'thinking');
                if (p) { p.text = b.thinking || b.text; p.partial = false; p.v = (p.v || 0) + 1; }
                else push(st, { t: 'thinking', text: b.thinking || b.text, line, ts });
            }
            else if (b.type === 'tool_use') addTool(st, b.id, b.name, b.input, line, ts);
        }
        return;
    }
    if (type === 'user' && e.message) {
        const c = e.message.content;
        if (typeof c === 'string') { if (c.trim()) push(st, { t: 'user', text: c, line, ts }); return; }
        for (const b of c || []) {
            if (b && b.type === 'tool_result') setResult(st, b.tool_use_id, b.content, b.is_error);
            else if (b && b.type === 'text' && b.text && !/^<|^\[Request interrupted/.test(b.text.trim())) push(st, { t: 'user', text: b.text, line, ts });
        }
        return;
    }
    if (type === 'result') {
        if (e.session_id) st.session = e.session_id;
        if (e.total_cost_usd != null) st.cost = (st.cost || 0) + Number(e.total_cost_usd);
        const u = e.usage || {};
        const tokens = Number(u.input_tokens || u.inputTokens || 0) + Number(u.output_tokens || u.outputTokens || 0);
        finalEv(st, e.result, { isError: !!e.is_error, ms: e.duration_ms, turns: e.num_turns, cost: e.total_cost_usd, tokens: tokens || null }, line, ts);
    }
}

/**
 * Parse a stream that is already in memory.
 *
 * @param {string} text the jsonl feed
 * @returns {object} the state: { events, session, model, cwd, usage, cost, line }
 */
function parseText(text) {
    const st = freshState();
    for (const l of String(text || '').split('\n')) {
        st.line++;
        if (!l || l[0] !== '{') continue;
        let e; try { e = JSON.parse(l); } catch { continue; }
        try { handle(st, e, st.line); } catch { /* one odd event never breaks the view */ }
    }
    return st;
}

/**
 * Parse what was added to the file since the last call; returns the cached state.
 *
 * @param {string} file the jsonl feed
 * @returns {object} the state
 */
function parse(file) {
    const entry = cache.get(file);
    let st = entry && entry.state;
    let size = 0;
    try { size = fs.statSync(file).size; } catch { forget(file); return freshState(); }
    if (!st || size < st.offset) { forget(file); st = freshState(); }
    if (size === st.offset) {
        if (entry && entry.state === st) { cache.delete(file); cache.set(file, entry); }
        return st;
    }
    const fd = fs.openSync(file, 'r');
    try {
        // Read in chunks; stop at the last complete line.
        while (st.offset < size) {
            const len = Math.min(size - st.offset, 4 * 1024 * 1024);
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, st.offset);
            const end = buf.lastIndexOf(10);
            if (end < 0) {
                if (len === size - st.offset) break;   // the last line is still being written
                st.offset += len;                      // a single line over 4 MB: skip it rather than stall
                continue;
            }
            for (const l of buf.subarray(0, end).toString('utf8').split('\n')) {
                st.line++;
                if (!l || l[0] !== '{') continue;
                let e; try { e = JSON.parse(l); } catch { continue; }
                try { handle(st, e, st.line); } catch { /* one odd event never breaks the view */ }
            }
            st.offset += end + 1;
        }
    } finally { fs.closeSync(fd); }
    remember(file, st);
    return st;
}

/**
 * The events from index `from`, plus where the client should ask from next time (the first tool still waiting).
 *
 * @param {object} st the state
 * @param {number} [from] the first event wanted
 * @param {number} [limit] how many events at most
 * @returns {object} { events, from, total, skipped, next, info }
 */
function view(st, from = 0, limit = 600) {
    const total = st.events.length;
    const open = st.events.findIndex((e) => e.t === 'tool' && e.pending);
    let start = Math.max(0, Math.min(from, total));
    let skipped = 0;
    if (start === 0 && total > limit) { skipped = total - limit; start = skipped; }
    return {
        events: st.events.slice(start),
        from: start, total, skipped,
        next: open >= 0 ? Math.min(open, total) : total,
        info: { session: st.session, model: st.model, cwd: st.cwd, usage: st.usage, cost: st.cost },
    };
}

// The few numbers a list of jobs needs from a log, memoised by the file's size and mtime: an unchanged log is never
// parsed again (the full parse cache above holds 60 files, and a busy day has hundreds). persistStats(file) keeps the
// memo across restarts.
const STATS = new Map();
let statsFile = null, statsDirty = false;

/** The numbers of a parsed stream: tools, edits, errors, tokens, cost. */
function statsOf(st) {
    const u = st.usage || { input: 0, output: 0, cached: 0 };
    let tools = 0, edits = 0, errs = 0, lastTool = '', lastErr = '';
    for (const e of st.events) {
        if (e.t === 'tool') { tools++; if (e.kind === 'edit') edits++; if (e.isError) errs++; lastTool = `${e.name} ${e.summary}`; }
        if (e.t === 'error' || (e.t === 'final' && e.isError && e.text)) lastErr = String(e.text).slice(0, 200);
    }
    return {
        tools, edits, errs, cost: Number.isFinite(st.cost) ? Number(st.cost) : null,
        input: u.input || 0, output: u.output || 0, cached: u.cached || 0,
        model: st.model || null, lastTool: lastTool.slice(0, 200), lastErr,
    };
}

/** The numbers of a log, memoised by the file's size and mtime. */
function stats(file) {
    let stt; try { stt = fs.statSync(file); } catch { return null; }
    const hit = STATS.get(file);
    if (hit && hit.size === stt.size && hit.mtime === stt.mtimeMs) return hit.s;
    const s = statsOf(parse(file));
    STATS.set(file, { size: stt.size, mtime: stt.mtimeMs, s });
    statsDirty = true;
    return s;
}

/** Keep the memo across restarts, in a file of the caller's choosing. */
function persistStats(file) {
    statsFile = file;
    try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) STATS.set(k, v); } catch { /* first run */ }
    setInterval(() => {
        if (!statsDirty || !statsFile) return;
        statsDirty = false;
        for (const k of STATS.keys()) if (!fs.existsSync(k)) STATS.delete(k);
        try { fs.writeFileSync(`${statsFile}.tmp`, JSON.stringify(Object.fromEntries(STATS))); fs.renameSync(`${statsFile}.tmp`, statsFile); } catch { statsDirty = true; }
    }, 30000).unref();
}

module.exports = { parse, parseText, view, summary, kindOf, textOf, clip, stats, statsOf, persistStats, atOf };
