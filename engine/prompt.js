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
 * The lessons a job gets: what earlier jobs learned here, through the shared Know store's own `recall()`
 * (the portal's know/lessons.js; on a Node its path comes from the configuration, never a hard-coded home).
 *
 * The store is optional and off by default. A path that cannot be required, a module without recall(), or a recall
 * that throws gives no lessons, never an error: a job must not fail because the memory is unreachable.
 *
 * @param {object} opts
 * @param {string} [opts.file] the Know module's path (know/lessons.js)
 * @param {string} [opts.repo] the repo the job works in (its lessons come first)
 * @param {string} [opts.brief] the brief (its words pick the lessons that fit)
 * @param {object} [opts.env] the environment (CODES_KNOW_LESSONS, or the older OPENVIBE_CODES_LESSONS)
 * @returns {string} the lessons, as markdown ('' when there are none)
 */
function lessons({ file, repo, brief, env = process.env } = {}) {
    const path_ = String(file || (env && (env.CODES_KNOW_LESSONS || env.OPENVIBE_CODES_LESSONS)) || '').trim();
    if (!path_) return '';
    let know;
    try { know = require(path.resolve(path_)); } catch { return ''; }
    if (!know || typeof know.recall !== 'function') return '';
    try {
        const block = know.recall(String(brief || ''), repo || '*', 5);
        return typeof block === 'string' ? block.trim() : '';
    } catch { return ''; }
}

/**
 * The prompt of one job.
 *
 * @param {object} opts
 * @param {string} opts.brief what the task is
 * @param {string} opts.dir the folder the job works in
 * @param {object} [opts.env] the environment (CODES_KNOW_LESSONS, or the older OPENVIBE_CODES_LESSONS)
 * @param {string} [opts.know] the Know module's path (the Node's config wins over the environment)
 * @returns {{text: string, parts: object[]}} the prompt and the parts it is made of
 */
function assemble({ brief, dir, env = process.env, know } = {}) {
    const gitRule = fragment('git-rule.md');
    const houseRules = fragment('house-rules.md');
    const repo = repomap(dir);
    const learned = lessons({ file: know, repo: repo.repo, brief, env });
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
