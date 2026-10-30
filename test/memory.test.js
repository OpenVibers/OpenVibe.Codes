'use strict';
// The Memory page (OpenVibe Memory M2b): the person's own notes, in Codes' kit. The store here is a stand-in for
// OpenVibe.AI's memory store: it records every call, so a test can see which route the page used and whose token
// it carried.
const http = require('http');
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const id = (n) => 'mem_' + String(n).padStart(26, '0');
const WHEN = new Date(Date.now() - 36e5).toISOString();

/** A stand-in for the store: 40 notes, one merged pair, 2 conflicts, 3 suggestions and 3 reads. */
async function startStore() {
    const calls = [];
    const items = [];
    for (let i = 0; i < 40; i++) {
        items.push({
            id: id(i + 1), text: 'Note number ' + (i + 1) + ' about how the person works',
            kind: i % 3 === 0 ? 'preference' : 'fact', scope: i % 5 === 0 ? 'project:demo' : 'user',
            source: ['claude-code', 'cursor', 'agents'][i % 3], sources: ['claude-code', 'cursor', 'agents'][i % 3],
            status: 'active', confidence: 0.9, seen_at: WHEN, created_at: WHEN, updated_at: WHEN,
            merged_into: null, conflict_with: null,
        });
    }
    // One note that swallowed another one (the store keeps the swallowed note archived).
    items[0].sources = ['claude-code', 'cursor'];
    items.push({
        id: id(90), text: 'The note that was merged into another one', kind: 'fact', scope: 'user',
        source: 'cursor', sources: ['cursor'], status: 'archived', confidence: 0.8,
        seen_at: WHEN, created_at: WHEN, updated_at: WHEN, merged_into: id(1), conflict_with: null,
    });
    // Two pairs that disagree.
    for (let p = 0; p < 2; p++) {
        const a = id(100 + p * 2);
        const b = id(101 + p * 2);
        items.push({
            id: a, text: 'The person prefers tabs ' + (p + 1), kind: 'preference', scope: 'user',
            source: 'claude-code', sources: ['claude-code'], status: 'conflict', confidence: 0.7,
            seen_at: WHEN, created_at: WHEN, updated_at: WHEN, merged_into: null, conflict_with: b,
        });
        items.push({
            id: b, text: 'The person prefers spaces ' + (p + 1), kind: 'preference', scope: 'user',
            source: 'cursor', sources: ['cursor'], status: 'conflict', confidence: 0.7,
            seen_at: WHEN, created_at: WHEN, updated_at: WHEN, merged_into: null, conflict_with: a,
        });
    }
    // Three suggestions.
    for (let s = 0; s < 3; s++) {
        items.push({
            id: id(120 + s), text: 'A suggested note ' + (s + 1), kind: 'fact', scope: 'user',
            source: 'actor', sources: ['actor'], status: 'suggested', confidence: 0.6,
            seen_at: WHEN, created_at: WHEN, updated_at: WHEN, merged_into: null, conflict_with: null,
        });
    }
    const reads = [
        { id: 'rd_1', actor: 'svc:actor', purpose: 'task-9', scopes: ['user'], count: 3, created_at: WHEN },
        { id: 'rd_2', actor: 'svc:codes', purpose: 'the memory page', scopes: ['user'], count: 12, created_at: WHEN },
        { id: 'rd_3', actor: 'svc:vibe', purpose: 'a question', scopes: ['project:demo'], count: 1, created_at: WHEN },
    ];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const url = new URL(req.url, 'http://store');
            const call = { method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization || '', body: raw ? JSON.parse(raw) : null };
            calls.push(call);
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (!/^Bearer /.test(call.auth)) return json(401, { code: 'auth.denied', detail: 'no token' });
            if (call.method === 'GET' && url.pathname === '/api/v1/memory/items') return json(200, { items, count: items.length });
            if (call.method === 'GET' && url.pathname === '/api/v1/memory/profile') return json(200, { profile: { scope: url.searchParams.get('scope') || 'user', text: 'The person works in short bursts and prefers tabs.', built_at: WHEN } });
            if (call.method === 'GET' && url.pathname === '/api/v1/memory/reads') return json(200, { reads, count: reads.length });
            if (call.method === 'PATCH' && url.pathname.startsWith('/api/v1/memory/items/')) return json(200, { item: { id: url.pathname.split('/').pop(), ...(call.body || {}) } });
            if (call.method === 'DELETE' && url.pathname.startsWith('/api/v1/memory/items/')) return json(200, { deleted: 1 });
            if (call.method === 'DELETE' && url.pathname === '/api/v1/memory/items') return json(200, { deleted: 41 });
            if (call.method === 'POST' && url.pathname.endsWith('/split')) return json(200, { items: [], count: 2, split: 2 });
            if (call.method === 'POST' && url.pathname.endsWith('/settle')) return json(200, { kept: { id: 'kept' }, archived: { id: 'archived' } });
            return json(404, { code: 'memory.not_found', detail: 'no such route' });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return {
        url: 'http://127.0.0.1:' + server.address().port, calls, items, reads,
        close: () => new Promise((r) => server.close(r)),
        last: (method, part) => [...calls].reverse().find((c) => c.method === method && c.path.includes(part)),
    };
}

