'use strict';

/**
 * The Memory page (OpenVibe Memory M2b): what the person's own assistants know about them.
 *
 * The notes live in OpenVibe.AI's memory store, sealed there and opened only by the person's own token. This
 * page never holds a note: it forwards the person's token to the store (server/domain/memory.js), renders what
 * comes back and forgets it. The token is never written into the page, and no note text is ever logged.
 *
 *   GET  /memory             the page: the sources, then one tab (notes, disagree, suggested, profile, reads)
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

const { asyncRouter } = require('./router');
const { esc } = require('../render/html');

/** The adapter ids the Node reads and the services that write, and the names a person knows them by. */
const SOURCE_NAMES = {
    'claude-code': 'Claude Code', agents: 'AGENTS.md', gemini: 'Gemini CLI', cursor: 'Cursor',
    copilot: 'GitHub Copilot', windsurf: 'Windsurf', cline: 'Cline', roo: 'Roo Code', kiro: 'Kiro',
    continue: 'Continue', aider: 'Aider', 'command-code': 'Command Code', opencode: 'OpenCode',
    actor: 'Actor', vibe: 'Vibe', know: 'Know', person: 'You', codes: 'Codes', codex: 'Codex',
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
    ['profile', 'Profile'], ['reads', 'Who read it'],
];

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
        const head = header(title, 'What your assistants know about you, in one place.');
        if (!viewer(req)) return page(req, res, title, wrap(head + signIn(req)));
        const asked = String(req.query.tab || '');
        const tab = MEMORY_TABS.some(([id]) => id === asked) ? asked : 'notes';
        const q = String(req.query.q || '').slice(0, 200);
        const scope = String(req.query.scope || '').slice(0, 80);

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

        const content = head + flash(req)
            + (problem ? note('Your memory could not be read right now. ' + problemWord(problem), 'bad') : '')
            + sourcesPanel(sources) + tabs + panel;
        return page(req, res, title, wrap(content));
    }

    /** The sources card: where the notes came from, how many there are and when they were last seen. */
    function sourcesPanel(rows) {
        const head = '<section class="c4-card"><div class="c4-card-head"><h2>Sources</h2><span class="c4-muted">'
            + rows.length + (rows.length === 1 ? ' source' : ' sources') + '</span></div>';
        if (!rows.length) {
            return head + '<div class="c4-emptyline">Nothing here yet. On your computer, run '
                + '<code class="c4-code-inline">openvibe-node memory upload</code>: it shows what it found and asks before sending anything. '
                + '<a href="https://github.com/OpenVibers/OpenVibe.Node/blob/main/docs/memory.md#the-upload">The Node docs</a></div></section>';
        }
        const list = rows.map((row) => {
            const fresh = row.seen && Date.now() - row.seen < SEVEN_DAYS;
            const seen = row.seen ? agoOf(new Date(row.seen).toISOString()) : 'never';
            return '<li class="c4-row c4-row-flat c4-source"><span class="c4-row-dot c4-dot-' + (fresh ? 'ok' : 'skip') + '" aria-hidden="true"></span>'
                + '<span class="c4-row-label">' + esc(sourceName(row.id)) + '</span>'
                + '<span class="c4-row-note">' + row.count + (row.count === 1 ? ' note' : ' notes') + ' · seen ' + esc(seen) + '</span>'
                + '<a class="c4-opill c4-opill-quiet" href="/memory/remove?source=' + encodeURIComponent(row.id) + '">Remove…</a></li>';
        }).join('');
        return head + '<ul class="c4-rows">' + list + '</ul></section>';
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
            + '<label for="memory-search">Search your notes</label>'
            + '<input id="memory-search" name="q" value="' + esc(q) + '" placeholder="Search your notes" maxlength="200">'
            + '<button class="c4-button c4-button-light">Search</button></form>';
        const body = notes.length
            ? '<ul class="c4-rows">' + notes.map((item) => noteRow(item, merged.has(item.id))).join('') + '</ul>'
            : '<div class="c4-emptyline">' + (q || scope ? 'No note matches. <a href="/memory?tab=notes">Show all</a>' : 'No notes yet.') + '</div>';
        return '<section class="c4-card"><div class="c4-card-head"><h2>Notes</h2><span class="c4-muted">' + notes.length + '</span></div>'
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
            + '<form method="post" action="/memory/items/' + id + '/delete"><input type="hidden" name="tab" value="notes"><button class="c4-opill c4-opill-quiet" type="submit">Delete</button></form>'
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
        return '<section class="c4-card"><div class="c4-card-head"><h2>Suggested</h2><span class="c4-muted">' + items.length + '</span></div>'
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
        return '<section class="c4-card"><div class="c4-card-head"><h2>Who read it</h2><span class="c4-muted">' + reads.length + '</span></div>'
            + '<p class="c4-sub">The agents that read your notes. The list says how many notes each one took, never what they said.</p>'
            + '<ul class="c4-rows">' + rows + '</ul></section>';
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
            + '<button class="c4-button" type="submit">Delete ' + count + (count === 1 ? ' note' : ' notes') + '</button> '
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
    return [...rows.values()].sort((a, b) => b.count - a.count || b.seen - a.seen);
}

module.exports = { createMemoryRoutes, SOURCE_NAMES, KINDS, sourceName, scopeName, dayOf, agoOf };
