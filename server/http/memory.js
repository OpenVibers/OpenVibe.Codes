'use strict';

/**
 * The Memory page (OpenVibe Memory M2b): what the person's own assistants know about them.
 *
 * The notes live in OpenVibe.AI's memory store, sealed there and opened only by the person's own token. This
 * page never stores a note: it forwards the person's token to the store (server/domain/memory.js), renders what
 * comes back and forgets it. An import preview passes through the same way, only long enough to show the
 * candidates. The token is never written into the page, and no note text is ever logged.
 *
 *   GET  /memory             the page: the sources, then one tab (notes, disagree, suggested, profile, reads, import)
 *   POST /memory/import/preview  an export zip or pasted memory list, parsed by the store into a preview
 *   POST /memory/import/:id/commit  the candidates the person ticked, and the draft is gone
 *   GET  /memory/remove      what one source's removal would take away, and the one form that does it
 *   POST /memory/remove      everything from one source, gone (the store's own delete)
 *   POST /memory/items/:id/edit      the note's text and kind
 *   POST /memory/items/:id/archive   the note, out of the way
 *   POST /memory/items/:id/split     two notes that say the same thing, apart again
 *   POST /memory/items/:id/delete    the note, gone
 *   POST /memory/items/:id/accept    a suggestion, kept
 *   POST /memory/items/:id/decline   a suggestion, let go
 *   POST /memory/conflicts/:id/settle  the note of a pair that stays
 *
 * Every write is a same-origin form post and answers with a redirect back to the tab it came from, carrying a
 * flash. The page is complete without JavaScript: the tabs are links, the menus are details elements, and the
 * only script on the site is the one the other workspace pages already load.
 */

const express = require('express');
const { asyncRouter } = require('./router');
const { esc } = require('../render/html');

/** The adapter ids the Link reads and the services that write, and the names a person knows them by. */
const SOURCE_NAMES = {
    'claude-code': 'Claude Code', agents: 'AGENTS.md', gemini: 'Gemini CLI', cursor: 'Cursor',
    copilot: 'GitHub Copilot', windsurf: 'Windsurf', cline: 'Cline', roo: 'Roo Code', kiro: 'Kiro',
    continue: 'Continue', aider: 'Aider', 'command-code': 'Command Code', opencode: 'OpenCode',
    actor: 'Actor', vibe: 'Vibe', know: 'Know', person: 'You', codes: 'Codes', codex: 'Codex',
    chatgpt: 'ChatGPT', 'claude-ai': 'Claude', 'gemini-apps': 'Gemini', paste: 'Pasted memory',
};
const sourceName = (id) => SOURCE_NAMES[String(id || '')] || String(id || '').replace(/[-_]+/g, ' ');

/** The kinds the store knows, in a person's words. */
const KINDS = ['preference', 'fact', 'project_rule', 'procedure', 'decision', 'lesson'];
const kindName = (kind) => String(kind || '').replace(/_/g, ' ');

/** A scope, in a person's words: "You" for their own, the project's name for a project's. */
const scopeName = (scope) => {
    const s = String(scope || 'user');
    if (s === 'user') return 'You';
    return s.startsWith('project:') ? s.slice('project:'.length) : s;
};

/** The day something happened: today, "Oct 30", or "Oct 30, 2025". */
const dayOf = (value) => {
    const t = Date.parse(String(value || ''));
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'today';
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + (sameYear ? '' : ', ' + d.getFullYear());
};

