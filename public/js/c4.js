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
        const detail = root.closest('[data-task-api]');
        const out = root.querySelector('[data-task-log]');
        const attemptsNode = root.querySelector('[data-c4-attempts]');
        const label = root.querySelector('[data-live-label]');
        const attemptRows = new Map();
        attemptsNode?.querySelectorAll('[data-attempt-n]').forEach((item) => attemptRows.set(Number(item.dataset.attemptN), item));
        const showAttempt = (attempt) => {
            const number = attempt && (attempt.n ?? attempt.attempt_n);
            if (!number || !attemptsNode) return;
            const key = Number(number);
            let item = attemptRows.get(key);
            if (!item) {
                item = document.createElement('li');
                item.className = 'c4-attempt';
                attemptRows.set(key, item);
                attemptsNode.append(item);
            }
            item.textContent = `Attempt ${key} · ${attempt.agent || 'Auto'} · ${attempt.end_why || attempt.state || 'Queued'}`;
        };
        const updateOutcome = (task) => {
            if (!detail || !task) return;
            const outcome = task.outcome || {};
            const unfinished = outcome.state === 'unfinished' || (task.error && !['succeeded', 'cancelled'].includes(task.state));
            let panel = detail.querySelector('[data-c4-outcome]');
            if (unfinished && !panel) {
                // Server markup provides the no-JS state; this branch covers an outcome reached during the stream.
                panel = document.createElement('div');
                panel.className = 'c4-outcome';
                panel.dataset.c4Outcome = '';
                panel.innerHTML = '<span class="c4-obadge" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m18 6-12 12M6 6l12 12"/></svg></span><div class="c4-outcome-copy"><b>Didn’t finish</b><span data-outcome-reason></span></div>';
                const actions = document.createElement('div');
                actions.className = 'c4-outcome-actions';
                const addPill = (labelText, href, primary, path) => {
                    const link = document.createElement('a');
                    link.className = `c4-opill${primary ? ' c4-opill-primary' : ''}`;
                    link.href = href;
                    link.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
                    const text = document.createElement('span');
                    text.textContent = labelText;
                    link.append(text);
                    actions.append(link);
                };
                addPill('Retry', detail.dataset.retryUrl, true, 'M20 7v5h-5M4 17v-5h5M5.6 9a7 7 0 0 1 11.7-2L20 12M4 12l2.7 5a7 7 0 0 0 11.7-2');
                addPill('Switch', detail.dataset.switchUrl, false, 'm16 3 4 4-4 4M4 7h16M8 21l-4-4 4-4m12 4H4');
                addPill('Fine', '/tasks', false, 'm5 12 4 4L19 6');
                panel.append(actions);
                detail.prepend(panel);
            }
            if (panel) {
                panel.hidden = !unfinished;
                const reason = panel.querySelector('[data-outcome-reason]');
                if (reason) reason.textContent = outcome.note || task.error || 'The task stopped before it was complete.';
            }
            const chip = detail.querySelector('.c4-task-heading > .c4-status');
            if (chip) chip.textContent = task.state || 'Unknown';
            if (label) label.textContent = ['succeeded', 'failed', 'cancelled', 'expired'].includes(task.state) ? 'This task has finished.' : 'Connecting to the live task…';
        };
        if (detail) fetch(detail.dataset.taskApi, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
            .then((response) => response.ok ? response.json() : null)
            .then((task) => {
                if (!task) return;
                (task.attempts || []).forEach(showAttempt);
                updateOutcome(task);
            }).catch(() => {});
        if (!window.EventSource) return;
        const outText = (line) => {
            const body = line && line.body;
            if (typeof body === 'string') return body;
            if (body && typeof body === 'object') return body.text || body.message || body.command || body.output || JSON.stringify(body);
            return String(body ?? '');
        };
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
        const stream = new EventSource(root.dataset.c4Stream, { withCredentials: true });
        stream.addEventListener('line', (event) => {
            let line;
            try { line = JSON.parse(event.data); } catch { return; }
            const text = outText(line).trim();
            if (!text || !out) return;
            out.hidden = false;
            out.textContent += text + '\n';
            steps += 1;
            if (stepsNode) stepsNode.textContent = String(steps) + (steps === 1 ? ' step' : ' steps');
            if (title) title.textContent = text.split(/\s+/).slice(0, 12).join(' ');
        });
        stream.addEventListener('attempt', (event) => {
            try { showAttempt(JSON.parse(event.data)); } catch { /* ignore malformed event */ }
        });
        stream.addEventListener('end', () => { stream.close(); window.clearInterval(timer); if (title) title.textContent = 'Task finished'; });
        stream.addEventListener('error', () => {
            if (stream.readyState === EventSource.CLOSED) { stream.close(); window.clearInterval(timer); }
        });
    });
})();
