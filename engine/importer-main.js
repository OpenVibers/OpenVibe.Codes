'use strict';

/**
 * The importer anyone's agent can run (plan §AD.24; the owner, 11-18: "a prompt method they can just send their agent
 * and a manual method"). openvibe.codes serves it as one file with no packages to install (`/import.cjs`: this module
 * and engine/portable.js inlined, server/http/import-kit.js), so a Claude Code, Codex, Gemini CLI or OpenCode session,
 * or a hand-over any agent writes, reaches the person's account with one command:
 *
 *   node ov-import.cjs --link cdi_…                 this session: found on its own (the agent it runs under first)
 *   node ov-import.cjs --link cdi_… --file <path>   a session file of any harness, an OpenCode export, or a hand-over
 *   node ov-import.cjs --link cdi_… --session <id>  a named Claude Code session of this folder
 *   node ov-import.cjs --from codex|claude|gemini   which harness's newest session to take
 *   node ov-import.cjs … --out <file.json.gz>       write it instead of uploading (no link needed)
 *
 * The link (`cdi_…`, made at openvibe.codes/import) allows one upload into the person's account for 30 minutes and
 * nothing else, so no Network token is copied by hand.
 *
 *   main(argv, { portable, base, env, fetchImpl, out, home, cwd }) → exit code
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const LINK = /^cdi_[A-Za-z0-9_-]{32}$/;
const HELP = `ov-import: carries a coding agent's session to OpenVibe Codes, to continue it there.

  node ov-import.cjs --link cdi_…                  this session (Claude Code, Codex or Gemini CLI: found on its own)
  node ov-import.cjs --link cdi_… --file <path>    any session file, an OpenCode export, or a hand-over (.md / .txt)
  node ov-import.cjs --link cdi_… --session <id>   a named Claude Code session of this folder
  node ov-import.cjs --link cdi_… --from opencode --session <id>   an OpenCode session (runs \`opencode export\`)
  options: --from claude|codex|gemini|opencode   --cwd <folder>   --title "…"   --out <file.json.gz>

A link works once, for 30 minutes: make one at /import on OpenVibe Codes.`;

function opt(args, name) {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

/** The newest session of each harness this machine keeps for the folder: [{ harness, file, mtimeMs }]. */
function candidates(portable, { env, home, cwd }) {
    const out = [];
    const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    try {
        const file = portable.claudeSessionFile({ configDir, cwd });
        if (file) out.push({ harness: 'claude-code', file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch { /* none */ }
    try {
        const c = portable.codexSessionFile({ home: env.CODEX_HOME ? path.dirname(env.CODEX_HOME) : home, cwd });
        if (c) out.push({ harness: 'codex', ...c });
    } catch { /* none */ }
    try {
        const g = portable.geminiSessionFile({ home, cwd });
        if (g) out.push({ harness: 'gemini', ...g });
    } catch { /* none */ }
    return out;
}

/** Which harness this runs under, when the agent's shell says so. */
function runningUnder(env) {
    if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
    if (env.GEMINI_CLI === '1') return 'gemini';
    if (env.CODEX_SANDBOX || env.CODEX_MANAGED_BY_NPM || env.CODEX_HOME) return 'codex';
    if (env.OPENCODE === '1' || env.OPENCODE_BIN_PATH) return 'opencode';
    return null;
}

/** A session file of any kind → conversation.import@1. A large Claude Code file is read from its last compaction. */
function fromFile(portable, file, { title }) {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(Math.min(st.size, 64 * 1024));
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    const firstLines = portable.linesOf(head.toString('utf8')).slice(0, 20);
    if (firstLines.some((r) => r && typeof r.uuid === 'string' && typeof r.sessionId === 'string')) {
        const { meta, records } = portable.claudeTail(file);
        return portable.portable(records, meta, { title });
    }
    if (st.size > 200 * 1024 * 1024) throw new Error(`${file} is ${Math.round(st.size / 1048576)} MB: too large to carry`);
    let text = fs.readFileSync(file);
    if (text[0] === 0x1f && text[1] === 0x8b) text = zlib.gunzipSync(text);
    return portable.fromText(text.toString('utf8'), { name: path.basename(file), title });
}

async function main(argv, { portable, base, env = process.env, fetchImpl = globalThis.fetch, out = (l) => process.stdout.write(`${l}\n`), home = os.homedir(), cwd = process.cwd() } = {}) {
    const args = Array.isArray(argv) ? argv : [];
    if (args.includes('--help') || args.includes('-h')) { out(HELP); return 0; }
    const server = String(opt(args, '--base') || env.OPENVIBE_CODES_URL || base || 'https://openvibe.codes').replace(/\/+$/, '');
    const link = opt(args, '--link') || env.OPENVIBE_IMPORT_LINK || null;
    const toFile = opt(args, '--out');
    const title = opt(args, '--title');
    const folder = path.resolve(opt(args, '--cwd') || cwd);
    if (link && !LINK.test(link)) { out('That is not an import link (cdi_…): make one at ' + `${server}/import`); return 2; }
    if (!link && !toFile) { out(`No link. Make one at ${server}/import, then run this again with --link cdi_…`); return 2; }

    let doc;
    let from;
    try {
        const file = opt(args, '--file');
        const want = opt(args, '--from');
        const session = opt(args, '--session');
        if (file) {
            from = path.resolve(cwd, file);
            doc = fromFile(portable, from, { title });
        } else if (want === 'opencode' || (!want && runningUnder(env) === 'opencode')) {
            if (!session) throw new Error('OpenCode: name the session (--session <id>), or run `opencode export <id> > /tmp/ov-session.json` and pass --file /tmp/ov-session.json');
            if (!/^[A-Za-z0-9_-]{4,100}$/.test(session)) throw new Error('an OpenCode session id is letters, digits, _ and -');
            const text = execFileSync('opencode', ['export', session], { cwd: folder, encoding: 'utf8', maxBuffer: 200 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
            from = `opencode export ${session}`;
            doc = portable.fromText(text.slice(text.indexOf('{')), { title });
        } else if (session && (!want || want === 'claude' || want === 'claude-code')) {
            const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
            from = portable.claudeSessionFile({ configDir, cwd: folder, session });
            if (!from) throw new Error(`no Claude Code session ${session} for ${folder}`);
            doc = fromFile(portable, from, { title });
        } else {
            const all = candidates(portable, { env, home, cwd: folder });
            const harness = want === 'claude' ? 'claude-code' : want || runningUnder(env);
            const pick = harness
                ? all.find((c) => c.harness === harness)
                : all.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
            if (!pick) {
                throw new Error(`no ${harness || 'Claude Code, Codex or Gemini CLI'} session found for ${folder}. Write the conversation to a file `
                    + '(the goal, decisions, what is done and left, the last exchanges under "## User" / "## Assistant") and pass --file <it>');
            }
            from = pick.file;
            doc = fromFile(portable, from, { title });
        }
    } catch (e) {
        out(String((e && e.message) || e));
        return 2;
    }
    const what = `${doc.harness} session ${doc.session_id}: ${doc.counts.messages} messages, "${doc.title}"`;
    const body = zlib.gzipSync(JSON.stringify(doc));
    if (toFile) {
        fs.writeFileSync(toFile, body, { mode: 0o600 });
        out(`Wrote ${what} from ${from} to ${toFile} (${Math.round(body.length / 1024)} KB)`);
        if (!link) return 0;
    }
    let res;
    try {
        res = await fetchImpl(`${server}/api/v1/sessions/imports`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${link}`, Accept: 'application/json', 'Content-Type': 'application/octet-stream', 'X-OV-Filename': path.basename(String(from)).slice(0, 120) },
            body, signal: AbortSignal.timeout(180_000),
        });
    } catch (e) {
        out(`OpenVibe Codes did not answer (${server}): ${e.message}`);
        return 1;
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
        out(`${res.status} ${(json && json.code) || ''}: ${(json && (json.detail || json.title)) || 'the import was refused'}`);
        return 1;
    }
    const imp = json && json.import;
    out(`Imported ${what} (${Math.round(body.length / 1024)} KB from ${from})`);
    out(`Continue it: ${server}/conductor?import=${imp.id}`);
    if (!imp.resumable) out('It continues as a new session that reads this whole conversation first.');
    return 0;
}

module.exports = { main, candidates, runningUnder, fromFile, HELP, LINK };
