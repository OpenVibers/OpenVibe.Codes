'use strict';

/**
 * Where an edit's old_string is in a file, forgiving the mistakes models make most, ported to CommonJS from OpenCode's
 * edit tool (MIT, sst/opencode packages/core/src/tool/plugin/edit.ts, read 11-15):
 *
 *   1. exactly;
 *   2. else with typographic quotes, dashes and odd spaces read as plain ones (one character for one, so offsets hold);
 *   3. else line by line, ignoring each line's trailing whitespace.
 *
 * Matching runs on the file's LF view (the view read_file shows) and maps back to the source, so CRLF and mixed
 * endings neither block a match nor leak into untouched lines; a replacement takes the line endings of the region it
 * replaces, line by line. A miss comes with a hint: new_string is already there (an edit that already applied), or the
 * lines closest to old_string, numbered like read_file, so the next try needs no second read.
 */
const CRLF = '\r\n';

const normalize = (v) => String(v)
    .replace(/[‘’‚‛]/g, '\'')
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/[  -   　]/g, ' ');

function occurrences(content, search) {
    const out = [];
    if (!search) return out;
    for (let at = content.indexOf(search); at !== -1; at = content.indexOf(search, at + search.length)) out.push({ start: at, end: at + search.length });
    return out;
}

function lineOccurrences(content, search) {
    const trailingNewline = search.endsWith('\n');
    const expected = search.split('\n');
    if (trailingNewline) expected.pop();
    if (!expected.length || (expected.length === 1 && !expected[0].trim())) return [];
    const lines = [];
    const re = /[^\n]*(?:\n|$)/g;
    for (let m = re.exec(content); m && m[0] !== ''; m = re.exec(content)) {
        const newline = m[0].endsWith('\n');
        const text = newline ? m[0].slice(0, -1) : m[0];
        lines.push({ start: m.index, end: m.index + m[0].length, text, contentEnd: m.index + text.length - (text.endsWith('\r') ? 1 : 0), newline });
        if (re.lastIndex === m.index) re.lastIndex++;
    }
    const key = (s) => normalize(s.trimEnd());
    const want = expected.map(key);
    const out = [];
    for (let i = 0; i + want.length <= lines.length; i++) {
        let ok = true;
        for (let k = 0; k < want.length && ok; k++) ok = key(lines[i + k].text) === want[k];
        if (!ok) continue;
        const last = lines[i + want.length - 1];
        if (trailingNewline && !last.newline) continue;
        const cand = { start: lines[i].start, end: trailingNewline ? last.end : last.contentEnd };
        if (!out.some((m) => m.end > cand.start && m.start < cand.end)) out.push(cand);
    }
    return out;
}

function countBefore(sorted, offset) {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < offset) lo = mid + 1; else hi = mid; }
    return lo;
}

function lineEnding(text, fallback) {
    const crlf = text.split(CRLF).length - 1;
    const lf = text.split('\n').length - 1 - crlf;
    if (crlf === lf) return fallback;
    return crlf > lf ? CRLF : '\n';
}

