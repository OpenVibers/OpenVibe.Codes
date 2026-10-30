'use strict';
(() => {
    document.querySelectorAll('[data-c4-stream]').forEach((root) => {
        if (!window.EventSource) return;
        const out = root.querySelector('.c4-log');
        const stream = new EventSource(root.dataset.c4Stream);
        stream.addEventListener('message', (event) => {
            if (!out) return;
            let line = event.data;
            try { const parsed = JSON.parse(line); line = parsed.text || parsed.message || parsed.type || line; } catch { /* plain output */ }
            out.textContent += `${line}\n`;
            out.scrollTop = out.scrollHeight;
        });
        stream.addEventListener('end', () => stream.close());
        stream.addEventListener('error', () => { if (stream.readyState === EventSource.CLOSED) stream.close(); });
    });
})();