(async () => {
await check('a signed-out visitor is asked to sign in, and sees no note', async () => {
    const h = await boot();
    try {
        const res = await h.get('/memory');
        assert.equal(res.status, 200);
        assert.ok(res.text.includes('Sign in to see your work'), 'the sign-in card');
        assert.ok(!res.text.includes('Note number'), 'no note');
    } finally { await h.close(); }
});

await check('every tab renders its own view, and the bar counts the others', async () => {
    const store = await startStore();
    const h = await boot({ env: { CODES_AI_INTERNAL_URL: store.url } });
    try {
        const user = h.network.addUser('maria');
        const notes = await h.get('/memory?tab=notes', { as: user });
        assert.equal(notes.status, 200);
        assert.ok(notes.text.includes('Note number 1 about how the person works'), 'a note');
        assert.ok(notes.text.includes('Notes (40)'), 'the notes count');
        assert.ok(notes.text.includes('Disagree (2)'), 'the conflicts count');
        assert.ok(notes.text.includes('Suggested (3)'), 'the suggestions count');
        assert.ok(notes.text.includes('name="q"'), 'the search field');
        assert.ok(notes.text.includes('scope=user'), 'the scope chips');
        assert.ok(notes.text.includes('Claude Code'), 'a source name');

        const disagree = await h.get('/memory?tab=disagree', { as: user });
        assert.ok(disagree.text.includes('These two disagree'), 'the conflict card');
        assert.ok(disagree.text.includes('Keep this one'), 'the keep button');
        assert.ok(!disagree.text.includes('Note number 1 about how the person works'), 'only the open tab is built');

        const suggested = await h.get('/memory?tab=suggested', { as: user });
        assert.ok(suggested.text.includes('A suggested note 1'), 'a suggestion');
        assert.ok(suggested.text.includes('Suggested by Actor'), 'the agent name');
        assert.ok(suggested.text.includes('Accept') && suggested.text.includes('Decline'), 'the buttons');

        const profile = await h.get('/memory?tab=profile', { as: user });
        assert.ok(profile.text.includes('The person works in short bursts'), 'the summary');
        assert.ok(profile.text.includes('Built from'), 'the count of notes');
        assert.ok(profile.text.includes('at most once an hour'), 'the rebuild note');

        const reads = await h.get('/memory?tab=reads', { as: user });
        assert.ok(reads.text.includes('Actor read 3 notes'), 'a read');
        assert.ok(reads.text.includes('for task-9'), 'the purpose');
        assert.ok(!reads.text.includes('Note number'), 'the reads carry no text');
    } finally { await h.close(); await store.close(); }
});

await check('the page never carries the person token, and no note text reaches the logs', async () => {
    const store = await startStore();
    const h = await boot({ env: { CODES_AI_INTERNAL_URL: store.url } });
    try {
        const user = h.network.addUser('maria');
        const token = h.network.userToken(user);
        const res = await h.get('/memory?tab=notes', { as: user });
        assert.ok(!res.text.includes(token), 'no token in the page');
        assert.ok(!res.text.includes('Bearer '), 'no bearer in the page');
        assert.ok(!h.logs().includes('Note number 1 about'), 'no note text in the logs');
        assert.ok(!h.logs().includes(token), 'no token in the logs');
    } finally { await h.close(); await store.close(); }
});

await check('every form calls the right store route with the person own token, and answers with a flash', async () => {
    const store = await startStore();
    const h = await boot({ env: { CODES_AI_INTERNAL_URL: store.url } });
    try {
        const user = h.network.addUser('maria');
        const token = h.network.userToken(user);
        const note = id(1);

        const edit = await h.get('/memory/items/' + note + '/edit', { as: user, method: 'POST', form: { text: 'A new text', kind: 'decision', tab: 'notes' } });
        assert.equal(edit.status, 303);
        assert.ok(edit.headers.get('location').includes('/memory?tab=notes'), 'back to the tab');
        const patched = store.last('PATCH', note);
        assert.ok(patched, 'the store was asked to patch');
        assert.equal(patched.path, '/api/v1/memory/items/' + note);
        assert.equal(patched.auth, 'Bearer ' + token, 'the person own token');
        assert.equal(patched.body.text, 'A new text');
        assert.equal(patched.body.kind, 'decision');

        const archive = await h.get('/memory/items/' + note + '/archive', { as: user, method: 'POST', form: { tab: 'notes' } });
        assert.equal(archive.status, 303);
        assert.equal(store.last('PATCH', note).body.status, 'archived');

        const split = await h.get('/memory/items/' + note + '/split', { as: user, method: 'POST', form: { tab: 'notes' } });
        assert.equal(split.status, 303);
        assert.ok(store.last('POST', '/split'), 'the store was asked to split');

        const del = await h.get('/memory/items/' + note + '/delete', { as: user, method: 'POST', form: { tab: 'notes' } });
        assert.equal(del.status, 303);
        assert.equal(store.last('DELETE', note).method, 'DELETE');

        const accept = await h.get('/memory/items/' + id(120) + '/accept', { as: user, method: 'POST', form: { tab: 'suggested' } });
        assert.equal(accept.status, 303);
        assert.ok(accept.headers.get('location').includes('tab=suggested'), 'back to the suggestions');
        assert.equal(store.last('PATCH', id(120)).body.status, 'active');

        const decline = await h.get('/memory/items/' + id(121) + '/decline', { as: user, method: 'POST', form: { tab: 'suggested' } });
        assert.equal(decline.status, 303);
        assert.equal(store.last('PATCH', id(121)).body.status, 'archived');

        const settle = await h.get('/memory/conflicts/' + id(100) + '/settle', { as: user, method: 'POST', form: { keep: id(101), tab: 'disagree' } });
        assert.equal(settle.status, 303);
        const settled = store.last('POST', '/settle');
        assert.equal(settled.path, '/api/v1/memory/items/' + id(100) + '/settle');
        assert.equal(settled.body.keep, id(101));
        assert.equal(settled.auth, 'Bearer ' + token);

        // The flash says what happened, and the page it goes back to is the tab it came from.
        const back = await h.get('/memory?tab=suggested&ok=' + encodeURIComponent('The note is kept.'), { as: user });
        assert.ok(back.text.includes('The note is kept.'), 'the flash');
    } finally { await h.close(); await store.close(); }
});

await check('the remove page says what goes, and the one form takes it away', async () => {
    const store = await startStore();
    const h = await boot({ env: { CODES_AI_INTERNAL_URL: store.url } });
    try {
        const user = h.network.addUser('maria');
        const page = await h.get('/memory/remove?source=claude-code', { as: user });
        assert.equal(page.status, 200);
        assert.ok(page.text.includes('notes from Claude Code'), 'what goes');
        assert.ok(page.text.includes('Your files on your computer are not touched'), 'what does not');
        assert.equal((page.text.match(/<form[^>]*method="post"/g) || []).length, 1, 'exactly one form');
        assert.ok(page.text.includes('action="/memory/remove"'), 'the form');

        const done = await h.get('/memory/remove', { as: user, method: 'POST', form: { source: 'claude-code', tab: 'notes' } });
        assert.equal(done.status, 303);
        const call = store.last('DELETE', '/api/v1/memory/items');
        assert.ok(call, 'the store was asked to delete');
        assert.ok(call.query.includes('source=claude-code'), 'by source');
        assert.equal(call.auth, 'Bearer ' + h.network.userToken(user));
    } finally { await h.close(); await store.close(); }
});

await check('an empty store shows the empty state and how to fill it', async () => {
    const store = await startStore();
    store.items.length = 0;
    const h = await boot({ env: { CODES_AI_INTERNAL_URL: store.url } });
    try {
        const user = h.network.addUser('maria');
        const res = await h.get('/memory', { as: user });
        assert.equal(res.status, 200);
        assert.ok(res.text.includes('Nothing here yet'), 'the empty line');
        assert.ok(res.text.includes('openvibe-node memory upload'), 'the command');
        assert.ok(res.text.includes('docs/memory.md'), 'the docs');
    } finally { await h.close(); await store.close(); }
});

await check('a cross-site post is refused, and a note id that is not a note never reaches the store', async () => {
    const store = await startStore();
    const h = await boot({ env: { CODES_AI_INTERNAL_URL: store.url } });
    try {
        const user = h.network.addUser('maria');
        const cross = await h.get('/memory/items/' + id(1) + '/archive', { as: user, method: 'POST', form: { tab: 'notes' }, headers: { origin: 'https://evil.example' } });
        assert.equal(cross.status, 403);
        assert.equal(store.calls.length, 0, 'the store was never asked');

        const odd = await h.get('/memory/items/not-a-note/delete', { as: user, method: 'POST', form: { tab: 'notes' } });
        assert.equal(odd.status, 303);
        assert.equal(store.calls.length, 0, 'the store was never asked');
    } finally { await h.close(); await store.close(); }
});

done();
})().catch((e) => { console.error(e); process.exit(1); });