/** For each line of `after`, the `before` line it keeps (longest common subsequence) or takes the place of. */
function alignLines(before, after) {
    const w = after.length + 1;
    const table = new Uint32Array((before.length + 1) * w);
    for (let i = before.length - 1; i >= 0; i--) {
        for (let j = after.length - 1; j >= 0; j--) {
            table[i * w + j] = before[i] === after[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
        }
    }
    const result = [];
    let gapBefore = [];
    let gapAfter = [];
    const flush = () => { gapAfter.forEach((j, k) => { result[j] = gapBefore[k]; }); gapBefore = []; gapAfter = []; };
    let i = 0;
    let j = 0;
    while (i < before.length && j < after.length) {
        if (before[i] === after[j]) { flush(); result[j++] = i++; continue; }
        if (table[(i + 1) * w + j] >= table[i * w + j + 1]) gapBefore.push(i++); else gapAfter.push(j++);
    }
    while (i < before.length) gapBefore.push(i++);
    while (j < after.length) gapAfter.push(j++);
    flush();
    return result;
}

function withRegionEndings(region, replacement, fallback) {
    const before = region.split(/\r?\n/);
    const endings = [...region.matchAll(/\r?\n/g)].map((m) => m[0]);
    const after = replacement.split('\n');
    const key = (l) => normalize(l.trimEnd());
    // A large region or replacement keeps one ending for all (the alignment table is quadratic).
    if (before.length * after.length > 4_000_000) return after.join(fallback);
    const source = alignLines(before.map(key), after.map(key));
    return after.map((line, idx) => (idx === after.length - 1 ? line : line + (endings[source[idx]] || fallback))).join('');
}

/**
 * The matches of oldString in source (source offsets), by the first tier that finds any, and how to write each one.
 * → { matches: [{ start, end }], tier: 'exact' | 'unicode' | 'trailing-whitespace' | null, replace(match) }
 */
function matchEdit(source, oldString, newString) {
    const view = source.split(CRLF).join('\n');
    const removed = [];
    for (let at = source.indexOf(CRLF), n = 0; at !== -1; at = source.indexOf(CRLF, at + 2), n++) removed.push(at - n);
    const fileEnding = lineEnding(source, '\n');
    const search = String(oldString).split(CRLF).join('\n');
    const replacement = String(newString).split(CRLF).join('\n');
    let tier = 'exact';
    let found = occurrences(view, search);
    if (!found.length) { tier = 'unicode'; found = occurrences(normalize(view), normalize(search)); }
    if (!found.length) { tier = 'trailing-whitespace'; found = lineOccurrences(view, search); }
    if (!found.length) tier = null;
    return {
        tier,
        matches: found.map((m) => ({ start: m.start + countBefore(removed, m.start), end: m.end + countBefore(removed, m.end) })),
        replace: (m) => { const region = source.slice(m.start, m.end); return withRegionEndings(region, replacement, lineEnding(region, fileEnding)); },
    };
}

/** A hint for a miss, or '' when nothing useful is close. */
function missHint(source, oldString, newString) {
    const view = source.split(CRLF).join('\n');
    const replacement = String(newString).split(CRLF).join('\n');
    if (replacement.trim().length >= 20 && normalize(view).includes(normalize(replacement))) return 'new_string is already in the file, so this edit may already be applied.';
    const key = (l) => normalize(l).replace(/\s+/g, '');   // all whitespace ignored: sub(a,b) finds sub(a, b)
    const distinct = (l) => /[\p{L}\p{N}]/u.test(l);
    const lines = view.split('\n');
    const search = String(oldString).split(CRLF).join('\n').split('\n');
    const positions = new Map();
    lines.forEach((l, i) => { const v = key(l); if (!distinct(v)) return; const p = positions.get(v); if (p) p.push(i); else positions.set(v, [i]); });
    const votes = new Map();
    let wanted = 0;
    search.forEach((l, off) => {
        const v = key(l);
        if (!distinct(v)) return;
        wanted++;
        for (const i of positions.get(v) || []) votes.set(i - off, (votes.get(i - off) || 0) + 1);
    });
    let start = 0;
    let count = 0;
    for (const [s, c] of votes) if (c > count) { start = s; count = c; }
    if (!count || count * 2 < wanted) return '';
    const matched = [];
    search.forEach((l, off) => { const v = key(l); const i = start + off; if (v && i >= 0 && i < lines.length && key(lines[i]) === v) matched.push(i); });
    if (!matched.length) return '';
    const from = matched[0];
    const to = Math.min(matched[matched.length - 1] + 1, from + 12);
    return ['The closest lines in the file:', ...lines.slice(from, to).map((l, i) => `${from + i + 1}\t${l.length > 200 ? `${l.slice(0, 200)}…` : l}`)].join('\n');
}

/**
 * old_string → new_string in text: { text, count, tier } or { error, hint }. One match unless replaceAll.
 */
function applyEdit(text, oldString, newString, { replaceAll = false } = {}) {
    const old = String(oldString || '');
    if (!old) return { error: 'old_string is empty: read the file and copy the lines to change' };
    const m = matchEdit(text, old, newString == null ? '' : newString);
    if (!m.matches.length) return { error: 'old_string not found', hint: missHint(text, old, newString == null ? '' : newString) };
    if (m.matches.length > 1 && !replaceAll) return { error: `old_string occurs ${m.matches.length} times: add context so it is unique, or set replace_all` };
    let out = '';
    let at = 0;
    for (const match of m.matches) { out += text.slice(at, match.start) + m.replace(match); at = match.end; }
    out += text.slice(at);
    return { text: out, count: m.matches.length, tier: m.tier };
}

module.exports = { applyEdit, matchEdit, missHint, normalize };
