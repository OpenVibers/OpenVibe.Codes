'use strict';

/**
 * The skill loader: procedures kept as files in the repository, with their metadata always at hand and their body
 * only when the task matches.
 *
 * A skill is a folder with a `SKILL.md` in one of the conventional roots (`.openvibe/skills`, `.claude/skills`,
 * `.agents/skills`, `skills`). The file starts with a small frontmatter block:
 *
 *   ---
 *   name: ship-it
 *   description: Merge a green PR and deploy its service
 *   invocation: model          # model (the loader may load it) or user (only when the person names it)
 *   when_to_use: ship, deploy, merge the pull request
 *   references: references/traps.md
 *   scripts: scripts/ship.sh
 *   ---
 *
 *   # Ship it
 *   …the procedure…
 *
 * Why split it: a repository with thirty skills would put thirty procedures in every prompt, and most of them are
 * irrelevant to the task at hand. The metadata (name, one line, where the body is) is cheap and always loaded; a
 * matching skill's body is loaded by `brief`; the references and scripts stay files the agent opens itself, so a
 * large reference never costs tokens until it is needed.
 *
 *   parse(text)                         { meta, body, errors } from a SKILL.md
 *   index(root)                         every skill under the conventional roots, with validation errors
 *   validate(skill)                     { valid, errors }: name, body length, pointers, invocation
 *   load(skill)                         the body, on demand (a skill that failed validation is not loaded)
 *   readReference(skill, name)          one reference or script file, on demand
 *   brief(skills, { prompt })           { block, loaded, skipped }: metadata + the bodies this task triggered
 *
 * Default off: the harness passes `skills: true` on the job (or sets CODES_SKILLS_LOADER=1) before a prompt gets a
 * skills block. A repository with no skills is normal and produces nothing.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIRS = ['.openvibe/skills', '.claude/skills', '.agents/skills', 'skills'];
const MAX_LINES = 500;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 500;
const MAX_LOADED = 3;
const MAX_LOADED_CHARS = 24_000;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const INVOCATIONS = ['model', 'user'];
const POINTER = /(?:^|[\s(`'"[<])((?:references|scripts)\/[A-Za-z0-9._/-]+)/g;

const clean = (v) => String(v == null ? '' : v).replace(/\r\n/g, '\n');
const linesOf = (text) => clean(text).split('\n').length;

/** A pointer list from `a, b` or `[a, b]` or a YAML dash block folded into one line. */
function listOf(value) {
    const raw = String(value == null ? '' : value).trim().replace(/^\[|\]$/g, '');
    if (!raw) return [];
    return raw.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

/**
 * Parse one SKILL.md. The frontmatter is deliberately small: `key: value` lines (and `[a, b]` lists), because a
 * skill is a procedure, not a YAML document. An unknown key is kept in `meta` and not an error; a missing opening
 * or closing fence is.
 *
 * @param {string} text the file
 * @returns {{ meta: object, body: string, errors: string[] }} the parsed skill
 */
function parse(text) {
    const raw = clean(text);
    const errors = [];
    if (!raw.startsWith('---\n')) return { meta: {}, body: raw, errors: ['SKILL.md must start with a --- frontmatter block'] };
    const end = raw.indexOf('\n---', 4);
    if (end < 0) return { meta: {}, body: raw, errors: ['SKILL.md frontmatter has no closing --- line'] };
    const head = raw.slice(4, end).split('\n');
    const body = raw.slice(end + 4).replace(/^\n/, '');
    const meta = {};
    for (const line of head) {
        const s = line.trim();
        if (!s || s.startsWith('#')) continue;
        const at = s.indexOf(':');
        if (at <= 0) { errors.push(`frontmatter line is not key: value — ${s.slice(0, 80)}`); continue; }
        const key = s.slice(0, at).trim();
        const value = s.slice(at + 1).trim().replace(/^['"]|['"]$/g, '');
        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) { errors.push(`frontmatter key is not a name — ${key.slice(0, 40)}`); continue; }
        meta[key] = value;
    }
    return { meta, body, errors };
}

/** The path under the skill's folder, or null when it would leave it. */
function inside(dir, rel) {
    const p = path.resolve(dir, rel);
    const root = path.resolve(dir) + path.sep;
    return p.startsWith(root) ? p : null;
}

/** The references and scripts a skill names, each with whether it is really there. */
function filesOf(dir, meta, body) {
    const declared = {
        references: listOf(meta.references),
        scripts: listOf(meta.scripts),
    };
    const used = new Set();
    const seen = new Set();
    let m;
    POINTER.lastIndex = 0;
    while ((m = POINTER.exec(clean(body))) !== null) {
        const rel = m[1].replace(/[.,;:)]+$/, '');   // a pointer at the end of a sentence keeps no full stop
        if (!seen.has(rel)) { seen.add(rel); used.add(rel); }
    }
    const out = [];
    for (const [kind, list] of Object.entries(declared)) {
        for (const rel of list) {
            const full = inside(dir, rel);
            out.push({ kind, name: rel, path: full, exists: !!full && fs.existsSync(full) });
        }
    }
    for (const rel of used) {
        if (out.some((f) => f.name === rel)) continue;
        const kind = rel.startsWith('scripts/') ? 'scripts' : 'references';
        const full = inside(dir, rel);
        out.push({ kind, name: rel, path: full, exists: !!full && fs.existsSync(full) });
    }
    return out;
}

/**
 * Read one skill folder (or one SKILL.md path) into a record. A thin folder with no SKILL.md is an error and not a
 * skill.
 *
 * @param {string} file the SKILL.md (or its folder)
 * @returns {{ skill: object|null, error: string|null }} the record or why there is none
 */
function read(file) {
    const p = path.resolve(String(file || ''));
    const skillFile = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'SKILL.md') : p;
    let text;
    try { text = fs.readFileSync(skillFile, 'utf8'); } catch (err) { return { skill: null, error: `cannot read ${skillFile}: ${err.message}` }; }
    const dir = path.dirname(skillFile);
    const parsed = parse(text);
    const meta = parsed.meta;
    const name = String(meta.name || path.basename(dir)).trim();
    const invocation = String(meta.invocation || meta['invoked-by'] || 'model').trim().toLowerCase();
    const skill = {
        name,
        description: String(meta.description || '').trim(),
        invocation,
        when_to_use: String(meta.when_to_use || meta['when-to-use'] || '').trim(),
        dir,
        file: skillFile,
        rel: path.relative(process.cwd(), skillFile).split(path.sep).join('/'),
        body_lines: linesOf(parsed.body),
        body: parsed.body,
        files: filesOf(dir, meta, parsed.body),
        meta,
        parse_errors: parsed.errors,
    };
    const check = validate(skill);
    skill.valid = check.valid;
    skill.errors = check.errors;
    return { skill, error: null };
}

