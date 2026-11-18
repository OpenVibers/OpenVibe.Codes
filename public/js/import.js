// OpenVibe.Codes — Bring a session here (/import). Without JavaScript the page still works: the message and the
// commands are selectable, the link is made by a form post, and the file input is a plain one. This adds the copy
// buttons and the drop: a session file is sent as it is, except a big Claude Code file, which is read from its last
// compaction so only the part a resume needs leaves the computer (a 4 GB file sends a few MB).
(function () {
    'use strict';

    document.querySelectorAll('[data-imp-copy]').forEach(function (btn) {
        var target = document.querySelector(btn.getAttribute('data-imp-copy'));
        if (!target || !navigator.clipboard) return;
        btn.hidden = false;
        var label = btn.innerHTML;
        btn.addEventListener('click', function () {
            navigator.clipboard.writeText(target.value || target.textContent || '').then(function () {
                btn.textContent = 'Copied';
                setTimeout(function () { btn.innerHTML = label; }, 1600);
            }, function () { if (target.select) target.select(); });
        });
    });

    var drop = document.querySelector('[data-imp-drop]');
    if (!drop) return;
    var input = drop.querySelector('input[type=file]');
    var status = drop.querySelector('[data-imp-status]');
    var CHUNK = 8 * 1024 * 1024;
    var NEEDLE = new TextEncoder().encode('"compact_boundary"');
    var MAX_SEND = 40 * 1024 * 1024;

    function say(text, href) {
        status.textContent = text;
        if (href) {
            var a = document.createElement('a');
            a.href = href;
            a.textContent = ' Continue it';
            status.appendChild(a);
        }
    }

    function lastIndexOfBytes(hay, needle, from) {
        outer: for (var i = Math.min(from, hay.length - needle.length); i >= 0; i--) {
            for (var j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
            return i;
        }
        return -1;
    }

    /** The byte offset of the last compaction boundary's line in a Claude Code file, or -1. */
    async function lastBoundary(file) {
        var end = file.size;
        while (end > 0) {
            var start = Math.max(0, end - CHUNK);
            var bytes = new Uint8Array(await file.slice(start, Math.min(file.size, end + 1024 * 1024)).arrayBuffer());
            var at = bytes.length;
            while ((at = lastIndexOfBytes(bytes, NEEDLE, at - 1)) >= 0) {
                var lineStart = at;
                while (lineStart > 0 && bytes[lineStart - 1] !== 10) lineStart--;
                if (lineStart === 0 && start > 0) break;                  // the line began in the window before
                var lineEnd = at;
                while (lineEnd < bytes.length && bytes[lineEnd] !== 10) lineEnd++;
                try {
                    var r = JSON.parse(new TextDecoder().decode(bytes.subarray(lineStart, lineEnd)));
                    if (r && r.type === 'system' && r.subtype === 'compact_boundary') return start + lineStart;
                } catch (e) { /* only mentions the word */ }
                at = lineStart;
            }
            // The next window ends where this one began; it reads 1 MB past its end, so a line across the edge is whole.
            end = start;
        }
        return -1;
    }

    async function gzip(blob) {
        if (typeof CompressionStream === 'undefined') return blob;
        return new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
    }

    async function send(file) {
        drop.classList.add('is-busy');
        try {
            var part = file;
            if (/\.jsonl$/i.test(file.name) && file.size > CHUNK) {
                say('Finding where the session was last compacted…');
                var head = await file.slice(0, 64 * 1024).text();
                if (/"sessionId"/.test(head) && /"uuid"/.test(head)) {
                    var at = await lastBoundary(file);
                    if (at > 0) part = file.slice(at);
                    else if (file.size > 200 * 1024 * 1024) { say('This session was never compacted and is too big to carry: run /compact in it first, then drop it again.'); return; }
                }
            }
            say('Packing ' + Math.max(1, Math.round(part.size / 1048576)) + ' MB…');
            var body = await gzip(part);
            if (body.size > MAX_SEND) { say('Even packed, this is over 40 MB. Compact the session first (/compact), or use the command above.'); return; }
            say('Sending…');
            var res = await fetch('/api/v1/sessions/imports', {
                method: 'POST', credentials: 'same-origin', body: body,
                headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json', 'X-OV-Filename': file.name.replace(/[^A-Za-z0-9._ -]/g, '').slice(0, 120) },
            });
            var json = await res.json().catch(function () { return null; });
            if (!res.ok) { say((json && (json.detail || json.title)) || 'That file could not be imported.'); return; }
            say('Imported "' + json.import.title + '".', json.continue_url || ('/conductor?import=' + json.import.id));
            setTimeout(function () { window.location.reload(); }, 2500);
        } catch (e) {
            say('That did not work: ' + (e && e.message ? e.message : e));
        } finally {
            drop.classList.remove('is-busy');
            input.value = '';
        }
    }

    input.addEventListener('change', function () { if (input.files && input.files[0]) send(input.files[0]); });
    ['dragenter', 'dragover'].forEach(function (t) {
        drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
        drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('is-over'); });
    });
    drop.addEventListener('drop', function (e) {
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) send(f);
    });
})();
