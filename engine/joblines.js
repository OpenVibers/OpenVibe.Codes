'use strict';

/**
 * The job lines (1.1): what a task's page shows while it runs and what its session keeps afterwards.
 *
 * The transcript normaliser (engine/transcript.js) turns every harness's log into one event shape; this turns those
 * events into the lines a reader sees. The kinds are the ones the session view knows (server/domain/run-tasks.js):
 *
 *   agent        the run started: which harness, which model
 *   text         what the agent said
 *   tool         a tool call (what it touched)
 *   tool_result  what that tool answered
 *   note         an error or a warning
 *   usage        the tokens the run spent
 *   done         the end of the attempt
 *
 * Nothing here prints a secret: every text goes through engine/redact.js first.
 */

const { scrub } = require('./redact');

/** The clip a line's text may take. */
const MAX_TEXT = 2000;
const clip = (s, n = MAX_TEXT) => { s = String(s == null ? '' : s); return s.length > n ? `${s.slice(0, n)}…` : s; };

/**
 * The job lines for the events added since index `from`.
 *
 * @param {object} st the transcript state
 * @param {number} [from] the first event to look at
 * @returns {{lines: object[], next: number}} the lines and where to look next time
 */
function lines(st, from = 0) {
    const out = [];
    const events = (st && st.events) || [];
    for (let i = Math.max(0, from); i < events.length; i++) {
        const e = events[i];
        if (e.t === 'meta' && e.kind === 'start') out.push({ t: 'agent', agent: e.backend || null, model: e.model || null, session: e.session || null });
        else if (e.t === 'text') out.push({ t: 'text', text: clip(scrub(e.text)) });
        else if (e.t === 'thinking') continue;                       // the reasoning is not the task's story
        else if (e.t === 'tool') {
            out.push({ t: 'tool', id: e.id || null, name: e.name || 'tool', what: clip(scrub(e.summary || ''), 200) });
            if (!e.pending && e.output) out.push({ t: 'tool_result', id: e.id || null, ok: !e.isError, text: clip(scrub(e.output.text || '')) });
        } else if (e.t === 'error') out.push({ t: 'note', level: 'error', text: clip(scrub(e.text)) });
        else if (e.t === 'final') out.push({ t: 'done', ok: !e.isError, text: clip(scrub(e.text)) });
    }
    return { lines: out, next: events.length };
}

/** The usage line of a finished run. */
function usageLine(st) {
    const u = (st && st.usage) || {};
    if (!u.input && !u.output && !u.cached) return null;
    return { t: 'usage', input: u.input || 0, output: u.output || 0, cached: u.cached || 0, cost_usd: st && Number.isFinite(st.cost) ? st.cost : null };
}

module.exports = { lines, usageLine, clip, MAX_TEXT };
