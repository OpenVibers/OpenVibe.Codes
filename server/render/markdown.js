'use strict';

/**
 * A deliberately small Markdown renderer for the ADRs shipped inside openvibe-contracts (the policy
 * pages render them verbatim, so the policy cannot drift from the decision record). Everything is
 * escaped first; only headings, paragraphs, lists, fenced code, bold, inline code and links are
 * recognised. Links are kept only when http(s) or relative.
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

function markdown(src, { headingOffset = 1 } = {}) {
    const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let para = [];
    let list = null;   // { type: 'ul' | 'ol', items: [] }
    let fence = null;
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`); list = null; } };
    for (const line of lines) {
        if (fence) {
            if (/^```/.test(line)) { out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`); fence = null; } else fence.push(line);
            continue;
        }
        if (/^```/.test(line)) { flushPara(); flushList(); fence = []; continue; }
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
    if (fence) out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
    flushPara(); flushList();
    return out.join('\n');
}

module.exports = { markdown };
