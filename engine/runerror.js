'use strict';

/**
 * What a failed run really said.
 *
 * A harness that ends without an answer often leaves the wrapper's own no-result message behind
 * ("Command Code ended without a result (credits, rate limit or a crash: check its exit code)"). That message lists
 * possible causes, not an observed failure, so it is never reported as one: only a real diagnostic in the feed or on
 * stderr is. The result is the work's own error, never a fragment of the launch command (the brief is echoed after a
 * killed child).
 */

/** The wrapper's no-result message: possible causes, not an observed quota failure. */
const NO_RESULT = /Command Code ended without a result\s*\(credits, rate limit or a crash: check its exit code\)/i;

const MAX = 200;

/** A message of any shape as one line of text. */
function message(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(message).filter(Boolean).join('; ');
    return value && typeof value === 'object' ? message(value.message || value.error) : '';
}

/**
 * The error of a failed run, from its feed, its stderr and a summary.
 *
 * @param {string} feed the run's jsonl feed
 * @param {string} stderr what the launcher wrote
 * @param {string} summary a fallback message
 * @returns {string} the error, at most 200 characters ('' when there was none)
 */
function failureError(feed, stderr, summary = '') {
    let result = '';
    // Parse complete JSON records: escaped quotes and whitespace are legal, and tool output is not a run failure.
    for (const line of String(feed || '').split('\n')) {
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'result' && e.is_error) result = message(e.result) || message(e.errors);
    }
    if (result && !NO_RESULT.test(result)) return result.trim().slice(0, MAX);
    const lines = String(stderr || '').split('\n');
    let diagnostic = '';
    for (const line of lines) {
        // Bash prints the entire launch command (including a multiline brief) after a killed child.
        // Keep only its signal diagnosis, never a fragment of the echoed command or brief.
        const signal = line.match(/:\s*line \d+:\s*\d+\s+(Killed|Terminated|Segmentation fault|Aborted)\b/);
        if (signal) return signal[1];
        if (/^(?:API Error:|Error:|Refused:|mcode exec (?:failed|cancelled):|\[claude-code:[\w-]+\]|(?:Killed|Terminated)\.?$)/.test(line.trim())) diagnostic = line.trim();
    }
    return (diagnostic || result || message(summary)).trim().slice(0, MAX);
}

module.exports = { failureError, message, NO_RESULT };