/** How long ago, in the page's own words: "2 h ago", "5 min ago", "3 d ago". */
const agoOf = (value) => {
    const ms = Date.parse(String(value || ''));
    if (!Number.isFinite(ms)) return '';
    const mins = Math.max(0, Math.floor((Date.now() - ms) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    if (mins < 1440) return Math.floor(mins / 60) + ' h ago';
    return Math.floor(mins / 1440) + ' d ago';
};

const MEMORY_TABS = [
    ['notes', 'Notes'], ['disagree', 'Disagree'], ['suggested', 'Suggested'],
    ['profile', 'Profile'], ['reads', 'Who read it'], ['services', 'Services'],
    ['shared', 'Shared'], ['import', 'Import'], ['export', 'Export'],
];

/** The share sheet and the gate are drawn by openvibe-shared (openvibe-shared 4.123.0); no inline script. */
const SHARE_ASSETS = { styles: ['ov-share.css'], sharedScripts: ['ov-share.js'], scripts: ['js/memory-import.js'] };
const SERVICES = ['mem0', 'letta', 'zep'];

/** What the store's refusals say to a person. The words are ours: no note text ever reaches a flash. */
const PROBLEMS = {
    'memory.not_found': 'That note is gone.',
    'memory.not_split': 'That note was not merged with another one.',
    'memory.not_conflict': 'These two notes are not in conflict.',
    'memory.secret_only': 'That text is only a secret, so it was refused.',
    'input.invalid': 'That change was refused.',
    'memory.unreadable': 'That note could not be read.',
    'memory.unavailable': 'Your memory is not available right now.',
    'memory.signed_out': 'Sign in again to see your memory.',
    'memory.services_unavailable': 'Memory services are not configured on OpenVibe yet.',
    'memory.service_not_found': 'That memory service is not connected.',
    'memory.service_key_required': 'Enter the key the first time.',
    'memory.service_key_refused': 'The service refused that key. Check it and try again.',
    'memory.service_unreachable': 'That service could not be reached. Check the address.',
    'memory.service_rate_limited': 'The service is rate-limiting the key. Try again later.',
    'memory.service_failed': 'The service did not answer in a way we could read.',
    'memory.sharing_unavailable': 'Sharing is not configured on OpenVibe yet.',
    'share.not_found': 'That sharing setting is not there.',
    'share.exists': 'That store is already shared.',
    'share.invalid': 'That sharing change was refused.',
    'share.rate_limited': 'Too many name checks. Try again in a minute.',
    'import.bad_zip': 'That file is not a zip archive we can read.',
    'import.invalid': 'That file is not an export this page reads.',
    'import.expired': 'That preview has expired. Drop the export again.',
    'import.not_found': 'That preview is no longer here.',
    'input.too_large': 'That upload is too large. Export only the assistant’s data.',
};
const problemWord = (e) => PROBLEMS[String((e && e.code) || '')] || 'Your memory could not be changed. Try again in a moment.';

/** The store's own ids: a note is a mem_ ULID. Anything else is not a note and never reaches the store. */
const NOTE_ID = /^mem_[0-9A-HJKMNP-TV-Z]{26}$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

function createMemoryRoutes(ctx, kit) {
    const { page, wrap, header, pill, flash, sameOrigin, viewer, form, signIn } = kit;
    const { sso, memory } = ctx;
    const router = asyncRouter();
    // An export is raw bytes (one multipart form from the page, or a zip in a test); the store parses it, not Codes.
    const importBody = express.raw({
        type: ['multipart/form-data', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
        limit: '25mb',
    });
    const importUpload = (req, res, next) => importBody(req, res, (err) => {
        if (!err) return next();
        return back(req, res, 'import', '', err.type === 'entity.too.large'
            ? 'That upload is larger than 25 MB. Export only the assistant’s data, or paste the extraction answer.'
            : 'That upload could not be read.');
    });

    /** The person's own token, used for one call to the store. It never leaves this process. */
    async function withToken(req, res, call) {
        return await sso.asViewer(req, res, (token) => call(token));
    }

    /** Where a write goes back to: the tab it came from, with a flash. */
    const back = (req, res, fallback, ok, error) => {
        const asked = String((req.body && req.body.tab) || '');
        const tab = MEMORY_TABS.some(([id]) => id === asked) ? asked : fallback;
        const target = '/memory?tab=' + encodeURIComponent(tab);
        if (error) return res.redirect(303, target + '&error=' + encodeURIComponent(String(error).slice(0, 180)));
        return res.redirect(303, target + '&ok=' + encodeURIComponent(String(ok).slice(0, 140)));
    };

    /** The page. One call to the store holds every tab's data; only the open tab is built. */
    async function memoryPage(req, res) {
        const title = 'Memory';
        const me = viewer(req);
        const head = header(title, 'What your assistants know about you, in one place.');
        if (!me) return page(req, res, title, wrap(head + signIn(req)));
        // The owner's own store is shared from here. The sheet is openvibe-shared's markup and script; the API is
        // Codes' proxy to AI (/api/v1/memory-store/:id/share), so the ACL stays where the notes are.
        const shareButton = /^usr_/.test(String(me || ''))
            ? `<div class="c4-actions"><button type="button" class="c4-button c4-button-quiet" data-ov-share-sheet data-kind="memory-store" data-id="${esc(me)}" data-title="Your memory">Share</button></div>`
            : '';
        const asked = String(req.query.tab || '');
        const tab = MEMORY_TABS.some(([id]) => id === asked) ? asked : 'notes';
        const q = String(req.query.q || '').slice(0, 200);
        const scope = String(req.query.scope || '').slice(0, 80);
        const owner = String(req.query.owner || '').slice(0, 80);

        let items = [];
        let problem = null;
        try {
            const out = await withToken(req, res, (token) => memory.items(token, {}));
            items = Array.isArray(out.items) ? out.items : [];
        } catch (e) {
            problem = e;
        }

        const byStatus = { active: [], suggested: [], archived: [], conflict: [] };
        for (const item of items) {
            const bucket = byStatus[item.status];
            (bucket || byStatus.archived).push(item);
        }
        // The notes that swallowed another one: the store merges two notes that say the same thing and keeps
        // the swallowed one archived with the winner's id in merged_into.
        const merged = new Set(items.map((i) => i.merged_into).filter(Boolean));
        const scopes = [...new Set(items.map((i) => i.scope).filter(Boolean))]
            .sort((a, b) => (a === 'user' ? -1 : b === 'user' ? 1 : a.localeCompare(b)));
        const pairs = conflictPairs(byStatus.conflict);
        const sources = sourceRows(items);

        const notes = byStatus.active.filter((i) => (!scope || i.scope === scope)
            && (!q || String(i.text || '').toLowerCase().includes(q.toLowerCase())));

        const tabs = '<nav class="c4-tabs" aria-label="Memory">' + MEMORY_TABS.map(([id, label]) => {
            const count = id === 'notes' ? byStatus.active.length : id === 'disagree' ? pairs.length : id === 'suggested' ? byStatus.suggested.length : null;
            const text = count == null ? label : label + ' (' + count + ')';
            return '<a href="/memory?tab=' + id + '"' + (id === tab ? ' aria-current="page"' : '') + '>' + esc(text) + '</a>';
        }).join('') + '</nav>';

        let panel = '';
        if (tab === 'notes') panel = notesPanel(notes, q, scope, scopes, merged);
        else if (tab === 'disagree') panel = conflictPanel(pairs);
        else if (tab === 'suggested') panel = suggestedPanel(byStatus.suggested);
        else if (tab === 'profile') panel = await profilePanel(req, res, scopes, byStatus.active);
        else if (tab === 'reads') panel = await readsPanel(req, res);
        else if (tab === 'services') panel = await servicesPanel(req, res);
        else if (tab === 'shared') panel = await sharedPanel(req, res, owner);
        else if (tab === 'export') panel = exportPanel();
        else if (tab === 'import') {
            let walkthroughs = null;
            let prompt = '';
            try {
                const out = await withToken(req, res, (token) => memory.providers(token));
                walkthroughs = out.providers;
                prompt = out.prompt;
            } catch (e) {
                if (!problem) problem = e;
            }
            panel = importPanel(walkthroughs, prompt);
        }

        const content = head + shareButton + flash(req)
            + (problem ? note('Your memory could not be read right now. ' + problemWord(problem), 'bad') : '')
            + sourcesPanel(sources) + tabs + panel;
        return page(req, res, title, wrap(content), SHARE_ASSETS);
    }

    /** The Import tab: one walkthrough per cloud assistant, then one paste card that works anywhere. */
    function importPanel(providers, prompt) {
        const privacy = '<p class="c4-hint">We remove passwords, keys and tokens before anything is shown. '
            + 'What you see are candidates, not saved notes: nothing is kept until you tick it and press Keep selected. '
            + 'A preview lasts two hours.</p>';
        if (!Array.isArray(providers) || !providers.length) {
            return '<section class="c4-card"><h2>Bring in an export</h2>'
                + '<p class="c4-hint">The import is not available right now. Try again in a moment.</p></section>';
        }
        const card = (p) => '<article class="c4-card">'
            + '<div class="c4-card-head"><h2>' + esc(p.name) + '</h2>'
            + '<a class="c4-quiet-link" href="' + esc(p.url) + '" target="_blank" rel="noopener">Open ' + esc(p.name) + '</a></div>'
            + '<p class="c4-hint">' + esc(p.what) + '</p>'
            + '<ol class="c4-steps">' + (p.steps || []).map((step) => '<li>' + esc(step) + '</li>').join('') + '</ol>'
            + '<p class="c4-hint"><strong>What arrives:</strong> ' + esc(p.arrives) + '<br><strong>How long:</strong> ' + esc(p.time) + '</p>'
            + '<form class="c4-form" method="post" action="/memory/import/preview" enctype="multipart/form-data">'
            + '<input type="hidden" name="provider" value="' + esc(p.id) + '">'
            + '<label class="c4-file">Your export .zip <input type="file" name="file" accept=".zip,application/zip,application/x-zip-compressed" required></label>'
            + '<button class="c4-button" type="submit">Preview ' + esc(p.name) + '</button>'
            + '</form></article>';
        const paste = '<section class="c4-card"><div class="c4-card-head"><h2>Any assistant: ask what it remembers</h2>'
            + '<span class="c4-muted">works for Grok, Copilot, Perplexity too</span></div>'
            + '<p class="c4-hint">Open a new chat in the assistant, paste the prompt, then paste its answer here. '
            + 'This is the same method Claude’s own memory import uses.</p>'
            + '<details class="c4-more"><summary>Show the prompt to paste</summary>'
            + '<div class="c4-more-body"><pre class="c4-code">' + esc(prompt) + '</pre></div></details>'
            + '<form class="c4-form" method="post" action="/memory/import/preview" enctype="multipart/form-data">'
            + '<label>Which assistant answered?<select name="provider">'
            + '<option value="chatgpt">ChatGPT</option><option value="claude-ai">Claude</option>'
            + '<option value="gemini-apps">Gemini</option><option value="other">Another assistant</option>'
            + '</select></label>'
            + '<label>Its answer<textarea name="text" rows="8" required placeholder="Paste the bullet list here"></textarea></label>'
            + '<button class="c4-button" type="submit">Preview the answer</button>'
            + '</form></section>';
        return '<p class="c4-hint">Bring in what ChatGPT, Claude or Gemini already remember about you. '
            + 'Each export is parsed by your memory store, not on your computer, and never stored as a chat.</p>'
            + privacy
            + '<div class="c4-grid c4-import-sources">' + providers.map(card).join('') + '</div>'
            + paste;
    }

    /** The preview: every candidate with its own tick. The form carries only the draft id and the ticked keys. */
    function previewPage(req, res, out) {
        const draft = (out && out.import) || {};
        const title = 'Import preview';
        const head = header(title, 'Nothing is saved until you press Keep selected.');
        const from = sourceName(draft.provider || '');
        const summary = draft.summary || {};
        const items = Array.isArray(draft.items) ? draft.items : [];
        if (!items.length) {
            return page(req, res, title, wrap(head + flash(req)
                + '<section class="c4-card"><h2>No notes found</h2>'
                + '<p class="c4-hint">' + esc(summary.note || 'That export did not contain anything that looked like a memory.')
                + ' The extraction prompt finds more than a chat export does.</p>'
                + '<p><a class="c4-button" href="/memory?tab=import">Try the extraction prompt</a></p></section>'));
        }
        const when = (value) => { const day = dayOf(value); return day ? ' · ' + day : ''; };
        const rows = items.map((item, i) => {
            const heading = item.source_ref && item.source_ref.heading ? ' · “' + String(item.source_ref.heading) + '”' : '';
            return '<label class="c4-check" for="keep-' + i + '">'
                + '<input type="checkbox" id="keep-' + i + '" name="keep" value="' + esc(item.key) + '" checked>'
                + '<span>' + esc(item.text)
                + '<small>' + esc(kindName(item.kind)) + ' · ' + esc(sourceName(item.source)) + esc(heading) + esc(when(item.seen_at)) + '</small>'
                + '</span></label>';
        }).join('');
        const secrets = Number(summary.secrets_removed) || 0;
        const more = Number(summary.skipped) || 0;
        const counts = items.length + (items.length === 1 ? ' possible note' : ' possible notes')
            + (from ? ' from ' + from : '')
            + (secrets ? ' · ' + secrets + ' secret' + (secrets === 1 ? ' was' : 's were') + ' removed before we showed them' : '')
            + (more ? ' · ' + more + ' older ones stay in your file' : '') + '.';
        const form = '<form class="c4-form" method="post" action="/memory/import/' + encodeURIComponent(draft.id) + '/commit">'
            + '<p class="c4-hint">' + esc(counts) + (summary.note ? ' ' + esc(summary.note) : '') + '</p>'
            + '<div class="c4-checks">' + rows + '</div>'
            + '<div class="c4-actions"><button class="c4-button" type="submit">Keep selected</button>'
            + '<button class="c4-opill c4-opill-quiet" type="submit" name="action" value="discard" formnovalidate>Discard all</button></div>'
            + '<p class="c4-hint"><a href="/memory?tab=import">Back to the walkthroughs</a>. The ticked notes go into your memory, '
            + 'never back to the assistant.</p></form>';
        res.set('Cache-Control', 'no-store');
        return page(req, res, title, wrap(head + flash(req) + '<section class="c4-card">' + form + '</section>'));
    }

    /** The sources card: where the notes came from, how many there are and when they were last seen. */
    function sourcesPanel(rows) {
        const head = '<section class="c4-card"><div class="c4-card-head"><h2>Sources</h2><span class="c4-muted">'
            + rows.length + (rows.length === 1 ? ' source' : ' sources') + '</span></div>';
        if (!rows.length) {
            return head + '<div class="c4-emptyline">Nothing here yet. On your computer, run '
                + '<code class="c4-code-inline">openvibe-node memory upload</code>: it shows what it found and asks before sending anything. '
                + '<a href="https://github.com/OpenVibers/OpenVibe.Node/blob/main/docs/memory.md#the-upload">The Link docs</a></div></section>';
        }
        const sourceRow = (row) => {
            const fresh = row.seen && Date.now() - row.seen < SEVEN_DAYS;
            const seen = row.seen ? agoOf(new Date(row.seen).toISOString()) : 'never';
            return '<li class="c4-row c4-row-flat c4-source"><span class="c4-row-dot c4-dot-' + (fresh ? 'ok' : 'skip') + '" aria-hidden="true"></span>'
                + '<span class="c4-row-label">' + esc(sourceName(row.id)) + '</span>'
                + '<span class="c4-row-note">' + row.count + (row.count === 1 ? ' note' : ' notes') + ' · seen ' + esc(seen) + '</span>'
                + '<a class="c4-quiet-link" href="/memory/remove?source=' + encodeURIComponent(row.id) + '">Remove…</a></li>';
        };
        // A phone shows the three most recent sources and the rest open behind a plain details; a desktop shows them all.
        const first = rows.slice(0, 3);
        const rest = rows.slice(3);
        const fold = rest.length
            ? '<li class="c4-more-row"><details class="c4-more"><summary>Show all ' + rows.length + ' sources</summary>'
                + '<div class="c4-more-body"><ul class="c4-rows">' + rest.map(sourceRow).join('') + '</ul></div></details></li>'
            : '';
        return head + '<ul class="c4-rows">' + first.map(sourceRow).join('') + fold + '</ul></section>';
    }

    /** The notes tab: a search, the scopes, and one row per note. */
    function notesPanel(notes, q, scope, scopes, merged) {
        const chips = [['all', 'All'], ['user', 'You']]
            .concat(scopes.filter((s) => s !== 'user').map((s) => [s, scopeName(s)]))
            .map(([value, label]) => {
                const here = value === 'all' ? !scope : scope === value;
                const href = '/memory?tab=notes&scope=' + encodeURIComponent(value === 'all' ? '' : value)
                    + (q ? '&q=' + encodeURIComponent(q) : '');
                return '<a class="c4-chip" href="' + href + '"' + (here ? ' aria-current="page"' : '') + '>' + esc(label) + '</a>';
            }).join('');
        const search = '<form class="c4-search" method="get" action="/memory"><input type="hidden" name="tab" value="notes">'
            + '<label class="c4-sr-only" for="memory-search">Search your notes</label>'
            + '<input id="memory-search" name="q" value="' + esc(q) + '" placeholder="Search your notes" maxlength="200">'
            + '<button class="c4-button c4-button-light">Search</button></form>';
        const body = notes.length
            ? '<ul class="c4-rows">' + notes.map((item) => noteRow(item, merged.has(item.id))).join('') + '</ul>'
            : '<div class="c4-emptyline">' + (q || scope ? 'No note matches. <a href="/memory?tab=notes">Show all</a>' : 'No notes yet.') + '</div>';
        return '<section class="c4-card">'
            + search + '<div class="c4-chips" aria-label="Scopes">' + chips + '</div>' + body
            + '<p class="c4-hint">A note is one thing your tools remembered. Everything here is yours: edit it, archive it or delete it.</p></section>';
    }

    /** One note: its text, what it is, where it came from, and the menu that changes it. */
    function noteRow(item, isMerged) {
        const sources = Array.isArray(item.sources) && item.sources.length ? item.sources : [item.source];
        const source = sources.length > 1 ? pill(sources.length + ' sources') : esc(sourceName(sources[0]));
        const when = item.updated_at || item.created_at || '';
        const meta = [esc(kindName(item.kind)), source, esc(scopeName(item.scope)),
            '<time datetime="' + esc(when) + '">' + esc(dayOf(when)) + '</time>'].join(' · ');
        const id = esc(item.id);
        return '<li class="c4-note">'
            + '<p class="c4-note-text">' + esc(item.text) + '</p>'
            + '<p class="c4-note-meta">' + meta + '</p>'
            + '<details class="c4-menu"><summary aria-label="More actions for this note">⋯</summary><div class="c4-menu-body">'
            + '<form class="c4-form" method="post" action="/memory/items/' + id + '/edit"><input type="hidden" name="tab" value="notes">'
            + '<label>Text<textarea name="text" rows="3" maxlength="2000">' + esc(item.text) + '</textarea></label>'
            + '<label>Kind<select name="kind">' + KINDS.map((k) => '<option value="' + k + '"' + (k === item.kind ? ' selected' : '') + '>' + esc(kindName(k)) + '</option>').join('') + '</select></label>'
            + '<button class="c4-button" type="submit">Save</button></form>'
            + '<form method="post" action="/memory/items/' + id + '/archive"><input type="hidden" name="tab" value="notes"><button class="c4-opill c4-opill-quiet" type="submit">Archive</button></form>'
            + (isMerged ? '<form method="post" action="/memory/items/' + id + '/split"><input type="hidden" name="tab" value="notes"><button class="c4-opill c4-opill-quiet" type="submit">Split</button></form>' : '')
            + '<form class="c4-note-danger" method="post" action="/memory/items/' + id + '/delete"><input type="hidden" name="tab" value="notes"><button class="c4-opill c4-opill-danger" type="submit">Delete</button></form>'
            + '</div></details></li>';
    }

    /** The pairs that disagree: each one a card with the two notes side by side. */
    function conflictPanel(pairs) {
        if (!pairs.length) {
            return '<section class="c4-card c4-empty"><h2>Nothing disagrees</h2>'
                + '<p>When two of your notes cannot both be true, they meet here and you choose.</p></section>';
        }
        return pairs.map((pair) => {
            const sides = pair.map((item) => {
                const other = pair.find((x) => x.id !== item.id);
                const sources = Array.isArray(item.sources) && item.sources.length ? item.sources : [item.source];
                const when = item.updated_at || item.created_at || '';
                return '<div class="c4-conflict-side"><p class="c4-note-text">' + esc(item.text) + '</p>'
                    + '<p class="c4-note-meta">' + esc(sourceName(sources[0])) + ' · <time datetime="' + esc(when) + '">' + esc(dayOf(when)) + '</time></p>'
                    + '<form method="post" action="/memory/conflicts/' + esc(item.id) + '/settle"><input type="hidden" name="tab" value="disagree">'
                    + '<input type="hidden" name="keep" value="' + esc(other.id) + '">'
                    + '<button class="c4-opill c4-opill-primary" type="submit">Keep this one</button></form></div>';
            }).join('');
            return '<section class="c4-card c4-conflict"><div class="c4-card-head"><h2>These two disagree</h2></div>'
                + '<div class="c4-conflict-pair">' + sides + '</div></section>';
        }).join('');
    }

    /** The suggestions: notes an agent proposed, with the agent's name. */
    function suggestedPanel(items) {
        if (!items.length) {
            return '<section class="c4-card c4-empty"><h2>Nothing suggested</h2>'
                + '<p>When an agent works out something about you, it asks first: the note waits here until you accept it.</p></section>';
        }
        const rows = items.map((item) => {
            const sources = Array.isArray(item.sources) && item.sources.length ? item.sources : [item.source];
            const when = item.updated_at || item.created_at || '';
            const id = esc(item.id);
            return '<li class="c4-note"><p class="c4-note-text">' + esc(item.text) + '</p>'
                + '<p class="c4-note-meta">Suggested by ' + esc(sourceName(sources[0])) + ' · ' + esc(kindName(item.kind))
                + ' · <time datetime="' + esc(when) + '">' + esc(dayOf(when)) + '</time></p>'
                + '<div class="c4-actions">'
                + '<form method="post" action="/memory/items/' + id + '/accept"><input type="hidden" name="tab" value="suggested"><button class="c4-opill c4-opill-primary" type="submit">Accept</button></form>'
                + '<form method="post" action="/memory/items/' + id + '/decline"><input type="hidden" name="tab" value="suggested"><button class="c4-opill c4-opill-quiet" type="submit">Decline</button></form>'
                + '</div></li>';
        }).join('');
        return '<section class="c4-card">'
            + '<p class="c4-sub">Notes your agents worked out on their own. Accept one to keep it; decline one and it goes.</p>'
            + '<ul class="c4-rows">' + rows + '</ul></section>';
    }

    /** The profile: one block per scope, the summary the store built from the person's own notes. */
    async function profilePanel(req, res, scopes, active) {
        if (!scopes.length) {
            return '<section class="c4-card c4-empty"><h2>No profile yet</h2>'
                + '<p>Once your notes are here, this is the short summary of them: one for you, one for each project.</p></section>';
        }
        const blocks = [];
        for (const scope of scopes) {
            let profile = null;
            try {
                const out = await withToken(req, res, (token) => memory.profile(token, scope));
                profile = out.profile || null;
            } catch (e) { /* one scope that does not answer does not stop the others */ }
            const count = active.filter((i) => i.scope === scope).length;
            const built = profile && profile.built_at ? profile.built_at : '';
            const when = built ? dayOf(built) : '';
            const text = profile && profile.text ? profile.text : 'Nothing to say about this scope yet.';
            blocks.push('<section class="c4-card"><div class="c4-card-head"><h2>' + esc(scopeName(scope)) + '</h2></div>'
                + '<p class="c4-profile-text">' + esc(text) + '</p>'
                + '<p class="c4-note-meta">Built from ' + count + (count === 1 ? ' note' : ' notes')
                + (when ? (when === 'today' ? ', today' : ' on <time datetime="' + esc(built) + '">' + esc(when) + '</time>') : '') + '</p></section>');
        }
        return blocks.join('')
            + '<p class="c4-hint">The summary rebuilds by itself when your notes change, at most once an hour. It never guesses: it says only what your notes say.</p>';
    }

    /** Who read the person's memory: the agent, the purpose and how many notes it took. Never the notes. */
    async function readsPanel(req, res) {
        let reads = [];
        let problem = null;
        try {
            const out = await withToken(req, res, (token) => memory.reads(token, 50));
            reads = Array.isArray(out.reads) ? out.reads : [];
        } catch (e) { problem = e; }
        if (problem) return '<section class="c4-card c4-empty"><h2>Who read it</h2><p>' + esc(problemWord(problem)) + '</p></section>';
        if (!reads.length) {
            return '<section class="c4-card c4-empty"><h2>Nobody has read it</h2>'
                + '<p>When an agent reads your notes for a task, it shows up here: who, for what, and how much.</p></section>';
        }
        const rows = reads.map((read) => {
            const actor = sourceName(String(read.actor || '').replace(/^svc:/, ''));
            const count = Number(read.count) || 0;
            const purpose = read.purpose ? String(read.purpose) : 'a task';
            const when = read.created_at || '';
            return '<li class="c4-row c4-row-flat"><span class="c4-row-dot c4-dot-skip" aria-hidden="true"></span>'
                + '<span class="c4-row-label">' + esc(actor) + ' read ' + count + (count === 1 ? ' note' : ' notes') + '</span>'
                + '<span class="c4-row-note">for ' + esc(purpose) + ' · <time datetime="' + esc(when) + '">' + esc(agoOf(when)) + '</time></span></li>';
        }).join('');
        return '<section class="c4-card">'
            + '<p class="c4-sub">The agents that read your notes. The list says how many notes each one took, never what they said.</p>'
            + '<ul class="c4-rows">' + rows + '</ul></section>';
    }

    /* ── Memory M5: services, the shared stores and the portable file ─────────────────────────────────── */

    /** mem0, Letta and Zep: connect (with the person's own key), sync, forget. The key is never shown back. */
    async function servicesPanel(req, res) {
        let providers = [];
        let problem = null;
        try {
            const out = await withToken(req, res, (token) => memory.services(token));
            providers = Array.isArray(out.providers) ? out.providers : [];
        } catch (e) { problem = e; }
        if (problem) return '<section class="c4-card c4-empty"><h2>Services</h2><p>' + esc(problemWord(problem)) + '</p></section>';
        const intro = '<p class="c4-hint">Connect a memory service with your own key. OpenVibe keeps the key sealed on the server, '
            + 'shows only its last four characters, and reads the service only when you press Sync. The key is never written into a page or a log.</p>';
        const cards = providers.map((p) => {
            const connected = !!p.connected;
            const state = !connected ? 'Not connected' : (p.status === 'failing' ? 'Key needs attention' : p.status === 'ok' ? 'Connected' : 'Saved, not tested');
            const hint = connected && p.hint ? ' · key ending ' + esc(String(p.hint)) : '';
            const when = p.last_sync_at ? ' · last sync ' + esc(agoOf(p.last_sync_at)) + ' (' + (Number(p.last_sync_count) || 0) + ' found)' : '';
            const error = p.last_error ? '<p class="c4-note-meta">' + esc(String(p.last_error).slice(0, 200)) + '</p>' : '';
            const fields = '<label class="c4-field"><span>Key</span><input type="password" name="key" autocomplete="off" spellcheck="false" '
                + (connected ? 'placeholder="Leave empty to keep the saved key"' : 'required') + '></label>'
                + '<label class="c4-field"><span>Address (optional)</span><input type="url" name="base_url" value="' + esc(p.base_url || '') + '" placeholder="' + esc(p.default_base_url || '') + '"></label>'
                + '<label class="c4-field"><span>Account or agent (optional)</span><input type="text" name="account" value="' + esc(p.account || '') + '"></label>';
            const connect = '<form method="post" action="/memory/services/' + esc(p.provider) + '">'
                + '<input type="hidden" name="tab" value="services">' + fields
                + '<button class="c4-button" type="submit">' + (connected ? 'Save and test again' : 'Save and test') + '</button></form>';
            const actions = connected
                ? '<form method="post" action="/memory/services/' + esc(p.provider) + '/sync"><input type="hidden" name="tab" value="services">'
                    + '<button class="c4-button c4-button-quiet" type="submit">Sync now</button></form>'
                    + '<form method="post" action="/memory/services/' + esc(p.provider) + '/disconnect"><input type="hidden" name="tab" value="services">'
                    + '<button class="c4-button c4-button-danger" type="submit">Forget the key</button></form>'
                : '';
            return '<section class="c4-card"><div class="c4-card-head"><h2>' + esc(p.name || p.provider) + '</h2>'
                + '<span class="c4-chip">' + esc(state + hint + when) + '</span></div>'
                + '<p class="c4-sub">' + esc(p.docs || '') + '</p>' + error + connect + actions + '</section>';
        }).join('');
        return '<section class="c4-card c4-empty"><h2>Memory services</h2>' + intro + '</section>' + cards;
    }

    /** The store another person shared, read-only, and the gate when this reader is not on its list. */
    async function sharedPanel(req, res, owner) {
        const me = viewer(req);
        if (owner) {
            if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(owner)) {
                return '<section class="c4-card c4-empty"><h2>Shared</h2><p>That store could not be found.</p></section>';
            }
            if (me && owner === me) return '<section class="c4-card c4-empty"><h2>That is your own memory</h2><p>Open Notes to see it. Share it with the Share button at the top.</p></section>';
            let out = null;
            let problem = null;
            try { out = await withToken(req, res, (token) => memory.sharedStore(token, owner)); }
            catch (e) { problem = e; }
            if (problem) {
                if (String(problem.code || '') !== 'memory.not_found') {
                    return '<section class="c4-card c4-empty"><h2>Shared</h2><p>' + esc(problemWord(problem)) + '</p></section>';
                }
                // Specific people, and this reader is not on the list: the audience, never a note. The gate draws
                // itself from this markup and asks for access through the same proxied share routes.
                const signInUrl = me ? '' : '/auth/login?next=' + encodeURIComponent('/memory?tab=shared&owner=' + owner);
                return '<section class="c4-card c4-empty"><h2>This memory is shared with specific people</h2>'
                    + '<div id="memory-gate" data-ov-share-gate data-kind="memory-store" data-id="' + esc(owner) + '" data-signed-in-as="' + esc(me ? (req.viewer.username || me) : '') + '" data-sign-in-url="' + esc(signInUrl) + '">'
                    + 'This is shared with specific people. Sign in with the OpenVibe account it was shared with, or ask its owner for access.</div></section>';
            }
            const rows = (out.items || []).map((item) => '<li class="c4-row c4-row-flat">'
                + '<span class="c4-row-dot c4-dot-ok" aria-hidden="true"></span>'
                + '<span class="c4-row-label">' + esc(item.text) + '</span>'
                + '<span class="c4-row-note">' + esc(scopeName(item.scope)) + ' · ' + esc(kindName(item.kind)) + ' · from ' + esc(sourceName(item.source)) + '</span></li>').join('');
            return '<section class="c4-card"><div class="c4-card-head"><h2>A shared memory</h2><span class="c4-chip">read-only</span></div>'
                + '<p class="c4-sub">Its owner shared it with specific people. You can read it; only the owner can change or share it.</p>'
                + (rows ? '<ul class="c4-rows">' + rows + '</ul>' : '<p class="c4-hint">This store has no active notes yet.</p>') + '</section>';
        }
        let stores = [];
        let problem = null;
        try {
            const out = await withToken(req, res, (token) => memory.shared(token));
            stores = Array.isArray(out.stores) ? out.stores : [];
        } catch (e) { problem = e; }
        if (problem) return '<section class="c4-card c4-empty"><h2>Shared</h2><p>' + esc(problemWord(problem)) + '</p></section>';
        if (!stores.length) {
            return '<section class="c4-card c4-empty"><h2>Nothing has been shared with you</h2>'
                + '<p>When someone shares their memory with you, it appears here as a read-only store.</p></section>';
        }
        const rows = stores.map((s) => '<li class="c4-row"><span class="c4-row-dot c4-dot-ok" aria-hidden="true"></span>'
            + '<span class="c4-row-label"><a href="/memory?tab=shared&amp;owner=' + esc(s.owner) + '">A memory store</a></span>'
            + '<span class="c4-row-note">' + esc(s.role || 'viewer') + ' · shared ' + esc(agoOf(s.shared_at)) + '</span></li>').join('');
        return '<section class="c4-card"><div class="c4-card-head"><h2>Shared with me</h2></div>'
            + '<p class="c4-sub">Read-only stores other people shared with you. They never appear in your own notes.</p>'
            + '<ul class="c4-rows">' + rows + '</ul></section>';
    }

    /** The portable file: download it, or paste/choose one to import. One documented JSON format. */
    function exportPanel() {
        return '<section class="c4-card"><div class="c4-card-head"><h2>Your portable file</h2></div>'
            + '<p class="c4-sub">One JSON file with every note, its kind, its scope, its source and its confidence. '
            + 'It carries no account id, no note id and no conflict link, so you can import it into another OpenVibe account. '
            + 'The JSON is redacted again when it is imported, and a summary is rebuilt from the notes, never imported.</p>'
            + '<p><a class="c4-button" href="/memory/export" download>Download memory.json</a></p></section>'
            + '<section class="c4-card"><div class="c4-card-head"><h2>Import a portable file</h2></div>'
            + '<p class="c4-sub">Choose the file or paste its JSON. Notes that say the same thing as one you already have are merged, not copied.</p>'
            + '<form method="post" action="/memory/import"><input type="hidden" name="tab" value="export">'
            + '<label class="c4-field"><span>File</span><input type="file" id="memory-import-file" accept="application/json,.json"></label>'
            + '<label class="c4-field"><span>Or paste the JSON</span><textarea id="memory-import-text" name="document" rows="8" spellcheck="false"></textarea></label>'
            + '<button class="c4-button" type="submit">Import</button></form>'
            + '<p class="c4-hint">A file over 25 MB is refused. Nothing is kept until you press Import.</p></section>';
    }

    /** The confirmation page: what one source's removal would take, and the one form that does it. */
    async function removePage(req, res) {
        const source = String(req.query.source || '');
        const head = header('Memory', 'What your assistants know about you, in one place.');
        if (!viewer(req)) return page(req, res, 'Memory', wrap(head + signIn(req)));
        if (!SOURCE_ID.test(source)) return res.redirect(303, '/memory?tab=notes');
        let items = [];
        try {
            const out = await withToken(req, res, (token) => memory.items(token, {}));
            items = Array.isArray(out.items) ? out.items : [];
        } catch (e) { items = []; }
        const row = sourceRows(items).find((r) => r.id === source);
        const count = row ? row.count : 0;
        const name = sourceName(source);
        const content = header('Remove ' + name, 'What this takes away, before it does.')
            + '<section class="c4-card"><div class="c4-card-head"><h2>All ' + count + (count === 1 ? ' note' : ' notes') + ' from ' + esc(name) + '</h2></div>'
            + '<p>These notes are deleted from your memory store. Your files on your computer are not touched: your other tools keep them, '
            + 'and the next upload brings them back.</p>'
            + '<form method="post" action="/memory/remove"><input type="hidden" name="source" value="' + esc(source) + '">'
            + '<input type="hidden" name="tab" value="notes">'
            + '<button class="c4-button c4-button-danger" type="submit">Delete ' + count + (count === 1 ? ' note' : ' notes') + '</button> '
            + '<a class="c4-opill c4-opill-quiet" href="/memory?tab=notes">Keep them</a></form></section>';
        return page(req, res, 'Memory', wrap(content));
    }

    // The writes: every one a same-origin form post, and every answer a redirect back to the tab it came from.
    const refuse = (req, res) => {
        if (!viewer(req)) return res.redirect(303, '/auth/login?next=' + encodeURIComponent('/memory'));
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.');
        return null;
    };

    router.get('/memory', async (req, res) => memoryPage(req, res));
    router.get('/memory/remove', async (req, res) => removePage(req, res));

    /* ── Memory M5: the memory services, the portable file and team sharing ─────────────────────────── */

    // The portable file is decrypted by the store for the person's own token and streamed as a download. It is never
    // cached: the body is the person's own notes.
    router.get('/memory/export', async (req, res) => {
        if (!viewer(req)) return res.redirect(303, '/auth/login?next=' + encodeURIComponent('/memory?tab=export'));
        try {
            const doc = await withToken(req, res, (token) => memory.exportFile(token, String(req.query.scope || '').slice(0, 80) || undefined));
            res.set('Cache-Control', 'private, no-store');
            res.set('Content-Disposition', `attachment; filename="openvibe-memory-${new Date().toISOString().slice(0, 10)}.json"`);
            return res.type('application/json').send(JSON.stringify(doc));
        } catch (e) {
            return back(req, res, 'export', '', problemWord(e));
        }
    });

    // The same document back in. A form body (pasted, or a file the page's own script copied into the textarea) is
    // bounded at 25 MB; the store validates the format, redacts every item again and dedupes by its text MAC.
    router.post('/memory/import', express.urlencoded({ extended: false, limit: '25mb' }), async (req, res) => {
        if (refuse(req, res)) return;
        const raw = String((req.body && req.body.document) || '');
        if (!raw.trim()) return back(req, res, 'export', '', 'Choose a file or paste the JSON first.');
        let doc;
        try { doc = JSON.parse(raw); } catch { return back(req, res, 'export', '', 'That is not JSON. Choose the file the Export tab downloaded.'); }
        try {
            const out = await withToken(req, res, (token) => memory.importFile(token, doc));
            return back(req, res, 'export', 'Imported ' + out.imported + (out.imported === 1 ? ' note' : ' notes')
                + ' (' + out.created + ' new, ' + out.deduped + ' already there' + (out.skipped ? ', ' + out.skipped + ' skipped' : '') + ').');
        } catch (e) {
            return back(req, res, 'export', '', problemWord(e));
        }
    });

    // Connect (or re-test) one service with the person's own key. The store seals it; the page never sees it again.
    router.post('/memory/services/:provider', form, async (req, res) => {
        if (refuse(req, res)) return res;
        const provider = String(req.params.provider || '');
        if (!SERVICES.includes(provider)) return back(req, res, 'services', '', 'No such memory service.');
        const body = req.body || {};
        try {
            const out = await withToken(req, res, (token) => memory.connect(token, provider, {
                ...(String(body.key || '') ? { key: String(body.key) } : {}),
                ...(String(body.base_url || '').trim() ? { base_url: String(body.base_url).trim() } : {}),
                ...(String(body.account || '').trim() ? { account: String(body.account).trim() } : {}),
            }));
            const service = out.service || {};
            if (service.status === 'failing') return back(req, res, 'services', '', 'Saved, but the key test failed: ' + String(service.last_error || 'the service refused it').slice(0, 140));
            return back(req, res, 'services', (service.name || provider) + ' is connected.');
        } catch (e) {
            return back(req, res, 'services', '', problemWord(e));
        }
    });

    // Read the service and put what it has into the store. The answer is counts, never text.
    router.post('/memory/services/:provider/sync', form, async (req, res) => {
        if (refuse(req, res)) return res;
        const provider = String(req.params.provider || '');
        if (!SERVICES.includes(provider)) return back(req, res, 'services', '', 'No such memory service.');
        try {
            const out = await withToken(req, res, (token) => memory.syncService(token, provider));
            return back(req, res, 'services', 'Synced ' + out.imported + (out.imported === 1 ? ' note' : ' notes') + ' from ' + provider
                + (out.deduped ? ' (' + out.deduped + ' already there)' : '') + '.');
        } catch (e) {
            return back(req, res, 'services', '', problemWord(e));
        }
    });

    // Forget the key: the row, and with it the evidence of the key, is deleted.
    router.post('/memory/services/:provider/disconnect', form, async (req, res) => {
        if (refuse(req, res)) return res;
        const provider = String(req.params.provider || '');
        if (!SERVICES.includes(provider)) return back(req, res, 'services', '', 'No such memory service.');
        try {
            await withToken(req, res, (token) => memory.disconnect(token, provider));
            return back(req, res, 'services', provider + ' was forgotten.');
        } catch (e) {
            return back(req, res, 'services', '', problemWord(e));
        }
    });


    // Memory M3: the export is forwarded untouched to the store, which parses, redacts and holds a sealed draft.
    // The answer is shown once; nothing is kept until the person ticks and submits the preview form.
    router.post('/memory/import/preview', importUpload, async (req, res) => {
        if (refuse(req, res)) return;
        if (!Buffer.isBuffer(req.body) || !req.body.length) return back(req, res, 'import', '', 'Choose an export file or paste an answer first.');
        try {
            const out = await withToken(req, res, (token) => memory.preview(token, { body: req.body, contentType: req.get('content-type') || '' }));
            return previewPage(req, res, out);
        } catch (e) {
            return back(req, res, 'import', '', problemWord(e));
        }
    });

    router.post('/memory/import/:id/commit', form, async (req, res) => {
        if (refuse(req, res)) return;
        const id = String(req.params.id || '');
        if (!/^mimp_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return back(req, res, 'import', '', 'That preview is no longer here.');
        const body = req.body || {};
        try {
            if (String(body.action || '') === 'discard') {
                await withToken(req, res, (token) => memory.discard(token, id));
                return back(req, res, 'import', 'Nothing was kept.');
            }
            const keep = body.keep == null ? [] : Array.isArray(body.keep) ? body.keep : [body.keep];
            const out = await withToken(req, res, (token) => memory.commit(token, id, keep));
            return back(req, res, 'import', 'Kept ' + out.kept + (out.kept === 1 ? ' note' : ' notes')
                + (out.left_out ? '; ' + out.left_out + ' left out.' : '.'));
        } catch (e) {
            return back(req, res, 'import', '', problemWord(e));
        }
    });

    router.post('/memory/remove', form, async (req, res) => {
        if (refuse(req, res)) return res;
        const source = String((req.body && req.body.source) || '');
        if (!SOURCE_ID.test(source)) return back(req, res, 'notes', '', 'That source could not be read.');
        try {
            const out = await withToken(req, res, (token) => memory.removeBySource(token, source));
            return back(req, res, 'notes', 'Deleted ' + out.deleted + (out.deleted === 1 ? ' note' : ' notes') + ' from ' + sourceName(source) + '.');
        } catch (e) {
            return back(req, res, 'notes', '', problemWord(e));
        }
    });

    router.post('/memory/items/:id/edit', form, async (req, res) => {
        if (refuse(req, res)) return res;
        const id = String(req.params.id || '');
        if (!NOTE_ID.test(id)) return back(req, res, 'notes', '', 'That note could not be read.');
        const body = req.body || {};
        const text = String(body.text || '').slice(0, 2000);
        const kind = KINDS.includes(body.kind) ? body.kind : null;
        if (!text.trim()) return back(req, res, 'notes', '', 'A note needs a text.');
        try {
            await withToken(req, res, (token) => memory.patch(token, id, { text, ...(kind ? { kind } : {}) }));
            return back(req, res, 'notes', 'The note is saved.');
        } catch (e) {
            return back(req, res, 'notes', '', problemWord(e));
        }
    });

    router.post('/memory/items/:id/archive', form, async (req, res) => {
        if (refuse(req, res)) return res;
        const id = String(req.params.id || '');
        if (!NOTE_ID.test(id)) return back(req, res, 'notes', '', 'That note could not be read.');
        try {
            await withToken(req, res, (token) => memory.patch(token, id, { status: 'archived' }));
            return back(req, res, 'notes', 'The note is archived.');
        } catch (e) {
            return back(req, res, 'notes', '', problemWord(e));
        }
    });

    router.post('/memory/items/:id/split', form, async (req, res) => {
        if (refuse(req, res)) return res;
        const id = String(req.params.id || '');
        if (!NOTE_ID.test(id)) return back(req, res, 'notes', '', 'That note could not be read.');
        try {
            const out = await withToken(req, res, (token) => memory.split(token, id));
            return back(req, res, 'notes', 'The notes are apart again: ' + out.split + '.');
        } catch (e) {
            return back(req, res, 'notes', '', problemWord(e));
        }
    });

    router.post('/memory/items/:id/delete', form, async (req, res) => {
        if (refuse(req, res)) return res;
        const id = String(req.params.id || '');
        if (!NOTE_ID.test(id)) return back(req, res, 'notes', '', 'That note could not be read.');
        try {
            await withToken(req, res, (token) => memory.remove(token, id));
            return back(req, res, 'notes', 'The note is gone.');
        } catch (e) {
            return back(req, res, 'notes', '', problemWord(e));
        }
    });

    router.post('/memory/items/:id/accept', form, async (req, res) => {
        if (refuse(req, res)) return res;
        const id = String(req.params.id || '');
        if (!NOTE_ID.test(id)) return back(req, res, 'suggested', '', 'That note could not be read.');
        try {
            await withToken(req, res, (token) => memory.patch(token, id, { status: 'active' }));
            return back(req, res, 'suggested', 'The note is kept.');
        } catch (e) {
            return back(req, res, 'suggested', '', problemWord(e));
        }
    });

    router.post('/memory/items/:id/decline', form, async (req, res) => {
        if (refuse(req, res)) return res;
        const id = String(req.params.id || '');
        if (!NOTE_ID.test(id)) return back(req, res, 'suggested', '', 'That note could not be read.');
        try {
            await withToken(req, res, (token) => memory.patch(token, id, { status: 'archived' }));
            return back(req, res, 'suggested', 'The suggestion was declined.');
        } catch (e) {
            return back(req, res, 'suggested', '', problemWord(e));
        }
    });

    router.post('/memory/conflicts/:id/settle', form, async (req, res) => {
        if (refuse(req, res)) return res;
        const id = String(req.params.id || '');
        const keep = String((req.body && req.body.keep) || '');
        if (!NOTE_ID.test(id) || !NOTE_ID.test(keep)) return back(req, res, 'disagree', '', 'Those two notes could not be read.');
        try {
            await withToken(req, res, (token) => memory.settle(token, id, keep));
            return back(req, res, 'disagree', 'The note you kept is the one that stays.');
        } catch (e) {
            return back(req, res, 'disagree', '', problemWord(e));
        }
    });

    return router;
}

/** The pairs that disagree: each note with the one it conflicts with, once. */
function conflictPairs(conflicts) {
    const out = [];
    const seen = new Set();
    for (const item of conflicts || []) {
        const other = (conflicts || []).find((x) => x.id === item.conflict_with);
        if (!other) continue;
        const key = [item.id, other.id].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push([item, other]);
    }
    return out;
}

/** The sources of the person's notes: how many notes each one has and when it was last seen. */
function sourceRows(items) {
    const rows = new Map();
    for (const item of items || []) {
        const list = Array.isArray(item.sources) && item.sources.length ? item.sources : [item.source];
        for (const raw of list) {
            const id = String(raw || '').trim();
            if (!id) continue;
            const row = rows.get(id) || { id, count: 0, seen: 0 };
            row.count += 1;
            const seen = Date.parse(String(item.seen_at || item.updated_at || '')) || 0;
            if (seen > row.seen) row.seen = seen;
            rows.set(id, row);
        }
    }
    // The most recent source first: a phone shows the three most recent ones.
    return [...rows.values()].sort((a, b) => b.seen - a.seen || b.count - a.count);
}

module.exports = { createMemoryRoutes, SOURCE_NAMES, KINDS, sourceName, scopeName, dayOf, agoOf };
