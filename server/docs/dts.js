'use strict';

/**
 * A small reader for the SDK's hand-maintained .d.ts files: every top-level `export …` statement
 * with the /** doc comment right above it. Not a TypeScript parser — it only has to split the
 * statements the SDK writes (interfaces, types, declared functions, consts and classes,
 * re-exports), keeping each statement's text verbatim so the reference cannot drift from the file.
 */

const KINDS = [
    [/^export\s+(?:declare\s+)?interface\s+([A-Za-z0-9_$]+)/, 'interface'],
    [/^export\s+(?:declare\s+)?type\s+([A-Za-z0-9_$]+)/, 'type'],
    [/^export\s+declare\s+function\s+([A-Za-z0-9_$]+)/, 'function'],
    [/^export\s+declare\s+const\s+([A-Za-z0-9_$]+)/, 'const'],
    [/^export\s+declare\s+class\s+([A-Za-z0-9_$]+)/, 'class'],
    [/^export\s+\*\s+as\s+([A-Za-z0-9_$]+)/, 're-export'],
    [/^export\s+\*\s+from\s+['"]([^'"]+)['"]/, 're-export'],
    [/^export\s+type\s+\{([^}]*)\}\s+from/, 're-export'],
    [/^export\s+\{([^}]*)\}/, 're-export'],
];

function cleanDoc(raw) {
    return raw.replace(/^\/\*\*|\*\/$/g, '').split('\n').map((l) => l.replace(/^\s*\*\s?/, '')).join('\n').trim();
}

/** Split `source` into [{ kind, name, doc, text }]. */
function parseDts(source) {
    const out = [];
    const src = String(source).replace(/\r\n/g, '\n');
    let i = 0;
    let pendingDoc = '';
    while (i < src.length) {
        // Skip whitespace.
        const ws = src.slice(i).match(/^\s+/);
        if (ws) { i += ws[0].length; continue; }
        if (src.startsWith('/**', i)) {
            const end = src.indexOf('*/', i + 3);
            if (end < 0) break;
            pendingDoc = cleanDoc(src.slice(i, end + 2));
            i = end + 2;
            continue;
        }
        if (src.startsWith('//', i)) { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl + 1; continue; }
        if (src.startsWith('/*', i)) { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; pendingDoc = ''; continue; }

        // One statement: to the `;` or the closing `}` at depth 0 (interfaces and classes end at `}`).
        let depth = 0;
        let j = i;
        let sawBrace = false;
        let inStr = null;
        for (; j < src.length; j++) {
            const ch = src[j];
            if (inStr) { if (ch === inStr && src[j - 1] !== '\\') inStr = null; continue; }
            if (ch === '\'' || ch === '"' || ch === '`') { inStr = ch; continue; }
            if (ch === '{' || ch === '(' || ch === '<' || ch === '[') { if (ch === '{') sawBrace = true; depth++; continue; }
            if (ch === '}' || ch === ')' || ch === ']' || (ch === '>' && src[j - 1] !== '=')) {
                depth = Math.max(0, depth - 1);
                if (ch === '}' && depth === 0 && sawBrace && /^export\s+(?:declare\s+)?(?:interface|class)\b/.test(src.slice(i, i + 40))) { j++; break; }
                continue;
            }
            if (ch === ';' && depth === 0) { j++; break; }
        }
        const text = src.slice(i, j).trim();
        i = j;
        if (!text.startsWith('export')) { pendingDoc = ''; continue; }
        let kind = 'export';
        let name = '';
        for (const [re, k] of KINDS) {
            const m = text.match(re);
            if (m) { kind = k; name = m[1].trim(); break; }
        }
        if (kind === 'import') { pendingDoc = ''; continue; }
        out.push({ kind, name: name || text.slice(0, 60), doc: pendingDoc, text });
        pendingDoc = '';
    }
    return out;
}

module.exports = { parseDts };