/**
 * Validate one skill record: the name, the one-line description, the 500-line body, the invocation split, and every
 * pointer (`references/…`, `scripts/…`) really inside the folder.
 *
 * @param {object} skill a record from read()
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validate(skill) {
    const errors = [];
    if (!skill || typeof skill !== 'object') return { valid: false, errors: ['a skill must be an object'] };
    for (const e of skill.parse_errors || []) errors.push(e);
    if (!NAME.test(String(skill.name || ''))) errors.push(`name must be ${MAX_NAME} lowercase letters, digits and dashes`);
    if (String(skill.name || '').length > MAX_NAME) errors.push(`name is longer than ${MAX_NAME} characters`);
    if (!String(skill.description || '').trim()) errors.push('description is required');
    else if (skill.description.length > MAX_DESCRIPTION) errors.push(`description is longer than ${MAX_DESCRIPTION} characters`);
    if (!INVOCATIONS.includes(String(skill.invocation || ''))) errors.push(`invocation is one of ${INVOCATIONS.join(', ')}`);
    if (Number(skill.body_lines) > MAX_LINES) errors.push(`body is ${skill.body_lines} lines; the limit is ${MAX_LINES} (move detail into references/)`);
    if (skill.dir && path.basename(skill.dir) !== skill.name) errors.push(`name ${skill.name} does not match its folder ${path.basename(skill.dir)}`);
    for (const f of skill.files || []) {
        if (!f.path) errors.push(`${f.kind} pointer ${f.name} leaves the skill folder`);
        else if (!f.exists) errors.push(`${f.kind} pointer ${f.name} is missing`);
    }
    return { valid: errors.length === 0, errors };
}

/**
 * Every skill in a checkout, under the conventional roots (and the roots a caller adds). A broken skill is reported
 * with its errors and left out of `skills`, so a loader never prompts from a file it could not check.
 *
 * @param {string} root the repository folder
 * @param {object} [opts]
 * @param {string[]} [opts.roots] extra folders, relative to root
 * @returns {{ skills: object[], errors: object[], roots: string[] }} the index
 */
function index(root, { roots = [] } = {}) {
    const base = path.resolve(String(root || '.'));
    const dirs = [...ROOT_DIRS, ...roots.map(String)].filter((v, i, a) => v && a.indexOf(v) === i);
    const skills = [];
    const errors = [];
    const found = [];
    for (const rel of dirs) {
        const dir = path.join(base, rel);
        let names = [];
        try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { continue; }
        for (const name of names) {
            const got = read(path.join(dir, name));
            if (!got.skill) { errors.push({ file: path.join(dir, name), errors: [got.error] }); continue; }
            if (!got.skill.valid) { errors.push({ file: got.skill.file, name: got.skill.name, errors: got.skill.errors }); continue; }
            if (found.includes(got.skill.name)) { errors.push({ file: got.skill.file, name: got.skill.name, errors: [`name ${got.skill.name} is used by two skills`] }); continue; }
            found.push(got.skill.name);
            skills.push(got.skill);
        }
    }
    return { skills, errors, roots: dirs };
}

