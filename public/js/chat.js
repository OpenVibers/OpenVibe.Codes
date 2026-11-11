'use strict';
// Codes' own parts of the chat app (plan L31 CH1). The conversation UI is the network's (openvibe-shared/thread, plan
// L55 C4): ov-thread.js grows the composer, sends on Enter, filters the rail, opens the panel on a narrow screen, adds
// Copy and keeps the thread at the bottom; kit-web.js opens the rail on a phone. The page works without either. Here:
// - a new chat's three ways to start, the ideas rail, the projects picked from the words and the repository search;
// - a composer's files go up through the attachments API first (chips with a thumbnail, progress and a ×), then the
//   message names their ids; without JavaScript the same form posts the files as multipart;
// - paste and drop add files, as choosing them does;
// - a running turn streams into the thread (OVThread.tool / toolDone / live), and the page renders the finished turn
//   when the attempt ends.
//
// Codes moves between pages with openvibe-shared/boost, which swaps the page in place without running this file
// again: each page is set up on its first load and on every ov:boost:load, and a live stream is closed when the page
// moves away.
(() => {
    const $ = (sel, root = document) => root.querySelector(sel);
    let page = null;   // { app, es } for the page on screen
    document.addEventListener('ov:boost:before', () => { if (page && page.es) page.es.close(); page = null; });
    document.addEventListener('ov:boost:load', init);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

    // ── A new chat: the three ways to start, and the ideas rail ──
    // The cards are radio buttons of the composer's form (CSS shows each one's pickers); here a card also swaps the
    // placeholder and the rail's ideas, and an idea fills the box and picks the card it belongs to.
    function startPage(app, form, text) {
        const grow = () => text.dispatchEvent(new Event('input', { bubbles: true }));
        const rail = $('[data-ch-ideas]', app);
        const track = rail && $('[data-ch-ideas-track]', rail);
        // The kind is a group of radios (11-07); an idea picks its own.
        const setKind = (v) => { const r = app.querySelector(`[data-ch-kind][value="${v}"]`); if (r) r.checked = true; };
        const modes = Array.from(app.querySelectorAll('[data-ch-mode]'));
        let sets = {};
        try { sets = rail ? JSON.parse(rail.dataset.chIdeasets || '{}') : {}; } catch { sets = {}; }
        const PLACEHOLDER = { new: 'Describe your website, game or app', openvibe: 'Describe the change, question or fix', code: 'Describe the change, question or fix' };
        const ICON = (i) => (i.kind === 'game' ? 'game' : i.kind === 'app' ? 'app' : i.kind === 'website' ? 'web' : i.kind === 'overlay' ? 'spark' : i.mode === 'openvibe' ? 'ov' : 'spark');
        // The rail's speed follows its length: about 32 px a second, whatever the ideas.
        const pace = () => { if (track) track.style.setProperty('--ch-drift', `${Math.max(30, Math.round(track.scrollWidth / 2 / 32))}s`); };
        function card(i, copy) {
            const li = document.createElement('li');
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'ch-idea';
            if (copy) b.tabIndex = -1;
            b.dataset.chIdea = i.text; b.dataset.chIdeaMode = i.mode;
            if (i.kind) b.dataset.chIdeaKind = i.kind;
            const svg = icons.get(ICON(i));
            if (svg) { const c = svg.cloneNode(true); c.removeAttribute('data-icon'); b.appendChild(c); }
            const span = document.createElement('span'); span.textContent = i.text; b.appendChild(span);
            li.appendChild(b);
            return li;
        }
        // The icons come from the page (a <template> of the rail's five); this script draws none of its own.
        const icons = new Map();
        const tpl = rail && $('template[data-ch-idea-icons]', rail);
        if (tpl) tpl.content.querySelectorAll('svg[data-icon]').forEach((svg) => icons.set(svg.dataset.icon, svg));
        function fill(mode) {
            if (!track || !sets[mode]) return;
            const swap = () => {
                const lists = track.querySelectorAll('.ch-spark-list');
                lists.forEach((ul, n) => { ul.textContent = ''; sets[mode].forEach((i) => ul.appendChild(card(i, n > 0))); });
                pace();
            };
            // The ideas cross-fade to the new mode's set (a first fill, before anything shows, swaps at once).
            if (!track.childElementCount || !track.querySelector('.ch-idea')) return swap();
            track.classList.add('is-swapping');
            setTimeout(() => { swap(); requestAnimationFrame(() => track.classList.remove('is-swapping')); }, 180);
        }
        // A touch screen keeps its keyboard down until the box is tapped (11-09, the owner: picking a mode "puts up the
        // keyboard automatically… takes up a lot of space… overrides everything").
        const fine = !matchMedia('(pointer: coarse)').matches;
        function choose(mode, { focus = false } = {}) {
            const radio = modes.find((r) => r.value === mode);
            if (radio && !radio.checked) radio.checked = true;
            if (text && PLACEHOLDER[mode]) text.placeholder = PLACEHOLDER[mode];
            // The box's placeholder walks through this mode's ideas (ov-thread.js reads data-ovt-examples).
            if (text && sets[mode]) text.setAttribute('data-ovt-examples', JSON.stringify(sets[mode].slice(0, 12).map((i) => i.text)));
            if (rail && rail.dataset.chShown !== mode) { rail.dataset.chShown = mode; fill(mode); }
            if (form) form.dispatchEvent(new Event('ovt:options'));
            if (focus && text && fine) text.focus();
        }
        modes.forEach((r) => r.addEventListener('change', () => { if (r.checked) { choose(r.value, { focus: true }); pick(); glide(); } }));
        // One highlight slides to the picked mode (it follows the label's box, so a resize or a font change moves it too).
        const group = modes.length ? modes[0].closest('.ch-modes') : null;
        function glide(first) {
            if (!group) return;
            const on = modes.find((r) => r.checked); const lab = on && on.closest('.ch-mode');
            if (!lab) return;
            if (first) group.classList.add('is-placing');
            group.style.setProperty('--ch-glide-x', `${lab.offsetLeft}px`);
            group.style.setProperty('--ch-glide-w', `${lab.offsetWidth}px`);
            group.classList.add('has-glide');
            if (first) requestAnimationFrame(() => requestAnimationFrame(() => group.classList.remove('is-placing')));
        }
        if (group) {
            glide(true);
            if (typeof ResizeObserver === 'function') new ResizeObserver(() => glide(true)).observe(group);
            if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => glide(true)).catch(() => {});
        }

        // An OpenVibe site, picked from the words: the line under the bar says which projects Codes will work on, as
        // the person types (GET /chat/match; the server decides again when the message is sent).
        const picked = $('[data-ch-picked]', form);
        const pickedText = picked && $('[data-ch-picked-text]', picked);
        const projectSel = $('[data-ch-project]', form);
        const DEFAULT_PICK = pickedText ? pickedText.textContent : '';
        let pickTimer = 0, pickSeq = 0;
        const list = (names) => (names.length < 2 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
        const say = (parts) => { if (!pickedText) return; pickedText.textContent = ''; parts.forEach((p) => pickedText.append(typeof p === 'string' ? document.createTextNode(p) : p)); };
        const bold = (t) => { const b = document.createElement('b'); b.textContent = t; return b; };
        function pick() {
            if (!picked || !projectSel) return;
            const mode = (modes.find((r) => r.checked) || {}).value;
            if (mode !== 'openvibe') return;
            if (projectSel.value !== 'auto') { say(['You picked ', bold(projectSel.selectedOptions[0] ? projectSel.selectedOptions[0].textContent.split(' · ')[0] : projectSel.value), '. Choose "Codes picks for you" to let it work out the projects from your words.']); return; }
            const q = text.value.trim();
            clearTimeout(pickTimer);
            if (!q) { say([DEFAULT_PICK]); return; }
            pickTimer = setTimeout(async () => {
                const mine = ++pickSeq;
                try {
                    const res = await fetch(`${picked.dataset.chMatchUrl}?text=${encodeURIComponent(q.slice(0, 2000))}`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
                    if (!res.ok || mine !== pickSeq) return;
                    const names = ((await res.json()).projects || []).map((p) => p.name);
                    if (mine !== pickSeq) return;
                    if (!names.length) say(['No site named yet: say which one (like Live, Chat or Games, or "the navbar"), or pick it from the list.']);
                    else say(['Codes will work on ', bold(list(names)), names.length > 1 ? ': one task each, told about the others.' : '.']);
                } catch { /* the server decides when it is sent */ }
            }, 300);
        }
        if (text) text.addEventListener('input', pick);
        if (projectSel) projectSel.addEventListener('change', pick);
        const current = modes.find((r) => r.checked);
        if (rail && current) rail.dataset.chShown = current.value;
        pace();
        if (rail) {
            rail.addEventListener('click', (e) => {
                const b = e.target.closest('[data-ch-idea]');
                if (!b) return;
                choose(b.dataset.chIdeaMode);
                if (b.dataset.chIdeaKind) setKind(b.dataset.chIdeaKind);
                text.value = b.dataset.chIdea;
                grow();
                // The words are the person's to change: on a computer the caret goes to the end; a phone keeps the
                // keyboard down so the filled box and Send stay in view.
                if (fine) { text.focus(); text.setSelectionRange(text.value.length, text.value.length); }
            });
            const pause = $('[data-ch-ideas-pause]', rail);
            if (pause) pause.addEventListener('click', () => {
                const paused = rail.classList.toggle('is-paused');
                pause.setAttribute('aria-pressed', String(paused));
                pause.setAttribute('aria-label', paused ? 'Play the ideas' : 'Pause the ideas');
                pause.title = pause.getAttribute('aria-label');
            });
        }
    }

    function init() {
        const app = document.querySelector('[data-chat]');
        if (!app || app.dataset.chReady) return;
        app.dataset.chReady = '1';
        page = { app, es: null };

        // ── The composer (the kit's: it grows, Enter sends, Send waits for words) ──
        const form = $('[data-ovt-composer]', app);
        const text = form && $('[data-ovt-text]', form);
        const status = form && $('[data-ovt-note]', form);
        const say = (msg, bad) => { if (status) { status.textContent = msg; status.classList.toggle('is-bad', !!bad); } };
        if (text) {
            startPage(app, form, text);
            // The repository: a recent one is a tap away. A full Git address always works; the shared dropdown
            // (data-ov-combo, openvibe-shared 4.202.0) enhances the field's search when it ships.
            const repo = $('[data-ch-repo]', form);
            app.querySelectorAll('[data-ch-saved-repo]').forEach((b) => b.addEventListener('click', () => { if (repo) { repo.value = b.dataset.chSavedRepo; if (!matchMedia('(pointer: coarse)').matches) text.focus(); } }));
            // The keyboard hint only where Enter sends (a phone keyboard's return is a new line).
            if (status && !status.textContent && !matchMedia('(pointer: coarse)').matches) status.textContent = 'Enter sends · Shift+Enter for a new line';
            if ($('.ovt.is-start', app) && !matchMedia('(pointer: coarse)').matches) text.focus({ preventScroll: true });
        }
        if (form) {
            // The shared picker owns drop, keyboard selection, rows and progress. Codes owns its upload transport.
            const uploadRoot = $('[data-ch-upload]', form);
            const BLOCKED = /\.(exe|dll|com|bat|cmd|msi|scr|ps1|sh|so|dylib|app|apk|deb|rpm|jar|bin|elf|vbs|wsf|hta)$/i;
            const MAX_FILES = 10, MAX_FILE = 20 * 1024 * 1024, MAX_TOTAL = 50 * 1024 * 1024;
            const entries = [];
            let picker = null;
            function addFile(file, row) {
                const total = entries.reduce((n, e) => n + e.file.size, 0);
                let problem = '';
                if (BLOCKED.test(file.name)) problem = `“${file.name}” is a program or script, and cannot be attached`;
                else if (!file.size) problem = `“${file.name}” is empty`;
                else if (file.size > MAX_FILE) problem = `“${file.name}” is larger than 20 MB`;
                else if (entries.length >= MAX_FILES) problem = 'A message carries at most 10 files';
                else if (total + file.size > MAX_TOTAL) problem = 'The files of one message are larger than 50 MB together';
                if (problem) { row.dispatchEvent(new Event('remove')); row.remove(); say(problem, true); return; }
                const meterRoot = document.createElement('div');
                row.append(meterRoot);
                const meter = OVUpload.progress(meterRoot, { onRetry: () => sendFile() });
                const entry = { file, row, meter, id: null, uploading: true, xhr: null };
                entries.push(entry);
                function sendFile() {
                    entry.uploading = true;
                    meter.update({ state: 'sending', done: 0, total: file.size });
                    const xhr = entry.xhr = new XMLHttpRequest();
                    xhr.open('POST', '/api/v1/attachments');
                    xhr.withCredentials = true;
                    xhr.upload.onprogress = (e) => { if (e.lengthComputable) meter.update({ state: 'sending', done: e.loaded, total: e.total }); };
                    xhr.onload = () => {
                        entry.uploading = false;
                        let doc = {};
                        try { doc = JSON.parse(xhr.responseText || '{}'); } catch { /* response is not JSON */ }
                        if (xhr.status === 201 && doc.attachment && doc.attachment.id) {
                            entry.id = doc.attachment.id;
                            meter.update({ state: 'done', done: file.size, total: file.size });
                        } else {
                            const message = doc.detail || `“${file.name}” could not be attached`;
                            meter.update({ state: 'failed', message }); say(message, true);
                        }
                    };
                    xhr.onerror = () => { entry.uploading = false; const message = `“${file.name}” could not be attached`; meter.update({ state: 'failed', message }); say(message, true); };
                    xhr.onabort = () => { entry.uploading = false; };
                    const data = new FormData(); data.append('file', file, file.name); xhr.send(data);
                }
                sendFile();
                say(`${entries.length} file${entries.length === 1 ? '' : 's'} selected`);
            }
            if (uploadRoot && window.OVUpload) {
                picker = OVUpload.picker(uploadRoot, {
                    label: 'Attach files', accept: uploadRoot.dataset.accept, multiple: true,
                    onFile: addFile,
                    onRemove: (file) => {
                        const i = entries.findIndex((entry) => entry.file === file);
                        if (i < 0) return;
                        const [entry] = entries.splice(i, 1);
                        if (entry.xhr) entry.xhr.abort();
                        entry.meter.destroy();
                        if (entry.id) fetch(`/api/v1/attachments/${encodeURIComponent(entry.id)}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
                        say(entries.length ? `${entries.length} file${entries.length === 1 ? '' : 's'} selected` : '');
                    }
                });
                if (text) text.addEventListener('paste', (e) => {
                    const files = e.clipboardData && e.clipboardData.files;
                    if (files && files.length) { e.preventDefault(); picker.add(files); }
                });
            }
            form.addEventListener('submit', async (e) => {
                const submitter = e.submitter;
                if (submitter && submitter.formAction && submitter.formAction !== form.action) return; // Stop: a plain post
                form.classList.add('is-sending');
                form.querySelectorAll('button').forEach((b) => { b.disabled = b.matches('[data-ovt-send]'); });
                if (!entries.length) { say('Sending…'); return; }       // words alone: the plain form post
                e.preventDefault();
                // A file still going up is waited for, not dropped: the message names ids and the server checks them.
                if (entries.some((x) => x.uploading)) say('Uploading the files…');
                while (entries.some((x) => x.uploading)) await new Promise((done) => setTimeout(done, 120));
                const failed = entries.filter((x) => !x.id);
                if (failed.length) {
                    say(`${failed.length} file${failed.length === 1 ? '' : 's'} could not be attached`, true);
                    form.classList.remove('is-sending');
                    form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
                    return;
                }
                const ids = entries.map((x) => x.id);
                if (form.dataset.chApi) {
                    say(ids.length === 1 ? 'Sending the file…' : `Sending ${ids.length} files…`);
                    try {
                        const who = $('[name="who"]', form);
                        const res = await fetch(form.dataset.chApi, {
                            method: 'POST', credentials: 'same-origin',
                            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                            body: JSON.stringify({ text: text ? text.value : '', attachment_ids: ids, ...(who && who.value ? { who: who.value } : {}) }),
                        });
                        const doc = await res.json().catch(() => ({}));
                        if (!res.ok) throw new Error(doc.detail || `the message was refused (${res.status})`);
                        location.reload();
                    } catch (err) {
                        say(String((err && err.message) || 'the message could not be sent'), true);
                        form.classList.remove('is-sending');
                        form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
                    }
                    return;
                }
                // The files are up: a plain form post names their ids (and sends the words and the pickers as usual).
                form.enctype = 'application/x-www-form-urlencoded';
                for (const id of ids) {
                    const hidden = document.createElement('input');
                    hidden.type = 'hidden'; hidden.name = 'attachment_ids'; hidden.value = id;
                    form.appendChild(hidden);
                }
                say(ids.length === 1 ? 'Sending the file…' : `Sending ${ids.length} files…`);
                form.submit();
            });
        }

        // ── A running turn streams in: each tool as the agent takes it, and the finished turn when the attempt ends ──
        const stream = app.dataset.chStream;
        const live = $('[data-ovt-thread] > .ovt-turn[data-open]', app);
        const OV = window.OVThread;
        if (!stream || !live || !OV || typeof EventSource === 'undefined') return;
        const id = live.dataset.turn;
        const kindOf = (name) => {
            const n = String(name || '').toLowerCase();
            if (/^(read|view|cat|ls|glob|list|open)|read_file|list_dir/.test(n)) return 'read';
            if (/(grep|search|find|rg)/.test(n) && !/web/.test(n)) return 'find';
            if (/(edit|write|patch|apply|create|replace|multiedit|str_replace)/.test(n)) return 'edit';
            if (/(bash|shell|exec|run|command|terminal)/.test(n)) return 'run';
            if (/(web|fetch|browse|http|url)/.test(n)) return 'web';
            if (/(task|agent|delegate|subagent)/.test(n)) return 'sub';
            return 'tool';
        };
        const attemptN = Number(live.dataset.attempt || 0);
        const MD = window.CodesMarkdown;
        // The live line says what the agent is doing, in words: "Editing server/app.js".
        const VERB = { read: 'Reading', find: 'Searching', edit: 'Editing', run: 'Running', web: 'Browsing', sub: 'Handing over', tool: 'Using' };
        // What a tool call was given: its one line, whatever shape the agent wrote it in.
        const whatOf = (b) => {
            if (b.what) return String(b.what);
            const i = b.input;
            if (!i) return '';
            if (typeof i === 'string') return i;
            return String(i.file_path || i.path || i.command || i.pattern || i.query || i.url || '');
        };
        const es = page.es = new EventSource(stream);
        // The answer grows as the text arrives: it is drawn again at most every 120 ms, and the page follows only when
        // the reader was at the bottom (the kit's rule).
        let buffer = '', painted = 0, timer = 0, ended = false;
        const nearBottom = () => (window.innerHeight || 0) + (window.scrollY || 0) >= (document.documentElement.scrollHeight || 0) - 220;
        const answerOf = () => {
            let node = live.querySelector('[data-ovt-answer]');
            if (!node) {
                node = document.createElement('div');
                node.className = 'ovt-answer';
                node.setAttribute('data-ovt-answer', '');
                const reply = live.querySelector('.ovt-reply');
                if (reply) reply.appendChild(node);
            }
            return node;
        };
        const paint = () => {
            timer = 0;
            painted = Date.now();
            const node = answerOf();
            if (!node) return;
            const stay = nearBottom();
            if (MD) { node.innerHTML = MD.markdown(buffer); if (MD.enhance) MD.enhance(node); }
            else node.textContent = buffer;
            if (stay) window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
        };
        const schedule = () => {
            if (timer) return;
            timer = setTimeout(paint, Math.max(0, 120 - (Date.now() - painted)));
        };
        // A tool's output folds under its row, and the fold says how much is in it.
        const foldOutput = (key, output) => {
            if (output == null) return;
            const rows = live.querySelectorAll('[data-ovt-work] > .ovt-w-tool');
            let row = null;
            for (const r of rows) if (String(r.getAttribute('data-key')) === String(key)) row = r;
            if (!row) return;
            const head = row.querySelector('.ovt-w-row');
            if (head && MD) {
                const mark = head.querySelector('.ovt-w-st');
                const label = document.createElement('span');
                label.className = 'ovt-w-in ovt-w-fold';
                label.textContent = MD.outputLabel(output);
                head.insertBefore(label, mark);
            }
            const det = document.createElement('details');
            const sum = document.createElement('summary');
            if (head) sum.appendChild(head);
            det.appendChild(sum);
            det.insertAdjacentHTML('beforeend', MD ? MD.outputBody(output) : '');
            row.appendChild(det);
        };
        // The finished turn comes from the server: its answer has its Copy buttons and its work its output folds.
        const finish = () => {
            if (ended) return;
            ended = true;
            es.close();
            const swap = (again) => {
                fetch(window.location.href, { headers: { Accept: 'text/html' }, credentials: 'same-origin' })
                    .then((r) => (r.ok ? r.text() : ''))
                    .then((html) => {
                        if (!html) { location.reload(); return; }
                        const doc = new DOMParser().parseFromString(html, 'text/html');
                        const fresh = doc.querySelector('[data-turn="' + id + '"]');
                        if (!fresh) { location.reload(); return; }
                        if (again && fresh.hasAttribute('data-open')) { setTimeout(() => swap(false), 900); return; }
                        OV.replace(id, fresh.outerHTML);
                        // The composer stops working with the turn.
                        const form = $('[data-ovt-composer]', app);
                        if (form) {
                            form.classList.remove('is-busy');
                            const stop = $('[data-ovt-stop]', form);
                            if (stop) stop.hidden = true;
                        }
                    })
                    .catch(() => location.reload());
            };
            setTimeout(swap, 400);
        };
        es.addEventListener('line', (ev) => {
            let d; try { d = JSON.parse(ev.data); } catch { return; }
            if (attemptN && d.attempt_n && Number(d.attempt_n) !== attemptN) return;
            const b = d.body && typeof d.body === 'object' ? d.body : { t: d.kind, text: String(d.body || '') };
            if (b.t === 'tool') {
                const what = whatOf(b);
                OV.tool(id, { name: b.name || 'tool', input: what, icon: kindOf(b.name), key: b.id });
                OV.live(id, `${VERB[kindOf(b.name)] || 'Using'} ${what}`.trim());
            } else if (b.t === 'tool_result') {
                OV.toolDone(id, b.ok !== false, b.id);
                foldOutput(b.id, b.output);
            } else if (b.t === 'text' && b.text) {
                const t = String(b.text);
                // The words may arrive as a whole message or as a piece of one; either way the answer holds all of them.
                buffer = buffer && !t.startsWith(buffer) ? buffer + t : t;
                OV.live(id, t.split('\n').find(Boolean) || 'Working');
                schedule();
            } else if (b.t === 'done') {
                if (b.text) buffer = String(b.text);
                schedule();
                finish();
            } else if (b.t === 'end' || d.kind === 'end') finish();
        });
        es.addEventListener('attempt', (ev) => {
            let d; try { d = JSON.parse(ev.data); } catch { return; }
            // The stream replays every attempt on connect: only the live one ending, or a newer one starting, is news.
            if (d.type === 'attempt_ended' && attemptN && Number(d.attempt_n) === attemptN) finish();
            else if (d.type === 'attempt_started' && attemptN && Number(d.attempt_n) > attemptN) { es.close(); location.reload(); }
        });
        es.addEventListener('end', finish);
    }
})();
