'use strict';

/**
 * Claude Code, and Claude Code on another provider (the cm-style environment).
 *
 * The argv comes from the portal's cm-run.sh:
 *
 *   claude -p --output-format stream-json --verbose --include-partial-messages --max-turns N
 *          --permission-mode MODE --exclude-dynamic-system-prompt-sections
 *          --append-system-prompt-file RULES --disallowedTools … --allowedTools …
 *
 *   --resume SESSION      continues the same session (its context and its prompt cache come back)
 *
 * The permission modes are the portal's: acceptEdits (a job may change files), bypassPermissions (the owner's
 * "full" choice), plan (read-only) and manual (the owner answers from the phone).
 *
 * On another provider the environment is the portal's cm-style one: the base URL, the auth token, the model and the
 * effort level, as ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL / CLAUDE_CODE_EFFORT_LEVEL (what
 * claude-minimax sets, and what claude-deepseek does for DeepSeek).
 */

const { effortFor, claudeFeed, TOOL_NAMES } = require('./base');

/** The permission modes, by the Codes level (read, edit, full). */
const MODES = { read: 'plan', edit: 'acceptEdits', full: 'bypassPermissions' };

/** The tools a job may use (the portal's allow list). */
const ALLOWED = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookEdit'];

/** The tools a job may never use (the portal's deny list). */
const DENIED = ['Bash(git push:*)', 'Bash(git commit:*)', 'Bash(git reset:*)', 'Bash(git clean:*)', 'Bash(git stash:*)',
    'Bash(sudo:*)', 'Bash(rm -rf:*)', 'Read(.env*)', 'Read(**/.env*)'];

/** The rules a job's system prompt carries (the prompt's rules file, appended to the system prompt). */
function rulesFile(rules) { return rules && rules.trim() ? rules.trim() : null; }

/**
 * The argv and the environment for one Claude Code run.
 *
 * @param {object} ctx
 * @param {string} ctx.prompt the brief (the user turn; the rules ride in the system prompt)
 * @param {string} [ctx.model] the model
 * @param {string} [ctx.effort] the wanted reasoning level
 * @param {string} [ctx.resume] the session to continue
 * @param {string} [ctx.permission] 'read' | 'edit' | 'full'
 * @param {number} [ctx.maxTurns] the turn limit
 * @param {string} [ctx.rules] the rules file (appended to the system prompt)
 * @param {object} [ctx.provider] the provider's environment (base URL, token, model): the cm-style environment
 * @returns {{cmd: string, argv: string[], env: object, stdin: string|null}} what to run
 */
function build(ctx = {}) {
    const effort = effortFor('claude-code', ctx.effort);
    const argv = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--max-turns', String(ctx.maxTurns || 200),
        '--permission-mode', MODES[ctx.permission] || MODES.edit,
        '--exclude-dynamic-system-prompt-sections'];
    const rules = rulesFile(ctx.rules);
    if (rules) argv.push('--append-system-prompt-file', rules);
    argv.push('--disallowedTools', DENIED.join(' '));
    argv.push('--allowedTools', ALLOWED.join(' '));
    if (ctx.resume) argv.push('--resume', String(ctx.resume));
    const env = {};
    const p = ctx.provider || {};
    if (p.baseUrl) env.ANTHROPIC_BASE_URL = p.baseUrl;
    if (p.authToken) env.ANTHROPIC_AUTH_TOKEN = p.authToken;
    if (p.apiKey) env.ANTHROPIC_API_KEY = p.apiKey;
    if (ctx.model) env.ANTHROPIC_MODEL = ctx.model;
    if (effort) env.CLAUDE_CODE_EFFORT_LEVEL = effort;
    if (p.mcpConfig) argv.push('--mcp-config', p.mcpConfig);
    if (p.extraAllowed && p.extraAllowed.length) argv.push('--allowedTools', ALLOWED.concat(p.extraAllowed).join(' '));
    return { cmd: ctx.bin || 'claude', argv, env, stdin: ctx.prompt || '' };
}

/** The feed: Claude Code's own stream-json is what the transcript normaliser reads. */
function feed({ model, onEvent }) {
    const f = claudeFeed({ model, onEvent });
    return {
        state: f.state,
        line(raw) { f.line(raw); },
        end(info) { f.end(info); },
    };
}

const claudeCode = {
    id: 'claude-code', name: 'Claude Code', kind: 'cli', bin: 'claude',
    portal: 'cm-run.sh', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    build, feed,
    /** The provider's environment (the cm-style one) for a provider other than Anthropic's own. */
    providerEnv(provider = {}) {
        const env = {};
        if (provider.baseUrl) env.ANTHROPIC_BASE_URL = provider.baseUrl;
        if (provider.authToken) env.ANTHROPIC_AUTH_TOKEN = provider.authToken;
        if (provider.apiKey) env.ANTHROPIC_API_KEY = provider.apiKey;
        if (provider.model) env.ANTHROPIC_MODEL = provider.model;
        if (provider.effort) env.CLAUDE_CODE_EFFORT_LEVEL = provider.effort;
        return env;
    },
};

/** Claude Code on another provider: the same CLI, the cm-style environment. */
const claudeOther = {
    id: 'claude-other', name: 'Claude Code (another provider)', kind: 'cli', bin: 'claude',
    portal: 'cm-run.sh', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    build(ctx = {}) {
        const effort = effortFor('claude-other', ctx.effort);
        const p = ctx.provider || {};
        const env = claudeCode.providerEnv({ ...p, model: ctx.model || p.model, effort });
        const out = build({ ...ctx, provider: { ...p, model: ctx.model || p.model }, bin: ctx.bin });
        return { ...out, env };
    },
    feed,
};

module.exports = { claudeCode, claudeOther, MODES, ALLOWED, DENIED, TOOL_NAMES };
