'use strict';

/**
 * The runtime capability manifest: what each harness Codes runs can actually do, as data.
 *
 * Every offer carries these as `harness:<field>-<value>` capabilities (`server/domain/harness-placement.js`), so a
 * task states what it needs — "a harness that can resume a session", "one whose sandbox is its own" — and the router
 * excludes the rest with a reason. No caller asks a provider's name; a harness that lies here lies to the router.
 *
 * The fields (the plan's runtime cap, tools §4; t3code's provider capability system is the model):
 *
 *   terminal_status   how the harness reports how a run ended
 *                     structured  — a machine-readable result line (stream-json / an API's own loop)
 *                     parsed      — Codes reads the CLI's prose and decides from it
 *                     none        — nothing to read
 *   steering          how a running or ended task takes a correction
 *                     live        — a message can be appended to the running session
 *                     resume      — the session is continued by id, after or between runs
 *                     none        — a new run starts over
 *   checkpointing     whether Codes can checkpoint the harness's working tree per turn
 *                     git         — the worktree can be written to a git ref and restored
 *                     none        — no checkpoint
 *   subagents         how the harness runs children
 *                     native      — the harness's own tools, with its own lifecycle and completion
 *                     tool        — spawned through a shell or a protocol with no lifecycle report
 *                     none        — no children
 *   context_handoff   what carries the context to the next attempt
 *                     session     — the harness's session id resumes the conversation
 *                     transcript  — Codes' own session store replays it
 *                     none        — only the hand-off note
 *   enforcement       where the harness's permission boundary is enforced
 *                     native          — the harness's own sandbox or permission mode
 *                     client-boundary — Codes' tool loop, or a sandbox Codes requires around it
 *
 * `none` is a declaration, not an omission: a requirement the harness cannot meet excludes it. An unknown harness (a
 * portal runner with no Codes catalog row) declares nothing, so it is excluded only when a requirement is set.
 *
 * The manifest is Codes' own data, not a field of `platform.harness-offer@1`: the contract closes the row to unknown
 * fields, and the offer's `capabilities` array is the contract's own place for a capability. A harness added to the
 * catalog without a manifest fails the test that keeps the two in step.
 */

/** The closed value sets of every field. A value outside its set is a mistake, never a capability. */
const FIELDS = Object.freeze({
    terminal_status: Object.freeze(['structured', 'parsed', 'none']),
    steering: Object.freeze(['live', 'resume', 'none']),
    checkpointing: Object.freeze(['git', 'none']),
    subagents: Object.freeze(['native', 'tool', 'none']),
    context_handoff: Object.freeze(['session', 'transcript', 'none']),
    enforcement: Object.freeze(['native', 'client-boundary']),
});

/** The capability namespace each field writes into: `terminal_status: 'structured'` → `harness:terminal-status-structured`. */
const CAPABILITY = Object.freeze({
    terminal_status: 'harness:terminal-status',
    steering: 'harness:steering',
    checkpointing: 'harness:checkpointing',
    subagents: 'harness:subagents',
    context_handoff: 'harness:context-handoff',
    enforcement: 'harness:enforcement',
});

/**
 * One manifest per harness in `server/data/harness-offers.json`.
 *
 * Grounded in each adapter (harness/adapters/cli.js, harness/adapters/api.js) and its CLI's flags, not in its name:
 * every CLI here ends with a result line except Aider (its prose is parsed); every CLI with `--resume`/`--session`/`-s`
 * continues its session; Claude Code alone exposes subagents as tools. `checkpointing` is `none` until the per-turn
 * checkpoint refs land: this manifest is the runtime's declaration, so it must not claim one early.
 */
