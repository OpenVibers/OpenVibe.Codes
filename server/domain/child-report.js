'use strict';

/**
 * The child return contract (plan R1 item 5): what a conductor's sub-task hands back.
 *
 * The parent names the report path when it starts the child (report.md when it names none); the child writes
 * its full output there and ends with a short report: at most 5 `- ` bullets, then any `BLOCKED: …` or
 * `CONCERNS: …` lines. What the parent reads is always that shape — parseReport bounds even a child that
 * ignored it (its first lines become the bullets), so the parent never gets a raw dump.
 *
 *   checkPath(value)            the stored path, or a 422
 *   instruction(path)           the paragraph the child's brief carries
 *   parseReport(text, { path }) { path, bullets, blocked, concerns, truncated }
 *   of(row)                     the report for a task row, or null when it has none to give
 */

const DEFAULT_PATH = 'report.md';
const MAX_BULLETS = 5;
const MAX_LINE = 500;
const MAX_FLAGGED = 10;

/** A report path: relative, no climbing out, no absolute paths, no blanks. */
const REPORT_PATH = /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/**
 * The stored report path for a sub-task start.
 *
 * @param {*} value what the parent sent (absent: the default)
 * @returns {string} the path the child writes
 * @throws {{ status, code, message }} codes.report_path_invalid
 */
function checkPath(value) {
    if (value == null || value === '') return DEFAULT_PATH;
    const p = String(value).trim();
    if (p.length > 200 || !REPORT_PATH.test(p)) {
        throw { status: 422, code: 'codes.report_path_invalid', message: 'report_path is a relative path in the workspace (no .., no absolute path), at most 200 characters' };
    }
    return p;
}

/**
 * The paragraph a sub-task's brief carries: where its full output goes, and the shape of its last word.
 *
 * @param {string} path the parent-named report path
 * @returns {string} the instruction
 */
function instruction(path) {
    return `When the work is done, write your full output to ${path} in the workspace, then end with a short report ` +
        `for the task that started you: at most 5 lines starting with "- ", then any BLOCKED: … or CONCERNS: … lines ` +
        `(leave a kind out when there is none). That report is what the parent reads; the file holds the rest.`;
}

const cut = (s) => String(s).trim().slice(0, MAX_LINE);
const BULLET = /^\s*(?:-|\*|•)\s+(.*)$/;
const FLAGGED = /^\s*(blocked|concerns)\s*:\s*(.*)$/i;

/**
 * Shape a child's last word into the contract: the path, at most 5 bullets, the BLOCKED and CONCERNS lines.
 * A child that ignored the shape still comes back bounded: its first lines become the bullets.
 *
 * @param {*} text the child's summary
 * @param {object} [opts] { path }
 * @returns {{ path: string, bullets: string[], blocked: string[], concerns: string[], truncated: boolean }}
 */
function parseReport(text, { path = DEFAULT_PATH } = {}) {
    const bullets = [];
    const blocked = [];
    const concerns = [];
    let extraBullets = 0;
    for (const raw of String(text == null ? '' : text).split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const flag = line.match(FLAGGED);
        if (flag && flag[2].trim()) {
            const list = flag[1].toLowerCase() === 'blocked' ? blocked : concerns;
            if (list.length < MAX_FLAGGED) list.push(cut(flag[2]));
            continue;
        }
        const bullet = line.match(BULLET);
        if (bullet && bullet[1].trim()) {
            if (bullets.length < MAX_BULLETS) bullets.push(cut(bullet[1]));
            else extraBullets++;
            continue;
        }
    }
    if (!bullets.length && !blocked.length && !concerns.length) {
        for (const raw of String(text == null ? '' : text).split('\n')) {
            const line = raw.trim();
            if (!line) continue;
            if (bullets.length < MAX_BULLETS) bullets.push(cut(line));
            else { extraBullets++; break; }
        }
    }
    return { path, bullets, blocked, concerns, truncated: extraBullets > 0 };
}

const asObject = (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (typeof v === 'string' && v.trim()) { try { const d = JSON.parse(v); if (d && typeof d === 'object' && !Array.isArray(d)) return d; } catch { /* not a report */ } }
    return null;
};

/**
 * The report a task row hands its parent: the shaped summary of a conductor's child, or null when the task
 * is no child or has no last word yet (still running, or ended silent).
 *
 * @param {object} row the run_tasks row
 * @returns {object|null} parseReport's shape, or null
 */
function of(row) {
    const ref = asObject(row && row.actor_ref);
    const child = ref && ref.conductor && typeof ref.conductor === 'object' ? ref.conductor : null;
    if (!child) return null;
    const summary = asObject(row.result);
    const text = summary && typeof summary.summary === 'string' ? summary.summary : '';
    if (!text.trim()) return null;
    return parseReport(text, { path: typeof child.report_path === 'string' && child.report_path ? child.report_path : DEFAULT_PATH });
}

module.exports = { DEFAULT_PATH, MAX_BULLETS, checkPath, instruction, parseReport, of };
