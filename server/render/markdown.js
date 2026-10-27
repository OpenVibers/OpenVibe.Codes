'use strict';

/**
 * A deliberately small Markdown renderer for the ADRs shipped inside openvibe-contracts (the policy
 * pages render them verbatim, so the policy cannot drift from the decision record). Everything is
 * escaped first; only headings, paragraphs, lists, fenced code, pipe tables, bold, inline code and
 * links are recognised. Links are kept only when http(s) or relative.
 */
const { esc } = require('./html');

function inline(s) {
    let out = esc(s);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) => {
        const h = href.replace(/&amp;/g, '&');
        if (/^https?:\/\//.test(h) || /^[#./a-zA-Z0-9]/.test(h) && !/^[a-z]+:/i.test(h)) return `<a href="${esc(h)}">${text}</a>`;
        return text;
    });
    return out;
}

/** A table row's cells: split on pipes not escaped as \|, one optional outer pipe on each side. */
function cells(line) {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
    const out = [];
    let cur = '';
    for (let k = 0; k < t.length; k++) {
        if (t[k] === '\\' && t[k + 1] === '|') { cur += '|'; k++; continue; }
        if (t[k] === '|') { out.push(cur.trim()); cur = ''; continue; }
        cur += t[k];
    }
    out.push(cur.trim());
    return out;
}

/** Whether a line is a table's delimiter row (| --- | :-: |), checked without a backtracking pattern. */
const isDelimiter = (line) => !!line && line.includes('|') && /^[\s|:-]+$/.test(line) && cells(line).every((c) => /^:?-+:?$/.test(c));

function markdown(src, { headingOffset = 1 } = {}) {
    const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let para = [];
    let list = null;   // { type: 'ul' | 'ol', items: [] }
    let fence = null;
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`); list = null; } };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (fence) {
            if (/^```/.test(line)) { out.push(`<pre tabindex="0"><code>${esc(fence.join('\n'))}</code></pre>`); fence = null; } else fence.push(line);
            continue;
        }
        if (/^```/.test(line)) { flushPara(); flushList(); fence = []; continue; }
        // A pipe table (14 ADRs have them): a header row whose cells match the delimiter row under it, then rows while
        // lines hold a pipe. It scrolls inside its own box, so it is a labelled region keyboard users can reach.
        // At most 64 columns and 1000 rows, so a hostile table costs at most 64,000 cells.
        if (line.includes('|') && isDelimiter(lines[i + 1]) && cells(line).length === cells(lines[i + 1]).length && cells(line).length <= 64) {
            flushPara(); flushList();
            const head = cells(line);
            const rows = [];
            for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|') && rows.length < 1000; i++) rows.push(cells(lines[i]));
            i--;
            out.push(`<div class="table-wrap" tabindex="0" role="region" aria-label="Table: ${esc(head.join(', '))}"><table><thead><tr>${head.map((h) => `<th scope="col">${inline(h)}</th>`).join('')}</tr></thead>`
                + `<tbody>${rows.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
            continue;
        }
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) {
            flushPara(); flushList();
            const level = Math.min(6, h[1].length + headingOffset);
            out.push(`<h${level}>${inline(h[2])}</h${level}>`);
            continue;
        }
        const li = line.match(/^\s*(?:[-*]|(\d+)\.)\s+(.*)$/);
        if (li) {
            flushPara();
            const type = li[1] ? 'ol' : 'ul';
            if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
            list.items.push(li[2]);
            continue;
        }
        if (!line.trim()) { flushPara(); flushList(); continue; }
        if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
        flushList();
        para.push(line.trim());
    }
    if (fence) out.push(`<pre tabindex="0"><code>${esc(fence.join('\n'))}</code></pre>`);
    flushPara(); flushList();
    return out.join('\n');
}

module.exports = { markdown };
