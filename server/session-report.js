'use strict';

/**
 * The session report of a finished task (Agent Streams S3): the payload Codes sends to OpenVibe.Report.
 *
 * The proof is what the task's own machine collected (engine/proof.js, harness/proof.js): the tests that ran, the
 * pages that were shot, the diff and the second model's opinion. The report is that proof in plain words: what was
 * asked, what came out, the steps, what it cost and how it ended.
 *
 * Never in the report: the raw transcript (Codes keeps it for the owner, privately), a secret (Report's house
 * redactor runs over every text field before anything is stored) and the code itself (a pull request is a link).
 */

/** The proof item's own data, whatever shape it arrives in. */
function dataOf(item) {
    if (!item || typeof item !== 'object') return {};
    if (item.data && typeof item.data === 'object') return { ...item.data, kind: item.data.kind || item.kind };
    return item;
}

function buildSessionReport({ row, proofItems = [], ending = null } = {}) {
    const task = row && typeof row === 'object' ? row : {};
    const owner = String(task.subject || '');
    if (!owner.startsWith('usr_')) return null;
    const items = (Array.isArray(proofItems) ? proofItems : []).map(dataOf);
    const kindOf = (k) => items.find((i) => i.kind === k) || null;
    const testsItem = kindOf('tests');
    const reviewItem = kindOf('review');
    const shotsItem = kindOf('screenshots');
    const diffItem = kindOf('diff');
    const count = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const tests = testsItem ? { passed: count(testsItem.passed), failed: count(testsItem.failed) } : null;
    const screenshots = shotsItem
        ? [].concat(shotsItem.media_ids || shotsItem.screenshots || shotsItem.ids || []).map(String).filter(Boolean).slice(0, 20)
        : [];
    const review = reviewItem
        ? { verdict: String(reviewItem.verdict || reviewItem.summary || 'Reviewed').slice(0, 40), notes: reviewItem.notes || reviewItem.note || null }
        : null;
    const outputs = [];
    if (diffItem) {
        outputs.push({
            kind: 'file',
            url: diffItem.url || null,
            title: String(diffItem.title || diffItem.summary || 'What changed').slice(0, 200),
            state: null,
        });
    }
    // A task that opened a pull request has one to point at (a link, never the code itself).
    if (task.pull_request) {
        outputs.push({
            kind: 'pr',
            url: task.pr_url || null,
            title: String(task.pr_title || 'The pull request').slice(0, 200),
            state: task.pr_state || null,
        });
    }
    const timeline = items.map((i) => ({
        at: i.at || task.finished_at || null,
        title: String(i.title || i.label || i.kind || 'a step').slice(0, 120),
        status: i.status === 'failed' ? 'failed' : 'passed',
        detail: i.detail || i.summary || null,
        tests: i.kind === 'tests' ? { passed: count(i.passed), failed: count(i.failed) } : null,
    }));
    const started = task.started_at ? Date.parse(String(task.started_at)) : NaN;
    const ended = task.finished_at ? Date.parse(String(task.finished_at)) : NaN;
    const worked = Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, Math.round((ended - started) / 1000)) : 0;
    const outcome = task.outcome === 'done' ? 'done' : (task.outcome === 'stopped' ? 'stopped' : 'failed');
    const title = String(task.title || (String(task.prompt || '').split('\n')[0]) || 'A task').slice(0, 200);
    return {
        owner,
        source: 'codes',
        task: { title, ref: task.id, url: 'https://openvibe.codes/t/' + encodeURIComponent(String(task.id || '')) },
        started_at: task.started_at || null,
        ended_at: task.finished_at || null,
        worked_seconds: worked,
        outcome,
        stopped_because: outcome === 'done' ? null : (task.outcome_note || null),
        summary: String(task.outcome_note || title).slice(0, 600),
        timeline,
        outputs,
        proof: { tests, screenshots, review },
        cost_usd: ending && ending.cost_usd != null ? Number(ending.cost_usd) : null,
        models: ending && ending.model ? [String(ending.model)] : [],
        highlights: [],
        visibility: 'private',
    };
}

module.exports = { buildSessionReport, dataOf };
