/*
 * Run on your machine (server/http/run.js): the live lines of a running task and the colours of a finished patch.
 * With openvibe-shared/agent-session.js on the page (the task page loads it), the lines become the agents' session:
 * steps grouped, each step's command, change and output (live), helpers, hand-offs and the plan; a finished task's
 * page shows the session its result kept. Without it, the plain list below.
 * The lines come from the task's own event stream (/run/tasks/:id/events, Run's job stream through Codes): `output`
 * events carry the job's stdout, one JSON object per line (harness/job.js), `state` the job's state, `end` its end.
 * Everything is put on the page as text, never as HTML.
 */
(function () {
    'use strict';
    var LABEL = {
        queued: 'Waiting for your machine', placed: 'Sent to your machine', running: 'Running', succeeded: 'Finished',
        failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired (no machine took it in time)',
    };

    function line(log, cls, text) {
        var li = document.createElement('li');
        li.className = cls;
        li.textContent = text;
        log.appendChild(li);
        log.scrollTop = log.scrollHeight;
    }

    function show(log, doc) {
        switch (doc.t) {
        case 'step': return line(log, 'step', '· ' + doc.text);
        case 'agent': return line(log, 'agent', '▶ ' + doc.agent + (doc.model ? ' (' + doc.model + ')' : ''));
        case 'handoff': return line(log, 'handoff', '⇢ handing over from ' + doc.from + ': ' + doc.reason);
        case 'text': return line(log, 'text', doc.text);
        case 'tool': return line(log, 'tool', '  → ' + doc.name + (doc.what ? ' ' + doc.what : ''));
        case 'note': return line(log, 'note', '! ' + doc.text);
        case 'done': return line(log, doc.ok ? 'step' : 'note', (doc.ok ? '✔ done' : '✗ ' + (doc.text || 'not done')) + ' (' + Math.round((doc.duration_ms || 0) / 1000) + ' s)');
        default: return undefined;
        }
    }

    function follow(section) {
        var log = section.querySelector('[data-log]');
        var pill = document.querySelector('[data-state]');
        var buffer = '';
        if (!log || !window.EventSource) return;
        var view = null;
        if (window.OpenVibeAgentSession) {
            var host = document.createElement('div');
            log.parentNode.replaceChild(host, log);
            view = window.OpenVibeAgentSession.mount(host, { title: section.getAttribute('data-title') || 'Task', status: 'queued', empty: 'Waiting for your machine to take the task…' });
            log = null;
        }
        var source = new EventSource(section.getAttribute('data-events'));
        source.addEventListener('output', function (e) {
            var doc;
            try { doc = JSON.parse(e.data); } catch (err) { return; }
            buffer += doc.chunk || '';
            var parts = buffer.split('\n');
            buffer = parts.pop();
            parts.forEach(function (raw) {
                if (!raw.trim()) return;
                var doc;
                try { doc = JSON.parse(raw); } catch (err) { doc = null; }
                if (view) { if (doc) view.push(doc); return; }
                if (doc) show(log, doc); else line(log, 'tool', raw);
            });
        });
        source.addEventListener('state', function (e) {
            try {
                var s = JSON.parse(e.data).state;
                if (LABEL[s]) lastState = s;
                if (pill && LABEL[s]) { pill.textContent = LABEL[s]; pill.className = 'run-pill run-pill-' + s; }
                if (view) view.status(s, LABEL[s]);
            } catch (err) { /* ignore */ }
        });
        var lastState = section.getAttribute('data-state') || 'queued';
        source.addEventListener('end', function () {
            source.close();
            // Switch from live streaming to replay without a full reload: the session lines are read back from
            // /run/tasks/:id/session.json and pushed into the same agent-session view.
            if (view && window.fetch) {
                var sessionUrl = section.getAttribute('data-events').replace('/events', '/session.json') + '?after=0';
                fetch(sessionUrl, { credentials: 'same-origin' })
                    .then(function (r) { return r.json(); })
                    .then(function (data) {
                        if (!data || !Array.isArray(data.lines)) return;
                        view.pushAll(data.lines.map(function (l) { return l.body; }));
                        view.status(lastState, LABEL[lastState] || lastState);
                    })
                    .catch(function () { /* leave the streamed lines as they are */ });
            }
        });
        source.onerror = function () {
            // The stream ended or could not open (Run busy or down): the page itself shows where the task is, so it is
            // reloaded, not too often while the stream stays away.
            if (source.readyState === 2) setTimeout(function () { window.location.reload(); }, 15000);
        };
    }

    function colour(pre) {
        var lines = pre.textContent.split('\n');
        pre.textContent = '';
        lines.forEach(function (text, i) {
            var span = document.createElement('span');
            if (/^\+(?!\+\+)/.test(text)) span.className = 'add';
            else if (/^-(?!--)/.test(text)) span.className = 'del';
            else if (/^@@/.test(text)) span.className = 'hunk';
            span.textContent = text + (i < lines.length - 1 ? '\n' : '');
            pre.appendChild(span);
        });
    }

    /** A finished task: the session its result kept (lines 1.1), read whole. */
    function replay(section) {
        var data = section.querySelector('[data-session-log]');
        var into = section.querySelector('[data-session-view]');
        if (!data || !into || !window.OpenVibeAgentSession) { section.hidden = true; return; }
        var lines;
        try { lines = JSON.parse(data.textContent); } catch (err) { section.hidden = true; return; }
        var state = section.getAttribute('data-state');
        var view = window.OpenVibeAgentSession.mount(into, { title: section.getAttribute('data-title') || 'Task', status: 'running', follow: false });
        view.pushAll(lines);
        view.status(state, LABEL[state]);
    }

    document.querySelectorAll('[data-events]').forEach(follow);
    document.querySelectorAll('[data-session]').forEach(replay);
    document.querySelectorAll('[data-patch]').forEach(colour);
})();
