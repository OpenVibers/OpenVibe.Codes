'use strict';

/**
 * `openvibe-codes import`: a coding agent's saved session, to openvibe.codes under your account (plan §AD.22,
 * conversation.import@1). From there it continues on any of your machines: the agent there resumes it with its whole
 * context (Claude Code's `--resume`), as a conductor session you drive from openvibe.codes.
 *
 *   openvibe-codes import                          the newest Claude Code session of this folder
 *   openvibe-codes import --session <id>           a named one of this folder
 *   openvibe-codes import --file <session.jsonl>   any Claude Code session file
 *   openvibe-codes import --codex <rollout.jsonl>  a Codex session (to read and hand over)
 *   openvibe-codes import … --out <file.json.gz>   write it to a file instead of uploading
 *   openvibe-codes import … --title "…"            its name on openvibe.codes
 *
 * Only the conversation since the session's last compaction travels (a session file holds every request too: one of
 * 3.8 GB carried as 6 MB, 1 MB compressed). Your Network token signs the upload, as for `openvibe-codes task`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const portable = require('../engine/portable');
const { auth, EXIT } = require('./task');

const USAGE = `openvibe-codes import [--session <id> | --file <session.jsonl> | --codex <rollout.jsonl>] [--cwd <folder>]
                      [--title "…"] [--link cdi_…] [--out <file.json.gz>] [--json]

Carries a coding agent's session to openvibe.codes under your account, to continue on any of your machines.
Default: the newest Claude Code session of this folder (or --cwd). CLAUDE_CONFIG_DIR is where Claude Code keeps them
(default ~/.claude). Signed by --link (a one-time link from openvibe.codes/import), else OPENVIBE_TOKEN or
~/.config/openvibe/token. Server: OPENVIBE_CODES_URL. Any other harness: openvibe.codes/import.`;

function opt(args, name) {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

/** The document for the arguments: { doc, from }. */
function build(args, env = process.env) {
    const codex = opt(args, '--codex');
    if (codex) return { doc: portable.codexSession(path.resolve(codex)), from: path.resolve(codex) };
    const configDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    let file = opt(args, '--file');
    if (file) file = path.resolve(file);
    else {
        const cwd = path.resolve(opt(args, '--cwd') || process.cwd());
        file = portable.claudeSessionFile({ configDir, cwd, session: opt(args, '--session') });
        if (!file) throw Object.assign(new Error(`no Claude Code session for ${cwd} in ${configDir} (name one with --file)`), { exit: EXIT.usage });
    }
    const { meta, records } = portable.claudeTail(file);
    return { doc: portable.portable(records, meta, { title: opt(args, '--title') }), from: file };
}

async function upload(doc, { link = null } = {}) {
    // A one-time link from openvibe.codes/import signs this one upload; without one, your Network token does.
    const c = link ? { base: String(process.env.OPENVIBE_CODES_URL || 'https://openvibe.codes').replace(/\/+$/, ''), token: link } : auth();
    const body = zlib.gzipSync(JSON.stringify(doc));
    let res;
    try {
        res = await fetch(`${c.base}/api/v1/sessions/imports`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/json', 'Content-Type': 'application/octet-stream' },
            body, signal: AbortSignal.timeout(120_000),
        });
    } catch (e) {
        throw Object.assign(new Error(`OpenVibe.Codes did not answer (${c.base}): ${e.message}`), { exit: EXIT.failed });
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${(json && (json.code || json.error)) || ''}: ${(json && (json.detail || json.title)) || 'the import was refused'}`), { exit: EXIT.failed });
    return { ...json, base: c.base, bytes: body.length };
}

async function importCommand(args, { out = (l) => process.stdout.write(`${l}\n`) } = {}) {
    if (args.includes('--help') || args.includes('-h')) { out(USAGE); return 0; }
    let built;
    try { built = build(args); } catch (e) { out(e.message); return e.exit || EXIT.usage; }
    const { doc, from } = built;
    const what = `${doc.harness} session ${doc.session_id}: ${doc.counts.messages} messages (${doc.counts.records} records) from ${from}`;
    const file = opt(args, '--out');
    if (file) {
        fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(doc)), { mode: 0o600 });
        out(`Wrote ${what} to ${file}`);
        return 0;
    }
    try {
        const link = opt(args, '--link') || process.env.OPENVIBE_IMPORT_LINK || null;
        if (link && !/^cdi_[A-Za-z0-9_-]{32}$/.test(link)) { out('That is not an import link (cdi_…): make one at openvibe.codes/import'); return EXIT.usage; }
        const r = await upload(doc, { link });
        if (args.includes('--json')) { out(JSON.stringify(r.import)); return 0; }
        out(`Imported ${what}`);
        out(`  ${r.import.title}`);
        out(`  ${r.base}/conductor?import=${r.import.id} : continue it on one of your machines`);
        return 0;
    } catch (e) {
        out(e.message);
        return e.exit || EXIT.failed;
    }
}

module.exports = { importCommand, build, USAGE };
