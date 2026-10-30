'use strict';

/**
 * What this machine has: each coding CLI, whether it is installed, whether it is signed in, and the limit windows it
 * can read.
 *
 * The plan logins are the owner's own files (the Node's worker copies the ones the owner names into the job's private
 * home, read-only, for that job only). This module reads them the way the portal's probes do:
 *
 *   installed   the CLI is on PATH
 *   signed in   its login file is there and holds a usable session (the file's content never leaves this machine)
 *   windows     the limit windows the login file itself carries (what the provider told it)
 *
 * Nothing else is reported: no key, no token, no account name. A probe that fails says "unknown", never a value.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** The CLIs and where their login lives, relative to the home folder. */
const CLIS = [
    { id: 'claude-code', bin: 'claude', login: '.claude/.credentials.json', provider: 'Anthropic' },
    { id: 'codex', bin: 'codex', login: '.codex/auth.json', provider: 'OpenAI' },
    { id: 'opencode', bin: 'opencode', login: '.local/share/opencode/auth.json', provider: 'OpenCode' },
    { id: 'command-code', bin: 'cmd', login: '.commandcode/auth.json', provider: 'Command Code' },
    { id: 'minimax-code', bin: 'mcode', login: '.minimax/credentials.json', provider: 'MiniMax' },
];

/** The file the executable may sit in, on this PATH. */
function onPath(bin, env = process.env) {
    for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
        try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return path.join(dir, bin); } catch { /* the next one */ }
    }
    return null;
}

/**
 * The windows a login file carries, if it carries any.
 *
 * Only numbers, labels and reset times are read: the file may hold a token next to them, and a token is never part of
 * what is reported.
 */
function windowsOf(login) {
    if (!login || typeof login !== 'object') return [];
    const out = [];
    const push = (name, used, limit, resetsAt) => {
        if (used == null && limit == null && resetsAt == null) return;
        out.push({
            name: String(name).slice(0, 40),
            used: Number.isFinite(Number(used)) ? Number(used) : null,
            limit: Number.isFinite(Number(limit)) ? Number(limit) : null,
            resets_at: resetsAt ? String(resetsAt).slice(0, 40) : null,
        });
    };
    // The shapes the providers use: a list of windows, or one window with a reset time.
    const list = login.windows || login.rate_limits || login.limits || login.usage_windows;
    if (Array.isArray(list)) {
        for (const w of list.slice(0, 10)) {
            if (!w || typeof w !== 'object') continue;
            push(w.name || w.id || w.window || 'window', w.used ?? w.used_percent ?? w.percent_used, w.limit ?? w.total ?? w.max, w.resets_at || w.reset_at || w.resets);
        }
    }
    const single = login.window || login.plan_window;
    if (single && typeof single === 'object') push(single.name || 'window', single.used, single.limit, single.resets_at || single.reset_at);
    return out;
}

/** Is a login file a usable session? (the file's content is never reported). */
function signedIn(login) {
    if (!login || typeof login !== 'object') return false;
    const keys = ['access_token', 'accessToken', 'api_key', 'apiKey', 'refresh_token', 'refreshToken', 'token', 'tokens', 'account'];
    return keys.some((k) => {
        const v = login[k];
        if (v == null) return false;
        if (typeof v === 'string') return v.trim().length > 0;
        if (typeof v === 'object') return Object.keys(v).length > 0;
        return true;
    });
}

/**
 * What every CLI here is.
 *
 * @param {object} [opts]
 * @param {string} [opts.home] the home folder the logins live in (the job's private home, when there is one)
 * @param {object} [opts.env] the environment (PATH)
 * @returns {object[]} one row per CLI: { id, installed, signed_in, windows }
 */
function probe({ home, env = process.env } = {}) {
    const h = home || os.homedir();
    return CLIS.map((c) => {
        const where = onPath(c.bin, env);
        const file = path.join(h, c.login);
        let login = null;
        try { login = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { login = null; }
        return {
            id: c.id,
            provider: c.provider,
            installed: !!where,
            signed_in: signedIn(login),
            windows: windowsOf(login),
        };
    });
}

/** The row of one CLI, or null. */
function probeOne(id, opts = {}) {
    return probe(opts).find((r) => r.id === id) || null;
}

module.exports = { CLIS, probe, probeOne, windowsOf, signedIn, onPath };
