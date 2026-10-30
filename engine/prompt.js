'use strict';

/**
 * The prompt every job gets, in the same order for every harness (the portal's git-safe.sh, with_git_rule):
 *
 *   the git rule → the house rules → what earlier jobs learned here → the repo digest → the brief
 *
 * The git rule and the house rules are Codes' own fragments (engine/fragments/), so a job on a machine that knows
 * nothing about the portal still gets them. The lessons are optional: a store that cannot be reached is skipped, never
 * an error. The digest is the repo's (engine/repomap.js): a folder that holds many repos has none, as in the portal.
 */

const fs = require('fs');
const path = require('path');
const { repomap } = require('./repomap');

const HERE = __dirname;
const FRAGMENTS = path.join(HERE, 'fragments');

/** A fragment's text, or '' when it is not there. */
function fragment(name) {
    try { return fs.readFileSync(path.join(FRAGMENTS, name), 'utf8'); } catch { return ''; }
}

/**
 * The lessons a job gets: what earlier jobs learned here, at most five lines.
 *
 * The store is optional and off by default: `OPENVIBE_CODES_LESSONS` names a JSONL file (one lesson per line, with a
 * `text` field and optional `repo` and `tags`). A store that cannot be read gives no lessons, not an error.
 *
 * @param {object} opts
 * @param {string} [opts.file] the store's path
 * @param {string} [opts.repo] the repo the job works in (its lessons come first)
 * @param {string} [opts.brief] the brief (its words pick the lessons that fit)
 * @returns {string} the lessons, as markdown ('' when there are none)
 */
function lessons({ file, repo, brief } = {}) {
    const path_ = file || process.env.OPENVIBE_CODES_LESSONS;
    if (!path_) return '';
    let raw;
    try { raw = fs.readFileSync(path_, 'utf8'); } catch { return ''; }
    const rows = [];
    for (const line of String(raw).split('\n')) {
        if (!line.trim()) continue;
        let row; try { row = JSON.parse(line); } catch { continue; }
        const text = typeof row.text === 'string' ? row.text.trim() : '';
        if (text) rows.push({ text, repo: row.repo || null, tags: Array.isArray(row.tags) ? row.tags : [] });
    }
    if (!rows.length) return '';
    const words = new Set(String(brief || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
    const scored = rows.map((r) => {
        let score = r.repo && repo && r.repo === repo ? 10 : 0;
        for (const t of r.tags) if (words.has(String(t).toLowerCase())) score += 2;
        for (const w of words) if (r.text.toLowerCase().includes(w)) score += 1;
        return { r, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
    if (!scored.length) return '';
    return ['### What earlier jobs learned here', ...scored.map((x) => `- ${x.r.text}`)].join('\n');
}

/**
 * The prompt of one job.
 *
 * @param {object} opts
 * @param {string} opts.brief what the task is
 * @param {string} opts.dir the folder the job works in
 * @param {object} [opts.env] the environment (OPENVIBE_CODES_LESSONS)
 * @returns {{text: string, parts: object[]}} the prompt and the parts it is made of
 */
function assemble({ brief, dir, env = process.env } = {}) {
    const gitRule = fragment('git-rule.md');
    const houseRules = fragment('house-rules.md');
    const repo = repomap(dir);
    const learned = lessons({ file: env.OPENVIBE_CODES_LESSONS, repo: repo.repo, brief });
    const parts = [
        { name: 'git-rule', text: gitRule },
        { name: 'house-rules', text: houseRules },
        { name: 'lessons', text: learned },
        { name: 'repo-digest', text: repo.text },
        { name: 'brief', text: String(brief || '') },
    ].filter((p) => p.text && p.text.trim());
    return { text: parts.map((p) => p.text).join('\n\n'), parts };
}

module.exports = { assemble, lessons, fragment, FRAGMENTS };
