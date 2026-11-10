'use strict';

/**
 * A review's findings across revisions: the stable id, the ACTIVE/RESOLVED lifecycle, and the line a person reads.
 *
 * A finding is identified by the repository-relative file and the whitespace-normalised, lowercased text
 * (`engine/finding.js`'s findingId), so re-wrapping the same sentence keeps its id while a genuine rewording becomes
 * a new finding. The first review creates ACTIVE records; a later review is given the prior records and reconciles
 * them: a prior finding that is no longer raised is addressed (RESOLVED), a prior RESOLVED one that comes back has
 * reappeared (ACTIVE), a prior ACTIVE one still raised is still open, and anything new is new. The resolved set is
 * capped, oldest first, because a long review history is not worth its prompt tokens.
 *
 *   parse(text)                 the findings in a review's answer (JSON findings or legacy numbered VERDICT bullets)
 *   merge(prior, current)       { findings, lifecycle, line } — the merged lifecycle
 *   fromReview(text, prior)     parse + merge
 *   priorBrief(records)         the compact block a re-review prompt gets instead of the whole earlier answer
 *   lifecycleLine(lifecycle)    "Findings: 1 addressed, 0 reappeared, 2 still open, 1 new"
 *   STATE, MAX_FINDINGS, RESOLVED_CAP
 *
 * Quiet by default lives in the review prompt (engine/review.js) and in this cap: at most three findings, and no
 * synthetic "no issues" finding — an approval is an empty list, not a comment.
 */

const { findingId } = require('./finding');

const STATE = { ACTIVE: 'ACTIVE', RESOLVED: 'RESOLVED' };
const MAX_FINDINGS = 3;
const RESOLVED_CAP = 20;
const SEVERITIES = ['low', 'medium', 'high', 'critical'];

/** One finding, from what a reviewer said. A record without a file and words has no identity and is dropped. */
function record(item) {
    if (!item || typeof item !== 'object') return null;
    const file = String(item.file || '').trim().replace(/^\.\//, '');
    const text = String(item.text || item.description || item.summary || '').trim();
    if (!file || !text) return null;
    const line = Number.isInteger(item.line) && item.line > 0 ? item.line : null;
    const severity = SEVERITIES.includes(String(item.severity || '').toLowerCase()) ? String(item.severity).toLowerCase() : null;
    return {
        finding_id: findingId(file, text),
        file,
        line,
        text: text.slice(0, 2000),
        severity,
        state: STATE.ACTIVE,
    };
}

/** The JSON object in an answer, when it wrote one (the prompt asks for JSON). */
function jsonOf(text) {
    const raw = String(text || '').trim();
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

/** A file:line at the start of a legacy numbered bullet. */
const BULLET_FILE = /^([\w./-]+\.[A-Za-z0-9]+):(\d+)\s*(.*)$/;
const BULLET_FILE_NO_LINE = /^([\w./-]+\.[A-Za-z0-9]+)\s*(?:[—:-]\s*)?(.*)$/;

/**
 * The findings in a review answer: the JSON `findings` array when the reviewer wrote one, else the numbered bullets
 * of the older `VERDICT: FIX` protocol ("1. server/x.js:31 the cache never expires").
 *
 * @param {string} text the review
 * @returns {object[]} the records, capped at MAX_FINDINGS
 */
function parse(text) {
    const doc = jsonOf(text);
    if (doc && Array.isArray(doc.findings)) {
        return doc.findings.map(record).filter(Boolean).slice(0, MAX_FINDINGS);
    }
    const out = [];
    const lines = String(text || '').split('\n');
    const start = lines.findIndex((l) => /^\W*VERDICT:\s*(SHIP|FIX)/i.test(l));
    for (const line of lines.slice(start < 0 ? 0 : start + 1)) {
        const m = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (!m) continue;
        const body = m[1].trim();
        const withLine = BULLET_FILE.exec(body), withoutLine = BULLET_FILE_NO_LINE.exec(body);
        const hit = withLine || withoutLine;
        if (!hit) continue;
        const rec = record({ file: hit[1], line: withLine ? +hit[2] : null, text: withLine ? hit[3] : hit[2] });
        if (rec) out.push(rec);
        if (out.length >= MAX_FINDINGS) break;
    }
    return out;
}

/** The line a person reads at the top of a re-review, or null when there is nothing to say. */
function lifecycleLine(lifecycle) {
    if (!lifecycle) return null;
    const { addressed = 0, reappeared = 0, still_open = 0, new: fresh = 0 } = lifecycle;
    if (!addressed && !reappeared && !still_open && !fresh) return null;
    return `Findings: ${addressed} addressed, ${reappeared} reappeared, ${still_open} still open, ${fresh} new`;
}

/**
 * Reconcile this review's findings with the prior ledger.
 *
 * @param {object[]} prior the earlier records (ACTIVE and RESOLVED)
 * @param {object[]} current this review's records
 * @returns {{ findings: object[], lifecycle: object, line: string|null }} the merged ledger and its line
 */
function merge(prior = [], current = []) {
    const prev = Array.isArray(prior) ? prior.filter((p) => p && p.finding_id) : [];
    const cur = Array.isArray(current) ? current.filter((c) => c && c.finding_id) : [];
    const byId = new Map(prev.map((p) => [p.finding_id, p]));
    const seen = new Set();
    const lifecycle = { addressed: 0, reappeared: 0, still_open: 0, new: 0 };
    const findings = [];
    for (const c of cur) {
        if (seen.has(c.finding_id)) continue;
        seen.add(c.finding_id);
        const p = byId.get(c.finding_id);
        if (!p) lifecycle.new++;
        else if (p.state === STATE.RESOLVED) lifecycle.reappeared++;
        else lifecycle.still_open++;
        findings.push({ ...c, state: STATE.ACTIVE });
    }
    for (const p of prev) {
        if (p.state === STATE.RESOLVED || seen.has(p.finding_id)) continue;
        lifecycle.addressed++;
        findings.push({ ...p, state: STATE.RESOLVED });
    }
    // Keep the ledger readable: the oldest resolved findings leave first.
    const resolved = findings.filter((f) => f.state === STATE.RESOLVED);
    if (resolved.length > RESOLVED_CAP) {
        const drop = new Set(resolved.slice(0, resolved.length - RESOLVED_CAP).map((f) => f.finding_id));
        return { findings: findings.filter((f) => !drop.has(f.finding_id)), lifecycle, line: lifecycleLine(lifecycle) };
    }
    return { findings, lifecycle, line: lifecycleLine(lifecycle) };
}

/** Parse this review and reconcile it with the prior ledger. */
function fromReview(text, prior = []) {
    return merge(prior, parse(text));
}

/** The compact block a re-review prompt gets: the ids and words, so the reviewer can tell addressed from reworded. */
function priorBrief(records, limit = 8000) {
    const list = Array.isArray(records) ? records.filter((r) => r && r.finding_id) : [];
    if (!list.length) return '';
    const lines = list.slice(0, 20).map((r) => `- [${r.state}] ${r.file}${r.line ? ':' + r.line : ''} — ${r.text} (id ${r.finding_id})`);
    return lines.join('\n').slice(0, limit);
}

module.exports = {
    STATE, MAX_FINDINGS, RESOLVED_CAP,
    record, parse, merge, fromReview, priorBrief, lifecycleLine,
};
