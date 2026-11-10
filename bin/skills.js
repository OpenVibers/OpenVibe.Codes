'use strict';

/**
 * `openvibe-codes skills`: the guide an agent reads instead of a human pasting the CLI reference into a prompt.
 *
 * The guide is a file shipped inside the package, so it is version-matched by construction: `{{version}}` in the file
 * is replaced with this binary's own version, and a test fails if the guide and the CLI's flags drift apart. An agent
 * loads it on demand:
 *
 *   openvibe-codes skills list                 # the guides this binary ships
 *   openvibe-codes skills get                  # the openvibe-codes guide (Markdown, on stdout)
 *   openvibe-codes skills get openvibe-codes   # the same, named
 *   openvibe-codes skills path                 # where the file is, for a host that loads files itself
 */

const fs = require('fs');
const path = require('path');
const { version: VERSION } = require('../package.json');

const DIR = path.join(__dirname, 'skills');

// One guide today. Aliases keep `skills get codes` working; a second guide is one entry here and one file.
const GUIDES = [
    { name: 'openvibe-codes', aliases: ['codes'], file: 'openvibe-codes.md', description: 'run coding agents from a script or another agent: commands, --for-agent lines, exit codes, error codes, resume' },
];

const byName = (name) => GUIDES.find((g) => g.name === name || (g.aliases || []).includes(name)) || null;

/** Every guide this binary ships: its name, version, description and file. */
function list() {
    return GUIDES.map((g) => ({ name: g.name, version: VERSION, description: g.description, path: path.join(DIR, g.file) }));
}

/** One guide's Markdown, with the version this binary reports put in (it always matches the CLI it came from). */
function read(name = 'openvibe-codes') {
    const g = byName(name);
    if (!g) return null;
    const file = path.join(DIR, g.file);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
    return text.replace(/\{\{version\}\}/g, VERSION);
}

/**
 * The `skills` command. `out` is stdout's writer; the return value is the exit code.
 *
 * @param {string[]} argv words after `skills`
 * @param {{out: (s: string) => void, json?: boolean}} io
 */
function skills(argv, { out, json = false } = {}) {
    const [sub = 'list', name] = argv;
    if (sub === 'list') {
        const rows = list();
        if (json) { out(JSON.stringify(rows)); return 0; }
        for (const r of rows) out(`${r.name}  ${r.version}  ${r.description}`);
        return 0;
    }
    if (sub === 'get') {
        const text = read(name || 'openvibe-codes');
        if (text == null) {
            out(`no guide named ${name || ''} (openvibe-codes skills list)`);
            return 1;
        }
        out(text.trimEnd());
        return 0;
    }
    if (sub === 'path') {
        const g = byName(name || 'openvibe-codes');
        if (!g) { out(`no guide named ${name || ''} (openvibe-codes skills list)`); return 1; }
        out(path.join(DIR, g.file));
        return 0;
    }
    out(`unknown skills command ${sub} (openvibe-codes skills list|get|path [name])`);
    return 1;
}

module.exports = { GUIDES, list, read, skills, byName };