const MANIFEST = Object.freeze({
    'claude-code': Object.freeze({
        terminal_status: 'structured', steering: 'resume', checkpointing: 'none',
        subagents: 'native', context_handoff: 'session', enforcement: 'native',
    }),
    'claude-other': Object.freeze({
        terminal_status: 'structured', steering: 'resume', checkpointing: 'none',
        subagents: 'native', context_handoff: 'session', enforcement: 'native',
    }),
    codex: Object.freeze({
        terminal_status: 'structured', steering: 'resume', checkpointing: 'none',
        subagents: 'none', context_handoff: 'session', enforcement: 'native',
    }),
    opencode: Object.freeze({
        terminal_status: 'structured', steering: 'resume', checkpointing: 'none',
        subagents: 'none', context_handoff: 'session', enforcement: 'client-boundary',
    }),
    'command-code': Object.freeze({
        terminal_status: 'structured', steering: 'resume', checkpointing: 'none',
        subagents: 'none', context_handoff: 'session', enforcement: 'client-boundary',
    }),
    aider: Object.freeze({
        terminal_status: 'parsed', steering: 'none', checkpointing: 'none',
        subagents: 'none', context_handoff: 'none', enforcement: 'client-boundary',
    }),
    'minimax-code': Object.freeze({
        terminal_status: 'structured', steering: 'resume', checkpointing: 'none',
        subagents: 'none', context_handoff: 'session', enforcement: 'native',
    }),
    deepseek: Object.freeze({
        terminal_status: 'structured', steering: 'resume', checkpointing: 'none',
        subagents: 'none', context_handoff: 'session', enforcement: 'client-boundary',
    }),
    'openvibe-ai': Object.freeze({
        terminal_status: 'structured', steering: 'resume', checkpointing: 'none',
        subagents: 'none', context_handoff: 'session', enforcement: 'client-boundary',
    }),
    'openai-compatible': Object.freeze({
        terminal_status: 'structured', steering: 'resume', checkpointing: 'none',
        subagents: 'none', context_handoff: 'session', enforcement: 'client-boundary',
    }),
});

/**
 * The portal's short runner ids (engine/router.js's ladder) for the same harness. The portal has no row for
 * `claude-other`, and `cm`/`claude` are Claude Code on Anthropic; the others are one-to-one.
 */
const RUNNER_HARNESS = Object.freeze({
    cm: 'claude-code', claude: 'claude-code',
    cx: 'codex', cc: 'command-code', oc: 'opencode', dsh: 'deepseek', mm: 'minimax-code',
});

/** The manifest for a harness id (Codes'), or null for one the catalog does not declare. */
function forHarness(harness) {
    return MANIFEST[harness] || null;
}

/** The manifest for a ladder runner (the portal's short id, or a Codes harness id), or null. */
function forRunner(runner) {
    const key = String(runner || '');
    return MANIFEST[RUNNER_HARNESS[key] || key] || null;
}

/** The offer capabilities one manifest declares, in field order. */
function capabilities(manifest) {
    if (!manifest) return [];
    return Object.keys(FIELDS).map((field) => `${CAPABILITY[field]}-${manifest[field]}`);
}

/**
 * Turn a requirement into capability names. Two shapes are accepted:
 *
 *   ['harness:steering-resume']                    the capabilities as they are
 *   { steering: 'resume', subagents: 'native' }    the fields and their values
 *
 * @param {string[]|object|null} needs
 * @returns {string[]}
 */
function requirements(needs) {
    if (!needs) return [];
    if (Array.isArray(needs)) return needs.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim());
    const caps = [];
    for (const [field, value] of Object.entries(needs)) {
        // An unknown field cannot be met: keep its name so the exclusion says why, rather than silently dropping it.
        caps.push(`${CAPABILITY[field] || `harness:${field.replace(/_/g, '-')}`}-${value}`);
    }
    return caps;
}

/**
 * Does a harness or ladder runner declare every capability a caller needs? No requirement fits everyone; a harness the
 * manifest does not know fits nothing that is asked of it.
 *
 * @param {string} id a harness id or a portal runner id
 * @param {string[]|object|null} needs capability names or a { field: value } object
 * @returns {boolean}
 */
function fits(id, needs) {
    const wanted = requirements(needs);
    if (!wanted.length) return true;
    const manifest = forRunner(id);
    if (!manifest) return false;
    const has = new Set(capabilities(manifest));
    return wanted.every((cap) => has.has(cap));
}

module.exports = {
    FIELDS, CAPABILITY, MANIFEST, RUNNER_HARNESS,
    forHarness, forRunner, capabilities, requirements, fits,
};