/** The body, on demand. A skill that did not validate has no body to load. */
function load(skill) {
    if (!skill || !skill.valid) return null;
    return String(skill.body || '');
}

/** One reference or script, on demand; null when the skill did not declare it or the file is gone. */
function readReference(skill, name) {
    if (!skill || !skill.valid) return null;
    const f = (skill.files || []).find((x) => x.name === name && x.exists && x.path);
    if (!f) return null;
    try { return fs.readFileSync(f.path, 'utf8'); } catch { return null; }
}

/** The words that trigger a skill: its own name, and each when-to-use phrase of three letters or more. */
function triggersOf(skill) {
    const out = [String(skill.name || '').toLowerCase()];
    for (const phrase of listOf(skill.when_to_use)) if (phrase.length >= 3) out.push(phrase.toLowerCase());
    return out.filter(Boolean);
}

/** Is this skill's name said in the task? That is how a person invokes a skill explicitly. */
function named(skill, prompt) {
    const p = String(prompt || '').toLowerCase();
    if (!p || !skill || !skill.name) return false;
    const t = String(skill.name).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9-])${t}([^a-z0-9-]|$)`, 'i').test(p);
}

/** Does one of the skill's when-to-use phrases appear in the task? */
function phraseMatched(skill, prompt) {
    const p = String(prompt || '').toLowerCase();
    if (!p) return false;
    return listOf(skill && skill.when_to_use).some((t) => t.length >= 3 && p.includes(t.toLowerCase()));
}

/**
 * Does the loader load this skill for this task? A skill the person names by name always; a model-invoked skill also
 * when one of its when-to-use phrases matches; a user-invoked skill never on a phrase alone.
 */
function triggered(skill, prompt) {
    if (named(skill, prompt)) return true;
    return String(skill && skill.invocation) !== 'user' && phraseMatched(skill, prompt);
}

/** A path relative to the checkout, for words a person reads; absolute outside it. */
function shown(file, root) {
    const rel = root ? path.relative(root, file) : path.relative(process.cwd(), file);
    return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : file;
}

/**
 * The block a prompt gets: one line per model-invoked skill (name, description, body path), then the full body of
 * the skills this task triggered (at most three, 24,000 characters) and, for a user-invoked skill, its body only when
 * the person named it. References and scripts are named, never pasted.
 *
 * @param {object[]} skills validated records from index()
 * @param {object} [opts]
 * @param {string} [opts.prompt] the task's brief, for trigger matching
 * @param {string} [opts.root] the checkout, for relative paths
 * @returns {{ block: string, loaded: string[], skipped: string[] }} the prompt block and what was loaded
 */
function brief(skills = [], { prompt = '', root = '' } = {}) {
    const list = Array.isArray(skills) ? skills.filter((s) => s && s.valid !== false) : [];
    if (!list.length) return { block: '', loaded: [], skipped: [] };
    const meta = [];
    const bodies = [];
    const loaded = [];
    const skipped = [];
    let used = 0;
    for (const skill of list) {
        const hit = triggered(skill, prompt);
        const metaLine = `- ${skill.name} (${skill.invocation})${skill.description ? `: ${skill.description}` : ''} — body: ${shown(skill.file, root)}`;
        if (!hit) {
            meta.push(metaLine);
            continue;
        }
        const body = load(skill);
        if (!body) { meta.push(metaLine); skipped.push(skill.name); continue; }
        if (loaded.length >= MAX_LOADED || used + body.length > MAX_LOADED_CHARS) {
            meta.push(metaLine);
            skipped.push(skill.name);
            continue;
        }
        const refs = (skill.files || []).map((f) => f.name).filter(Boolean);
        meta.push(metaLine);
        bodies.push([`### ${skill.name}`, body.trim(), refs.length ? `Files this skill may need (open only what the step needs): ${refs.join(', ')}` : ''].filter(Boolean).join('\n\n'));
        loaded.push(skill.name);
        used += body.length;
    }
    if (!meta.length && !bodies.length) return { block: '', loaded: [], skipped: [] };
    const block = [
        '## Skills in this repository',
        'Metadata is listed here; a triggered procedure is included in full. Open a skill\'s body only when what you are about to do matches it, and open its references or scripts only when a step needs them.',
        ...meta,
        ...bodies,
        skipped.length ? `Not included (over the three-skill or ${MAX_LOADED_CHARS}-character limit): ${skipped.join(', ')}. Open one by the path above if the task needs it.` : '',
    ].filter(Boolean).join('\n\n');
    return { block, loaded, skipped };
}

module.exports = {
    ROOT_DIRS, MAX_LINES, MAX_DESCRIPTION, MAX_LOADED, MAX_LOADED_CHARS, INVOCATIONS,
    parse, read, index, validate, load, readReference, triggersOf, triggered, brief,
};
