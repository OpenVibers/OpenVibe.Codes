'use strict';

/**
 * Every harness Codes can run, and the one place that says how each is started.
 *
 * The adapters are the portal's runner scripts, ported: the argv and the environment are the portal's, the feed
 * converters are the portal's (cx-feed.js, cc-feed.js, oc-feed.js), the effort levels are the portal's.
 *
 *   claude-code    Claude Code (the owner's Anthropic plan)        cm-run.sh
 *   claude-other   Claude Code on another provider (cm-style env)   cm-run.sh
 *   codex          Codex (the owner's ChatGPT plan)                 cx-run.sh
 *   command-code   Command Code                                     cc-run.sh
 *   opencode       OpenCode                                         oc-run.sh
 *   minimax-code   MiniMax Code                                     mm-run.sh
 */

const { claudeCode, claudeOther } = require('./claude-code');
const { codex } = require('./codex');
const { commandCode } = require('./command-code');
const { opencode } = require('./opencode');
const { minimaxCode } = require('./minimax-code');
const { effortFor, EFFORT_LEVELS } = require('./base');

const ADAPTERS = {
    'claude-code': claudeCode,
    'claude-other': claudeOther,
    codex,
    'command-code': commandCode,
    opencode,
    'minimax-code': minimaxCode,
};

/** The adapter of a harness, or null. */
function adapterFor(id) {
    return ADAPTERS[String(id || '').toLowerCase()] || null;
}

/** Every harness, in the order the portal's rungs go. */
function all() {
    return Object.values(ADAPTERS);
}

/** The harness names. */
function ids() {
    return Object.keys(ADAPTERS);
}

module.exports = { ADAPTERS, adapterFor, all, ids, effortFor, EFFORT_LEVELS };
