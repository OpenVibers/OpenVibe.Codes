'use strict';

/**
 * What a picker says about each agent (owner 2026-11-03: the selects "should be aware of what the user has set up"):
 * from the fleet's rows (fleet.agents), one state, a short badge, a line and, when the agent is not ready, where to make
 * it ready. Shared's ov-forms.js draws them on an <option> (data-state, data-badge, data-desc, data-href); without it
 * the badge rides in the option's own words.
 *
 *   readiness(rows)            → Map agent → { state, badge, desc, href, hrefLabel, ready }
 *   optionAttrs(info)          → ' data-state="…" data-badge="…" …' (escaped)
 *   SETUP                      → how each plan agent is installed and signed in, for the guided setup
 */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The plan agents a machine can sign in to, and the two commands that make one ready. Only commands each CLI documents
 * itself; an agent with none here says to follow its own guide.
 */
const SETUP = {
    'claude-code': { name: 'Claude Code', plan: 'a Claude Pro or Max plan', install: 'npm install -g @anthropic-ai/claude-code', signIn: 'claude', signInNote: 'and sign in when it asks', docs: 'https://docs.claude.com/en/docs/claude-code/setup' },
    codex: { name: 'Codex', plan: 'a ChatGPT Plus or Pro plan', install: 'npm install -g @openai/codex', signIn: 'codex login', docs: 'https://github.com/openai/codex' },
    opencode: { name: 'OpenCode', plan: 'OpenCode Go, or your own keys', install: 'npm install -g opencode-ai', signIn: 'opencode auth login', docs: 'https://opencode.ai/docs' },
    'command-code': { name: 'Command Code', plan: 'a Command Code plan', install: null, signIn: null, docs: 'https://commandcode.ai' },
    'minimax-code': { name: 'MiniMax Code', plan: 'a MiniMax coding plan', install: null, signIn: null, docs: 'https://www.minimax.io' },
};

function readiness(rows) {
    const out = new Map();
    for (const row of rows || []) {
        if (!row || !row.agent) continue;
        const used = Number.isFinite(Number(row.used)) ? Math.round(Number(row.used)) : 0;
        const where = (row.machines || []).filter((m) => m && m.room).map((m) => m.name || m.machine).filter(Boolean).slice(0, 2).join(', ');
        const setupHref = `/setup#agent-${row.agent}`;
        let info;
        switch (row.state) {
            case 'ok': info = { state: 'ok', badge: used ? `${used}% used` : 'Ready', desc: where ? `Signed in on ${where}` : 'Signed in on your machine', ready: true }; break;
            case 'low': info = { state: 'warn', badge: `${used}% used`, desc: 'Nearly at its limit', ready: true }; break;
            case 'limited': info = { state: 'bad', badge: 'Full', desc: 'Its usage window is spent for now', ready: false }; break;
            case 'empty': info = { state: 'bad', badge: 'Out of credit', desc: 'Its balance is nearly gone', ready: false }; break;
            case 'login': info = { state: 'bad', badge: 'Sign in', desc: 'Installed, not signed in', href: setupHref, hrefLabel: 'Sign in', ready: false }; break;
            case 'absent': info = { state: 'off', badge: 'Not installed', desc: 'Not on your machine yet', href: setupHref, hrefLabel: 'Set up', ready: false }; break;
            default: info = { state: 'off', badge: 'No reading', desc: 'Your machine has not reported it', ready: false };
        }
        out.set(row.agent, info);
    }
    return out;
}

/** The data-* attributes an <option> carries for ov-forms.js. */
function optionAttrs(info) {
    if (!info) return '';
    return [
        info.state ? ` data-state="${esc(info.state)}"` : '',
        info.badge ? ` data-badge="${esc(info.badge)}"` : '',
        info.desc ? ` data-desc="${esc(info.desc)}"` : '',
        info.href ? ` data-href="${esc(info.href)}" data-href-label="${esc(info.hrefLabel || 'Set up')}"` : '',
    ].join('');
}

module.exports = { readiness, optionAttrs, SETUP };
