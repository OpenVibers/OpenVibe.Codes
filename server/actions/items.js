'use strict';

/**
 * Codes' Action Center items (plan 2026-10-28 §3.10, common.action-item@1): one person's coding tasks as
 * codes.task@1 already presents them, mapped to the five Action Center buckets. bucketFor() is exported on its own
 * so its state table can be tested.
 */

const PUBLIC_ORIGIN = 'https://openvibe.codes';

const STATE_BUCKET = Object.freeze({
    queued: 'running',
    placed: 'running',
    running: 'running',
    succeeded: 'done',
    failed: 'failed',
    cancelled: 'failed',
    expired: 'failed',
});

function bucketFor(state) {
    return STATE_BUCKET[state] || 'failed';
}

/** What the person may do from the list (common.action-item@1.actions). */
function actionsFor(bucket) {
    if (bucket === 'running') return ['open', 'cancel'];
    return ['open'];   // no retry route on Codes
}

/** Plain text (no HTML or Markdown), single line, at most `max` characters. */
function plain(value, max = 400) {
    let s = value == null ? '' : String(value);
    s = s.replace(/```[\s\S]*?```/g, ' ').replace(/<\/?[^>]+>/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/&([a-zA-Z#0-9]+);/g, (m, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' })[k] || m)
        .replace(/[`*_~]+/g, '').replace(/^[#>\s-]+/gm, '')
        .replace(/\s+/g, ' ').trim();
    if (s.length > max) s = `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
    return s;
}

function parse(value) {
    if (value == null) return null;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return null; }
}

/** Tool calls in the session log the result keeps, or null when it kept none. */
function stepsOf(row) {
    const result = parse(row.result);
    if (!result || !Array.isArray(result.log)) return null;
    return result.log.filter((line) => line && typeof line === 'object' && line.t === 'tool').length;
}

function toItem(row, presented) {
    const result = presented.result || {};
    const bucket = bucketFor(presented.state);
    const agent = Array.isArray(result.agents) && result.agents.length ? result.agents.join(', ') : presented.agent;
    const summary = result.summary || presented.error || '';
    return {
        service: 'codes',
        id: presented.id,
        kind: 'code_task',
        title: plain(row.prompt || presented.id, 160) || presented.id,
        summary: summary ? plain(summary, 400) : null,
        bucket,
        state: presented.state,
        agent: agent ? plain(agent, 80) : null,
        cost_usd: typeof result.cost_usd === 'number' && Number.isFinite(result.cost_usd) ? result.cost_usd : null,
        steps: stepsOf(row),
        error: presented.error ? plain(presented.error, 400) : null,
        created_at: presented.created_at,
        updated_at: presented.updated_at,
        href: `${PUBLIC_ORIGIN}/run/tasks/${presented.id}`,
        actions: actionsFor(bucket),
    };
}

module.exports = { PUBLIC_ORIGIN, bucketFor, actionsFor, plain, stepsOf, toItem };
