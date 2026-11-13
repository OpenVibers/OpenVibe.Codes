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
        const chosen = links.find((link) => link.getAttribute('aria-selected') === 'true');
        activate(chosen ? chosen.dataset.c4Tab : 'live');
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
            // The words the page uses, not Run's own state id.
            if (chip) chip.textContent = ({ running: 'Running', queued: 'Queued', placed: 'On its way', done: 'Done', succeeded: 'Done', failed: "Didn't finish", cancelled: 'Stopped by you', expired: 'Expired' })[task.state] || task.state || 'Unknown';
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
    // The conductor's start form: the folders this machine has worked in, and a model picked from the ones the plan
    // login offers (Other… opens a field for one). Both work without this script — the pick has its own name and the
    // server reads it — this only makes them visible and keeps the two in step.
    document.querySelectorAll('form[action="/conductor"]').forEach((form) => {
        const machine = form.querySelector('[data-c4-machine]');
        const pick = form.querySelector('[data-c4-folder-pick]');
        const folder = form.querySelector('#c4-folder');
        if (pick) {
            const options = Array.from(pick.options);
            const filter = () => {
                const want = machine ? machine.value : '';
                const at = pick.selectedIndex;
                options.forEach((o, i) => {
                    if (i === 0) return;                       // "A recent folder…"
                    const forMachine = (o.getAttribute('data-machine') || '');
                    o.hidden = !!want && !!forMachine && forMachine !== want;
                });
                if (at > 0 && pick.options[at].hidden) { pick.selectedIndex = 0; if (folder) folder.value = ''; }
                else pick.selectedIndex = at;
            };
            filter();
            if (machine) machine.addEventListener('change', filter);
            pick.addEventListener('change', () => { if (pick.value && folder) folder.value = pick.value; });
        }
        const model = form.querySelector('[data-c4-model]');
        const other = form.querySelector('[data-c4-model-other]');
        const otherInput = other && other.querySelector('input');
        if (model && other && otherInput) {
            const toggle = () => {
                const custom = model.value === 'other';
                other.hidden = !custom;
                if (custom) otherInput.focus();
            };
            toggle();
            model.addEventListener('change', toggle);
        }
    });
    // The conductor shares the upload picker; files use the existing multipart message route.
    document.querySelectorAll('[data-c4-conductor-form]').forEach((form) => {
        const status = form.querySelector('[data-c4-message-status]');
        const root = form.querySelector('[data-c4-upload]');
        const meterRoot = form.querySelector('[data-c4-upload-progress]');
        if (!root || !window.OVUpload) return;
        const files = [];
        const meter = OVUpload.progress(meterRoot, { onRetry: () => form.requestSubmit() });
        const say = (message, bad) => { if (status) { status.textContent = message; status.classList.toggle('is-bad', !!bad); } };
        const blocked = /\.(exe|dll|com|bat|cmd|msi|scr|ps1|sh|so|dylib|app|apk|deb|rpm|jar|bin|elf|vbs|wsf|hta)$/i;
        const picker = OVUpload.picker(root, {
            label: 'Attach files', multiple: true,
            onFile: (file, row) => {
                const total = files.reduce((n, item) => n + item.size, 0);
                const problem = blocked.test(file.name) ? 'Programs cannot be attached.'
                    : !file.size ? 'Choose a file that is not empty.'
                    : file.size > 20 * 1048576 ? `${file.name} is over 20 MB.`
                    : files.length >= 10 ? 'Choose at most 10 files.'
                    : total + file.size > 50 * 1048576 ? 'The files are over 50 MB together.' : '';
                if (problem) { row.dispatchEvent(new Event('remove')); row.remove(); say(problem, true); return; }
                files.push(file); say(`${files.length} file${files.length === 1 ? '' : 's'} selected`);
            },
            onRemove: (file) => { const i = files.indexOf(file); if (i >= 0) files.splice(i, 1); say(files.length ? `${files.length} files selected` : ''); }
        });
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const button = form.querySelector('button[type="submit"]');
            if (button) button.disabled = true;
            say('Sending…');
            if (files.length) {
                const data = new FormData(form);
                files.forEach((file) => data.append('files', file, file.name));
                const xhr = new XMLHttpRequest();
                xhr.open('POST', form.action);
                xhr.withCredentials = true;
                const total = files.reduce((n, file) => n + file.size, 0);
                meter.update({ state: 'sending', done: 0, total });
                xhr.upload.onprogress = (e) => { if (e.lengthComputable) meter.update({ state: 'sending', done: Math.min(total, e.loaded), total }); };
                xhr.onload = () => {
                    if (xhr.status >= 200 && xhr.status < 400) { meter.update({ state: 'done', done: total, total }); location.href = xhr.responseURL || form.action; return; }
                    const message = 'The files could not be sent. Check their formats and try again.';
                    meter.update({ state: 'failed', message }); say(message, true); if (button) button.disabled = false;
                };
                xhr.onerror = () => { const message = 'The connection stopped. Try again.'; meter.update({ state: 'failed', message }); say(message, true); if (button) button.disabled = false; };
                xhr.send(data);
                return;
            }
            try {
                const text = (form.querySelector('textarea[name="text"]') || {}).value || '';
                const res = await fetch(form.dataset.conductorApi, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    credentials: 'same-origin', body: JSON.stringify({ text, attachments: [], who: (form.querySelector('select[name="who"]') || {}).value || undefined }),
                });
                const doc = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(doc.detail || `the message was refused (${res.status})`);
                window.location.reload();
            } catch (e) { say(String((e && e.message) || 'the message could not be sent'), true); if (button) button.disabled = false; }
        });
    });

    document.querySelectorAll('[data-c4-conductor]').forEach((root) => {
        const out = root.querySelector('[data-task-log]');
        const label = root.querySelector('[data-live-label]');
        const live = root.dataset.c4Conductor === 'live';
        const url = root.dataset.c4ConductorStream;
        const taskId = root.dataset.task;
        if (taskId && window.OpenVibeAgentSession && window.EventSource) {
            const runUrl = '/api/v1/runs/' + encodeURIComponent(taskId);
            fetch(runUrl, { credentials: 'same-origin' }).then((r) => r.ok ? r.json() : null).then((run) => {
                if (!run || !root.isConnected) return;
                const host = document.createElement('div');
                root.appendChild(host);
                if (out) out.hidden = true;
                if (label) label.hidden = true;
                const form = document.querySelector('[data-c4-conductor-form]');
                if (form) form.hidden = true;
                const view = window.OpenVibeAgentSession.mount(host, {
                    title: run.title || 'Conductor', status: run.status || 'running', follow: live, files: false,
                    onSend: (text) => fetch('/api/v1/conductor/' + encodeURIComponent(taskId) + '/messages', {
                        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text })
                    }).then((r) => { if (!r.ok) throw new Error('The message could not be sent.'); window.location.reload(); })
                });
                const stream = new EventSource(runUrl + '/events');
                ['RUN_STARTED', 'RUN_FINISHED', 'RUN_ERROR', 'STEP_STARTED', 'STEP_FINISHED', 'TEXT_MESSAGE_START',
                    'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END',
                    'TOOL_CALL_RESULT', 'REASONING_START', 'REASONING_MESSAGE_START', 'REASONING_MESSAGE_CONTENT',
                    'REASONING_MESSAGE_END', 'REASONING_END', 'REASONING_ENCRYPTED_VALUE', 'STATE_SNAPSHOT', 'STATE_DELTA',
                    'ACTIVITY_SNAPSHOT', 'ACTIVITY_DELTA', 'CUSTOM'].forEach((type) => stream.addEventListener(type, (e) => {
                    try { view.push(JSON.parse(e.data)); } catch { /* ignore one invalid event */ }
                    if (type === 'RUN_FINISHED' || type === 'RUN_ERROR') stream.close();
                }));
                window.addEventListener('pagehide', () => stream.close(), { once: true });
            }).catch(() => { /* the plain transcript and composer remain */ });
        }
        if (!live || !window.EventSource || !url) return;   // between turns the lines are drawn on the server
        const stream = new EventSource(url);
        const textOf = (line) => {
            const b = line && line.body;
            if (typeof b === 'string') return b;
            if (!b || typeof b !== 'object') return String(b ?? '');
            if (b.t === 'tool') return `calls ${b.name || ''} ${String((b.input && (b.input.command || b.input.file_path)) || b.what || '')}`.trim();
            if (b.t === 'tool_result') return `  ${b.ok === false ? '✗' : '·'} ${String(b.output || '').split('\n')[0]}`;
            return b.text || b.message || '';
        };
        stream.addEventListener('line', (event) => {
            let line;
            try { line = JSON.parse(event.data); } catch { return; }
            const text = textOf(line).trim();
            if (!text || !out) return;
            out.textContent += `${text}\n`;
            out.scrollTop = out.scrollHeight;
            if (label) label.textContent = 'Working…';
        });
        let reloaded = false;
        stream.addEventListener('error', () => {
            // The server ends the stream when the turn ends. Reload once so the turn's answer and the box are fresh —
            // but not twice in five seconds, so a conductor that ends at once cannot make the page reload in a loop.
            if (reloaded || !live || stream.readyState === EventSource.CLOSED) return;
            const key = `c4-conductor-reload:${root.dataset.task || ''}`;
            let last = 0;
            try { last = Number(window.sessionStorage.getItem(key) || 0); } catch { last = 0; }
            if (Date.now() - last < 5000) return;
            try { window.sessionStorage.setItem(key, String(Date.now())); } catch { /* storage may be off */ }
            reloaded = true;
            stream.close();
            window.setTimeout(() => window.location.reload(), 1200);
        });
        stream.addEventListener('end', () => { if (label) label.textContent = 'The turn ended.'; });
    });
    // The repository field is a plain input: a full Git address always works, and the shared dropdown
    // (data-ov-combo, openvibe-shared 4.202.0) enhances its search when it ships.
})();
