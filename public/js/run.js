/*
 * Run on your machine (server/http/run.js): the live lines of a running task and the colours of a finished patch.
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
        var source = new EventSource(section.getAttribute('data-events'));
        source.addEventListener('output', function (e) {
            var doc;
            try { doc = JSON.parse(e.data); } catch (err) { return; }
            buffer += doc.chunk || '';
            var parts = buffer.split('\n');
            buffer = parts.pop();
            parts.forEach(function (raw) {
                if (!raw.trim()) return;
                try { show(log, JSON.parse(raw)); } catch (err) { line(log, 'tool', raw); }
            });
        });
        source.addEventListener('state', function (e) {
            try {
                var s = JSON.parse(e.data).state;
                if (pill && LABEL[s]) { pill.textContent = LABEL[s]; pill.className = 'run-pill run-pill-' + s; }
            } catch (err) { /* ignore */ }
        });
        source.addEventListener('end', function () {
            source.close();
            setTimeout(function () { window.location.reload(); }, 800);
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

    document.querySelectorAll('[data-events]').forEach(follow);
    document.querySelectorAll('[data-patch]').forEach(colour);
})();
