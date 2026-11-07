'use strict';
/**
 * Codes' Markdown for the conversation kit (openvibe-shared/thread + ov-thread.js): one renderer, used by the server
 * to draw a turn and by the browser to draw the same turn again while the text streams in. Every character is escaped
 * first and the markup is added afterwards, so an agent's words can never become HTML.
 *
 * The markup is the kit's: an answer is .ovt-answer, a code block carries its language and a Copy button, a table
 * scrolls inside itself (thread.css) and a link is marked nofollow. Nothing here is styled: the kit draws it.
 *
 *   const md = require('../../public/js/md.js');   // on the server
 *   <script src="/js/md.js"></script>              // in the browser: window.CodesMarkdown
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CodesMarkdown = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
    // Only these may become a link; anything else stays words.
    const SAFE_URL = /^(https?:\/\/|mailto:|\/|#)/i;

    /** The inline markup of one line: code, links, bold, italic. The text is already escaped. */
    function inline(text) {
        const codes = [];
        let out = text.replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
        out = out.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (m, label, url) => (
            SAFE_URL.test(url) ? '<a href="' + url + '" rel="nofollow ugc noopener" target="_blank">' + label + '</a>' : m
        ));
        out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
        out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
        out = out.replace(/\u0000(\d+)\u0000/g, (m, i) => '<code>' + codes[Number(i)] + '</code>');
        return out;
    }

    const cells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    const isDivider = (line) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');

    /** One Markdown answer, as the kit's answer markup. */
    function markdown(source) {
        const lines = String(source == null ? '' : source).replace(/\r\n?/g, '\n').split('\n');
        const out = [];
        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            if (!line.trim()) { i++; continue; }
            // A fenced code block: its language, its text, and the Copy button the kit draws on it.
            const fence = /^\s*```\s*([A-Za-z0-9+#._-]*)\s*$/.exec(line);
            if (fence) {
                const lang = fence[1] || '';
                const body = [];
                i++;
                while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
                i++;
                const label = lang ? '<p class="ovt-code-lang"><span class="ovt-w-in">' + esc(lang) + '</span></p>' : '';
                out.push(label + '<pre><code' + (lang ? ' data-lang="' + esc(lang) + '" class="language-' + esc(lang) + '"' : '') + '>' + esc(body.join('\n')) +
                    '</code><button type="button" class="ovt-code-copy" data-ovt-code-copy hidden>Copy</button></pre>');
                continue;
            }
            const head = /^(#{1,6})\s+(.*)$/.exec(line);
            if (head) {
                const level = Math.min(6, head[1].length + 1);
                out.push('<h' + level + '>' + inline(esc(head[2])) + '</h' + level + '>');
                i++;
                continue;
            }
            if (/^\s*>\s?/.test(line)) {
                const body = [];
                while (i < lines.length && /^\s*>\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
                out.push('<blockquote><p>' + inline(esc(body.join(' '))) + '</p></blockquote>');
                continue;
            }
            const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
            if (item) {
                const ordered = /\d/.test(item[2]);
                const items = [];
                while (i < lines.length) {
                    const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
                    if (!m) break;
                    items.push('<li>' + inline(esc(m[3])) + '</li>');
                    i++;
                }
                const tag = ordered ? 'ol' : 'ul';
                out.push('<' + tag + '>' + items.join('') + '</' + tag + '>');
                continue;
            }
            if (line.includes('|') && i + 1 < lines.length && isDivider(lines[i + 1])) {
                const head2 = cells(line);
                i += 2;
                const body = [];
                while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { body.push(cells(lines[i])); i++; }
                out.push('<table><thead><tr>' + head2.map((h) => '<th>' + inline(esc(h)) + '</th>').join('') + '</tr></thead><tbody>' +
                    body.map((r) => '<tr>' + r.map((c) => '<td>' + inline(esc(c)) + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
                continue;
            }
            // A paragraph: until a blank line or the next kind of block.
            const para = [];
            while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i])
                && !/^\s*([-*+]|\d+[.)])\s/.test(lines[i]) && !/^\s*>\s?/.test(lines[i])
                && !(lines[i].includes('|') && i + 1 < lines.length && isDivider(lines[i + 1]))) {
                para.push(lines[i]);
                i++;
            }
            if (!para.length) { i++; continue; }
            out.push('<p>' + inline(esc(para.join('\n')).replace(/\n/g, '<br>')) + '</p>');
        }
        return out.join('');
    }

    // A tool's output: long output folds, and the fold says how much is in it. Never hidden without a count.
    const OUT_LIMIT = 4000;
    function outputLabel(output) {
        const text = String(output == null ? '' : output);
        const cut = text.length > OUT_LIMIT;
        const n = text.slice(0, OUT_LIMIT).split('\n').length;
        return 'Output (' + n + ' line' + (n === 1 ? '' : 's') + (cut ? ', cut' : '') + ')';
    }
    function outputBody(output) {
        const text = String(output == null ? '' : output);
        return '<pre class="ovt-w-out">' + esc(text.slice(0, OUT_LIMIT)) + '</pre>';
    }

    /**
     * The Copy button on a code block: the kit draws one on every answer's code, but it is drawn in the browser, so
     * the server's own button stays hidden until this shows it and gives it something to do.
     */
    function enhance(root) {
        if (!root || typeof document === 'undefined') return root;
        const list = root.querySelectorAll ? root.querySelectorAll('[data-ovt-code-copy]') : [];
        for (const b of list) {
            if (b.dataset.ovtReady) continue;
            b.dataset.ovtReady = '1';
            b.hidden = false;
            b.addEventListener('click', () => {
                const pre = b.closest('pre');
                const code = pre && pre.querySelector('code');
                const text = code ? code.textContent : '';
                if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => { /* a refused clipboard changes nothing */ });
            });
        }
        return root;
    }

    if (typeof document !== 'undefined') {
        const boot = () => enhance(document);
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
        else boot();
        document.addEventListener('ov:boost:load', boot);
    }

    return { markdown, escape: esc, clip, outputLabel, outputBody, enhance };
});
