'use strict';
// Codes' own parts of the chat app (plan L31 CH1). The conversation UI is the network's (openvibe-shared/thread, plan
// L55 C4): ov-thread.js grows the composer, sends on Enter, filters the rail, opens the panel on a narrow screen, adds
// Copy and keeps the thread at the bottom; kit-web.js opens the rail on a phone. The page works without either. Here:
// - a new chat's three ways to start, the ideas rail, the projects picked from the words and the repository search;
// - the conductor's images go up with the message through the JSON API;
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
            const lists = track.querySelectorAll('.ch-spark-list');
            lists.forEach((ul, n) => { ul.textContent = ''; sets[mode].forEach((i) => ul.appendChild(card(i, n > 0))); });
            pace();
        }
        function choose(mode, { focus = false } = {}) {
            const radio = modes.find((r) => r.value === mode);
            if (radio && !radio.checked) radio.checked = true;
            if (text && PLACEHOLDER[mode]) text.placeholder = PLACEHOLDER[mode];
            if (rail && rail.dataset.chShown !== mode) { rail.dataset.chShown = mode; fill(mode); }
            if (focus && text) text.focus();
        }
        modes.forEach((r) => r.addEventListener('change', () => { if (r.checked) { choose(r.value, { focus: true }); pick(); } }));

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
                text.focus();
                // The words are the person's to change: the caret goes to the end.
                text.setSelectionRange(text.value.length, text.value.length);
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
            // The repository: a recent one is a tap away, and typing searches every repository the person can reach.
            const repo = $('[data-ch-repo]', form);
            app.querySelectorAll('[data-ch-saved-repo]').forEach((b) => b.addEventListener('click', () => { if (repo) { repo.value = b.dataset.chSavedRepo; text.focus(); } }));
            if (repo && repo.dataset.chRepoUrl) {
                const list = document.getElementById(repo.getAttribute('list'));
                let timer = 0, seq = 0;
                repo.addEventListener('input', () => {
                    clearTimeout(timer);
                    timer = setTimeout(async () => {
                        const q = repo.value.trim();
                        if (!list || q.length < 2 || /^https?:\/\//i.test(q)) return;
                        const mine = ++seq;
                        try {
                            const res = await fetch(`${repo.dataset.chRepoUrl}?q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
                            if (!res.ok || mine !== seq) return;
                            const doc = await res.json();
                            if (mine !== seq) return;
                            list.textContent = '';
                            (doc.repos || []).forEach((r) => { const o = document.createElement('option'); o.value = r.url; o.label = r.full_name + (r.recent ? ' · used here' : ''); list.appendChild(o); });
                        } catch { /* the typed URL still works */ }
                    }, 250);
                });
            }
            // The keyboard hint only where Enter sends (a phone keyboard's return is a new line).
            if (status && !status.textContent && !matchMedia('(pointer: coarse)').matches) status.textContent = 'Enter sends · Shift+Enter for a new line';
            if ($('.ovt.is-start', app)) text.focus({ preventScroll: true });
        }
        if (form) {
            const images = $('[data-ch-images]', form);
            if (images) images.addEventListener('change', () => {
                const n = (images.files || []).length;
                images.closest('.ch-pick-file').classList.toggle('has-files', n > 0);
                say(n ? `${n} image${n === 1 ? '' : 's'} will go with your message` : '');
            });
            form.addEventListener('submit', async (e) => {
                const submitter = e.submitter;
                if (submitter && submitter.formAction && submitter.formAction !== form.action) return; // Stop: a plain post
                const files = images ? Array.from(images.files || []).slice(0, 4) : [];
                form.classList.add('is-sending');
                form.querySelectorAll('button').forEach((b) => { b.disabled = b.matches('[data-ovt-send]'); });
                if (!files.length) { say('Sending…'); return; }       // words alone: the plain form post
                e.preventDefault();
                say(files.length === 1 ? 'Sending the image…' : `Sending ${files.length} images…`);
                const asData = (file) => new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve({ name: file.name, mime: file.type, data: String(r.result || '') }); r.onerror = () => resolve(null); r.readAsDataURL(file); });
                try {
                    const attachments = (await Promise.all(files.map(asData))).filter(Boolean);
                    const res = await fetch(form.dataset.chApi, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ text: text.value, attachments }) });
                    const doc = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(doc.detail || `the message was refused (${res.status})`);
                    location.reload();
                } catch (err) {
                    say(String((err && err.message) || 'the message could not be sent'), true);
                    form.classList.remove('is-sending');
                    form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
                }
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
        const es = page.es = new EventSource(stream);
        let reloading = false;
        const reload = () => { if (reloading) return; reloading = true; es.close(); setTimeout(() => location.reload(), 500); };
        es.addEventListener('line', (ev) => {
            let d; try { d = JSON.parse(ev.data); } catch { return; }
            if (attemptN && d.attempt_n && Number(d.attempt_n) !== attemptN) return;
            const b = d.body && typeof d.body === 'object' ? d.body : { t: d.kind, text: String(d.body || '') };
            if (b.t === 'tool') {
                OV.tool(id, { name: b.name || 'tool', input: b.what || '', icon: kindOf(b.name), key: b.id });
                OV.live(id, `${b.name || 'Working'} ${b.what || ''}`.trim());
            } else if (b.t === 'tool_result') {
                OV.toolDone(id, b.ok !== false, b.id);
            } else if (b.t === 'text' && b.text) {
                OV.live(id, String(b.text).split('\n').find(Boolean) || 'Working');
            } else if (b.t === 'done' || b.t === 'end' || d.kind === 'end') reload();
        });
        es.addEventListener('attempt', (ev) => {
            let d; try { d = JSON.parse(ev.data); } catch { return; }
            // The stream replays every attempt on connect: only the live one ending, or a newer one starting, is news.
            if ((d.type === 'attempt_ended' && attemptN && Number(d.attempt_n) === attemptN) || (d.type === 'attempt_started' && attemptN && Number(d.attempt_n) > attemptN)) reload();
        });
        es.addEventListener('end', reload);
    }
})();
