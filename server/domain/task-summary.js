'use strict';

/**
 * The Dock's Code tab list (codes.task-summary@1): a task in the Dock's words. The person's latest, running first.
 *
 *   summarize(rows, { stepsByTask, waitingIds, openvibeUrls }) → [codes.task-summary@1, …]
 *
 * STATUS maps the task's state: queued or placed waits for a machine, running runs, a live task with an approval
 * waiting in its inbox needs the person, succeeded is done, failed or expired failed, cancelled stopped. MODE is the
 * stored mode (openvibe | repo), read back by repository for older rows: an OpenVibe project's own URL is openvibe,
 * anything else repo. STEPS counts the attempts a coding task ran, or a conductor's messages. PREVIEW_URL stays
 * null: Codes tasks have no live preview; a Space build's preview lives behind the create handover, not a task.
 */
const LIVE = new Set(['queued', 'placed', 'running']);

const iso = (ms) => { const t = new Date(Number(ms)); return Number.isFinite(t.getTime()) ? t.toISOString() : new Date(0).toISOString(); };

/** The task's first line, as its title: markdown markers stripped, 200 characters at most, never empty. */
function titleOf(row) {
    if (row && row.kind === 'conductor' && row.folder) {
        const folder = String(row.folder).replace(/\/+$/, '').split('/').pop() || 'a folder';
        return `Conductor · ${folder}`.slice(0, 200);
    }
    const line = String((row && row.prompt) || '').split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
    return (line.length > 200 ? `${line.slice(0, 199)}…` : line) || 'New task';
}

function statusOf(row, waiting) {
    if (LIVE.has(row.state) && waiting) return 'needs-you';
    if (row.state === 'queued' || row.state === 'placed') return 'queued';
    if (row.state === 'running') return 'running';
    if (row.state === 'succeeded') return 'done';
    if (row.state === 'failed' || row.state === 'expired') return 'failed';
    return 'stopped';
}

function modeOf(row, openvibeUrls) {
    if (row.mode === 'openvibe' || row.mode === 'repo') return row.mode;
    if (row.kind === 'conductor') return 'repo';
    if (openvibeUrls && openvibeUrls.has(String(row.repo || ''))) return 'openvibe';
    return 'repo';
}

function prUrlOf(row) {
    let result = row && row.result;
    if (typeof result === 'string') { try { result = JSON.parse(result); } catch { return null; } }
    const push = result && typeof result === 'object' ? result.push : null;
    const url = push && typeof push === 'object' ? push.pull_request : null;
    return typeof url === 'string' && /^https:\/\//.test(url) ? url.slice(0, 2000) : null;
}

function summarize(rows, { stepsByTask = {}, waitingIds = new Set(), openvibeUrls = new Set(), baseUrl = 'https://openvibe.codes' } = {}) {
    const base = String(baseUrl).replace(/\/+$/, '');
    return (Array.isArray(rows) ? rows : []).map((row) => ({
        id: row.id,
        title: titleOf(row),
        status: statusOf(row, waitingIds.has(row.id)),
        mode: modeOf(row, openvibeUrls),
        repo: String(row.repo || '').slice(0, 300),
        started_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
        steps: Math.max(0, Number(stepsByTask[row.id]) || 0),
        url: `${base}/tasks/${encodeURIComponent(row.id)}`,
        preview_url: null,
        pr_url: prUrlOf(row),
    }));
}

module.exports = { summarize, titleOf, statusOf, modeOf, LIVE };
