'use strict';
(() => {
    document.querySelectorAll('.c4-tabs').forEach((tabs) => {
        const root = tabs.closest('.c4-task-detail');
        const links = Array.from(tabs.querySelectorAll('[data-c4-tab]'));
        const panels = Array.from(root.querySelectorAll('.c4-panel'));
        const activate = (id) => {
            links.forEach((link) => link.setAttribute('aria-selected', String(link.dataset.c4Tab === id)));
            panels.forEach((panel) => { panel.hidden = panel.id !== id; });
        };
        activate('live');
        links.forEach((link) => link.addEventListener('click', (event) => {
            event.preventDefault();
            activate(link.dataset.c4Tab);
            history.replaceState(null, '', link.getAttribute('href'));
        }));
    });

    document.querySelectorAll('[data-brief]').forEach((brief) => {
        const button = brief.parentElement.querySelector('.c4-brief-expand');
        if (!button) return;
        requestAnimationFrame(() => {
            if (brief.scrollHeight > brief.clientHeight + 1) button.hidden = false;
        });
        button.addEventListener('click', () => {
            const expanded = brief.classList.toggle('is-expanded');
            button.textContent = expanded ? 'Show less' : 'Show the whole brief';
        });
    });

    document.querySelectorAll('.c4-progress-toggle').forEach((button) => {
        const content = document.getElementById(button.getAttribute('aria-controls'));
        button.addEventListener('click', () => {
            const open = button.getAttribute('aria-expanded') !== 'true';
            button.setAttribute('aria-expanded', String(open));
            content.classList.toggle('is-open', open);
        });
    });

    document.querySelectorAll('[data-c4-stream]').forEach((root) => {
        if (!window.EventSource || root.dataset.live !== 'true') return;
        const out = root.querySelector('.c4-log');
        const title = document.querySelector('[data-progress-title]');
        const stepsNode = document.querySelector('[data-progress-steps]');
        const timeNode = document.querySelector('[data-progress-time]');
        const taskStarted = Number(root.dataset.startedAt);
        const started = Number.isFinite(taskStarted) && taskStarted > 0 ? taskStarted : Date.now();
        let steps = 0;
        const updateTime = () => {
            if (!timeNode) return;
            const mins = Math.max(0, Math.floor((Date.now() - started) / 60000));
            timeNode.textContent = mins >= 60 ? String(Math.floor(mins / 60)) + 'h ' + String(mins % 60) + 'm' : mins ? String(mins) + ' min' : 'now';
        };
        updateTime();
        const timer = window.setInterval(updateTime, 30000);
        const stream = new EventSource(root.dataset.c4Stream);
        const appendOutput = (event) => {
            let payload = event.data;
            try {
                const parsed = JSON.parse(payload);
                payload = parsed.chunk || parsed.text || parsed.message || parsed.output || payload;
            } catch { /* plain output */ }
            String(payload).split(/\r?\n/).filter(Boolean).forEach((rawLine) => {
                let line = rawLine;
                try {
                    const parsed = JSON.parse(line);
                    line = parsed.text || parsed.message || parsed.command || parsed.type || line;
                } catch { /* human-readable output */ }
                if (out) out.textContent += line + '\n';
                steps += 1;
                if (stepsNode) stepsNode.textContent = String(steps) + (steps === 1 ? ' step' : ' steps');
                if (title && line.trim()) title.textContent = line.trim().split(/\s+/).slice(0, 12).join(' ');
            });
        };
        stream.addEventListener('message', appendOutput);
        stream.addEventListener('output', appendOutput);
        stream.addEventListener('end', () => { stream.close(); window.clearInterval(timer); if (title) title.textContent = 'Task finished'; });
        stream.addEventListener('error', () => {
            if (stream.readyState === EventSource.CLOSED) { stream.close(); window.clearInterval(timer); }
        });
    });
})();
