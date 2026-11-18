'use strict';

/**
 * Moving a session here (plan §AD.24; the owner, 11-18: "a prompt method they can just send their agent and a manual
 * method"): the one-file importer openvibe.codes serves, and the words the /import page and its API hand out.
 *
 *   importerScript(baseUrl)            → the importer as one file (engine/portable.js and engine/importer-main.js
 *                                        inlined: nothing to install, Node 18+), served at /import.cjs and /import.js
 *   commandFor(baseUrl, token)         → { unix, windows } the two lines a person runs themselves
 *   promptFor(baseUrl, token, expires) → the message a person sends their own agent
 */
const fs = require('fs');
const path = require('path');

const ENGINE = path.join(__dirname, '..', '..', 'engine');
let cached = null;

function body(file) {
    return fs.readFileSync(path.join(ENGINE, file), 'utf8').replace(/^'use strict';\n/, '');
}

function importerScript(baseUrl) {
    const base = String(baseUrl || 'https://openvibe.codes').replace(/\/+$/, '');
    if (!cached) {
        cached = [
            body('portable.js'),
            body('importer-main.js'),
        ];
    }
    const [portable, main] = cached;
    return `#!/usr/bin/env node
'use strict';
// OpenVibe Codes session importer, served by ${base}/import.cjs (source: github.com/OpenVibers/OpenVibe.Codes,
// engine/portable.js and engine/importer-main.js). It reads one coding agent's session on this machine and uploads it,
// with a one-time link, to your account on OpenVibe Codes. It reads nothing else and sends nothing else.
// Run: node ov-import.cjs --link cdi_…   (node ov-import.cjs --help for the rest)
const OV_BASE = ${JSON.stringify(base)};
const portable = (() => { const module = { exports: {} }; ${portable}
return module.exports; })();
const importer = (() => { const module = { exports: {} }; ${main}
return module.exports; })();
importer.main(process.argv.slice(2), { portable, base: OV_BASE }).then((code) => { process.exitCode = code; }, (e) => { console.error(e && e.message ? e.message : e); process.exitCode = 1; });
`;
}

function commandFor(baseUrl, token) {
    const base = String(baseUrl).replace(/\/+$/, '');
    return {
        unix: `curl -fsSL ${base}/import.cjs -o /tmp/ov-import.cjs && node /tmp/ov-import.cjs --link ${token}`,
        windows: `curl.exe -fsSL ${base}/import.cjs -o $env:TEMP\\ov-import.cjs; node $env:TEMP\\ov-import.cjs --link ${token}`,
    };
}

function untilText(expiresAt) {
    const d = new Date(expiresAt);
    return Number.isFinite(d.getTime()) ? `${d.toISOString().slice(11, 16)} UTC` : 'in 30 minutes';
}

function promptFor(baseUrl, token, expiresAt) {
    const base = String(baseUrl).replace(/\/+$/, '');
    return `Please move this conversation to OpenVibe Codes, so I can continue it there.

1. Download the importer (one small Node.js file, nothing to install; read it first if you like: it only reads this session and uploads it):
   curl -fsSL ${base}/import.cjs -o /tmp/ov-import.cjs
2. From this session's working folder, run:
   node /tmp/ov-import.cjs --link ${token}
   It finds this session on its own (Claude Code, Codex or Gemini CLI).
   - In OpenCode: run \`node /tmp/ov-import.cjs --link ${token} --from opencode --session <this session's id>\`.
   - If you are another agent, or it picks the wrong session: write this whole conversation to /tmp/ov-handover.md (what I asked for, the decisions, what is done, what is left, open problems, and the last few exchanges word for word, under "## User" and "## Assistant" headings), then run the command again with --file /tmp/ov-handover.md
3. Tell me the link it prints.

The link works once, until ${untilText(expiresAt)}. It needs Node.js 18 or later (on Windows, use %TEMP% instead of /tmp).`;
}

module.exports = { importerScript, commandFor, promptFor, untilText };
