'use strict';
/**
 * Memory M5 on Codes: the memory-service cards, the portable file, the shared stores and the gate, and the Share
 * sheet's proxy to AI. The store is a local stand-in that records every call, so the test can see the route, the
 * person's token and the body; nothing reaches a real provider.
 */
const http = require('http');
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const WHEN = new Date(Date.now() - 36e5).toISOString();
const A = 'usr_01JZ0000000000000000000AAA';
// Built from parts so a source scanner does not read the fixture as a real key.
const MEM0_KEY = ['mem0', 'key', '0123456789'].join('-');

async function startStore() {
    const calls = [];
    const items = [
        { id: 'mem_01JZ0000000000000000000001', text: 'A shared note about deploys.', kind: 'procedure', scope: 'user', source: 'claude-code', status: 'active', confidence: 1, seen_at: WHEN, created_at: WHEN, updated_at: WHEN },
        { id: 'mem_01JZ0000000000000000000002', text: 'Another shared note.', kind: 'fact', scope: 'project:demo', source: 'cursor', status: 'active', confidence: 0.8, seen_at: WHEN, created_at: WHEN, updated_at: WHEN },
    ];
    const providers = ['mem0', 'letta', 'zep'].map((id, i) => ({
        provider: id, name: { mem0: 'mem0', letta: 'Letta', zep: 'Zep' }[id], docs: `https://example.test/${id}`,
        default_base_url: `https://api.${id}.example`, connected: i === 0, hint: i === 0 ? '6789' : null,
        base_url: null, account: null, status: i === 0 ? 'ok' : 'untested', checked_at: i === 0 ? WHEN : null,
        last_error: null, last_sync_at: i === 0 ? WHEN : null, last_sync_count: i === 0 ? 4 : 0,
    }));
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const url = new URL(req.url, 'http://store');
            let parsed = null;
            try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
            const call = { method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization || '', headers: req.headers, body: parsed, raw };
            calls.push(call);
            const json = (status, obj, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
            if (url.pathname.startsWith('/api/v1/memory-store/')) {
                if (!/^Bearer /.test(call.auth)) return json(401, { code: 'token.invalid', error: 'no token' });
                if (req.method === 'GET') return json(200, { audience: 'people', revision: 3, members: [], audiences: ['public', 'link', 'people', 'private'], roles: ['viewer'] }, { ETag: '"rev-3"', 'Cache-Control': 'private, no-store' });
                return json(200, { audience: 'people', revision: 4, members: [{ subject: { type: 'user', id: 'usr_01JZ0000000000000000000BBB' }, role: 'viewer', username: 'bo' }] }, { ETag: '"rev-4"', 'Cache-Control': 'private, no-store' });
            }
            if (!/^Bearer /.test(call.auth)) return json(401, { code: 'token.invalid', error: 'no token' });
            if (req.method === 'GET' && url.pathname === '/api/v1/memory/items') return json(200, { items: [items[0]], count: 1 });
            if (req.method === 'GET' && url.pathname === '/api/v1/memory/services') return json(200, { providers });
            if (req.method === 'PUT' && url.pathname.startsWith('/api/v1/memory/services/')) {
                assert.ok(call.body && call.body.key, 'the key reached the store');
                return json(200, { service: { provider: 'mem0', name: 'mem0', hint: String(call.body.key).slice(-4), status: 'ok', checked_at: WHEN, last_sync_at: null, last_sync_count: 0 } });
            }
            if (req.method === 'POST' && url.pathname === '/api/v1/memory/services/mem0/sync') return json(200, { provider: 'mem0', found: 4, imported: 3, deduped: 1, skipped: 0 });
            if (req.method === 'DELETE' && url.pathname === '/api/v1/memory/services/mem0') return json(200, { removed: 1 });
            if (req.method === 'GET' && url.pathname === '/api/v1/memory/shared') return json(200, { stores: [{ owner: A, audience: 'people', role: 'viewer', shared_at: WHEN }] });
            if (req.method === 'GET' && url.pathname === `/api/v1/memory/stores/${A}`) {
                if (server.gate) return json(404, { code: 'memory.not_found', detail: 'no such shared store' });
                return json(200, { owner: A, items, count: 2 });
            }
            if (req.method === 'GET' && url.pathname === '/api/v1/memory/export') {
                return json(200, { format: 'openvibe.memory-export@1', version: 1, exported_at: WHEN, items: [{ text: 'A portable note.', kind: 'fact', scope: 'user', source: 'person' }] }, { 'Cache-Control': 'no-store' });
            }
            if (req.method === 'POST' && url.pathname === '/api/v1/memory/import') {
                assert.strictEqual(call.body && call.body.format, 'openvibe.memory-export@1', 'the document reached the store');
                return json(200, { imported: 2, created: 1, deduped: 1, skipped: 0 });
            }
            return json(404, { code: 'memory.not_found', detail: 'no such route' });
        });
    });
    server.gate = false;
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return {
        url: 'http://127.0.0.1:' + server.address().port, calls, items, providers,
        set gate(v) { server.gate = v; },
        close: () => new Promise((r) => server.close(r)),
        last: (method, part) => [...calls].reverse().find((c) => c.method === method && c.path.includes(part)),
    };
}

(async () => {
await check('the Services tab lists mem0, Letta and Zep, and connect/sync/forget go to the store with the person token', async () => {
    const store = await startStore();
    const h = await boot({ env: { CODES_AI_INTERNAL_URL: store.url } });
    try {
        const user = h.network.addUser('maria');
        const page = await h.get('/memory?tab=services', { as: user });
        assert.strictEqual(page.status, 200);
        for (const name of ['mem0', 'Letta', 'Zep']) assert.ok(page.text.includes(name), name + ' is listed');
        assert.ok(page.text.includes('key ending 6789'), 'the saved key is shown by its last four characters only');
        assert.ok(!page.text.includes(MEM0_KEY), 'no key is on the page');
        assert.ok(/name="key"[^>]*type="password"|type="password"[^>]*name="key"/.test(page.text), 'the key field is a password field');
        assert.match(String(page.headers.get('cache-control')), /private/);

        const saved = await h.get('/memory/services/mem0', { as: user, method: 'POST', form: { tab: 'services', key: MEM0_KEY, base_url: 'https://api.mem0.example' } });
        assert.strictEqual(saved.status, 303, saved.text);
        const put = store.last('PUT', '/api/v1/memory/services/mem0');
        assert.ok(put && put.body.key === MEM0_KEY && put.body.base_url === 'https://api.mem0.example', 'the key went to the store');
        assert.match(put.auth, /^Bearer /, 'with the person token');
        assert.ok(!String(saved.headers.get('location')).includes(MEM0_KEY), 'the key is not in the redirect');

        const synced = await h.get('/memory/services/mem0/sync', { as: user, method: 'POST', form: { tab: 'services' } });
        assert.strictEqual(synced.status, 303);
        assert.match(String(synced.headers.get('location')), /ok=Synced%203%20notes/, String(synced.headers.get('location')));
        assert.ok(store.last('POST', '/api/v1/memory/services/mem0/sync'), 'the sync reached the store');

        const forgot = await h.get('/memory/services/mem0/disconnect', { as: user, method: 'POST', form: { tab: 'services' } });
        assert.strictEqual(forgot.status, 303);
        assert.ok(store.last('DELETE', '/api/v1/memory/services/mem0'), 'the key was forgotten');

        // A cross-site post never reaches the store.
        const before = store.calls.length;
        const evil = await h.get('/memory/services/mem0', { as: user, method: 'POST', form: { tab: 'services', key: MEM0_KEY }, headers: { origin: 'https://evil.example' } });
        assert.strictEqual(evil.status, 403);
        assert.strictEqual(store.calls.length, before, 'the refused post did not reach the store');
    } finally { await h.close(); await store.close(); }
});

await check('the Shared tab lists stores, a member reads one read-only, and a stranger sees the gate, never a note', async () => {
    const store = await startStore();
    const h = await boot({ env: { CODES_AI_INTERNAL_URL: store.url } });
    try {
        const user = h.network.addUser('maria');
        const list = await h.get('/memory?tab=shared', { as: user });
        assert.strictEqual(list.status, 200);
        assert.ok(list.text.includes('Shared with me'), 'the list heading');
        assert.ok(list.text.includes('/memory?tab=shared&amp;owner=' + A), 'a link to the shared store');
        assert.ok(!list.text.includes('A shared note'), 'the listing carries no note');

        store.gate = false;
        const member = await h.get('/memory?tab=shared&owner=' + A, { as: user });
        assert.strictEqual(member.status, 200);
        assert.ok(member.text.includes('A shared note about deploys.'), 'a member reads the notes');
        assert.ok(member.text.includes('read-only'), 'read-only');
        assert.ok(!member.text.includes('name="text"'), 'a member gets no edit form');

        store.gate = true;
        const stranger = await h.get('/memory?tab=shared&owner=' + A, { as: user });
        assert.strictEqual(stranger.status, 200);
        assert.ok(stranger.text.includes('data-ov-share-gate'), 'the gate markup');
        assert.ok(stranger.text.includes('data-kind="memory-store"'), 'the gate names the kind');
        assert.ok(stranger.text.includes('data-id="' + A + '"'), 'the gate names the store');
        assert.ok(stranger.text.includes('data-signed-in-as="maria"'), 'the gate names the account');
        assert.ok(!stranger.text.includes('A shared note'), 'the gate carries no note');
        assert.ok(stranger.text.includes('ov-share.js'), 'the gate is drawn by the shared script, never an inline one');
        const gate = /<div id="memory-gate"[\s\S]*?<\/div>/.exec(stranger.text);
        assert.ok(gate && !gate[0].includes('<script'), 'the gate has no inline script');

        const own = await h.get('/memory?tab=notes', { as: user });
        assert.ok(own.text.includes('data-ov-share-sheet'), 'the owner has the Share button');
        assert.ok(own.text.includes('data-kind="memory-store"'), 'the sheet shares a memory store');
        assert.ok(own.text.includes('ov-share.css'), 'the sheet stylesheet is loaded');
        assert.ok(own.text.includes('data-id="' + user.subject + '"'), 'the sheet names the owner store');
        assert.match(String(own.headers.get('cache-control')), /private/);
        assert.ok(!String(own.headers.get('cache-control')).includes('public'), 'a signed-in answer is never public-cacheable');
    } finally { await h.close(); await store.close(); }
});

await check('the portable file downloads as an attachment, and an import goes back to the store', async () => {
    const store = await startStore();
    const h = await boot({ env: { CODES_AI_INTERNAL_URL: store.url } });
    try {
        const user = h.network.addUser('maria');
        const page = await h.get('/memory?tab=export', { as: user });
        assert.ok(page.text.includes('Download memory.json'), 'the export link');
        assert.ok(page.text.includes('Import a portable file'), 'the import form');
        assert.ok(page.text.includes('memory-import.js'), 'the file picker script');
        assert.ok(page.text.includes('id="memory-import-picker"') && page.text.includes('ov-upload.js'), 'portable JSON uses the shared local picker');

        const file = await h.get('/memory/export', { as: user });
        assert.strictEqual(file.status, 200);
        assert.match(String(file.headers.get('content-disposition')), /^attachment; filename="openvibe-memory-\d{4}-\d{2}-\d{2}\.json"$/);
        assert.match(String(file.headers.get('cache-control')), /no-store/);
        const doc = file.json();
        assert.strictEqual(doc.format, 'openvibe.memory-export@1');
        assert.strictEqual(doc.items[0].text, 'A portable note.');

        const imported = await h.get('/memory/import', { as: user, method: 'POST', form: { tab: 'export', document: JSON.stringify(doc) } });
        assert.strictEqual(imported.status, 303);
        assert.match(String(imported.headers.get('location')), /ok=Imported%202%20notes/, String(imported.headers.get('location')));
        const post = store.last('POST', '/api/v1/memory/import');
        assert.ok(post && post.body.format === 'openvibe.memory-export@1', 'the document reached the store');

        const bad = await h.get('/memory/import', { as: user, method: 'POST', form: { tab: 'export', document: '{not json' } });
        assert.strictEqual(bad.status, 303);
        assert.match(String(bad.headers.get('location')), /error=That%20is%20not%20JSON/, String(bad.headers.get('location')));
    } finally { await h.close(); await store.close(); }
});

await check('the Share sheet API is proxied to AI with the person token, its ETag and a private no-store answer', async () => {
    const store = await startStore();
    const h = await boot({ env: { CODES_AI_INTERNAL_URL: store.url } });
    try {
        const user = h.network.addUser('maria');
        const get = await h.get(`/api/v1/memory-store/${A}/share`, { as: user });
        assert.strictEqual(get.status, 200, get.text);
        assert.strictEqual(get.json().audience, 'people');
        assert.strictEqual(get.headers.get('etag'), '"rev-3"');
        assert.match(String(get.headers.get('cache-control')), /private, no-store/);
        const read = store.last('GET', `/api/v1/memory-store/${A}/share`);
        assert.ok(read && /^Bearer /.test(read.auth), 'the person token reached the store');

        // A cookie-authenticated write without the same-site marker is refused here, before AI.
        const before = store.calls.length;
        const noMarker = await h.get(`/api/v1/memory-store/${A}/share`, { as: user, method: 'PUT', json: { audience: 'people' } });
        assert.deepStrictEqual([noMarker.status, noMarker.json().code], [403, 'share.csrf']);
        assert.strictEqual(store.calls.length, before, 'the refused write did not reach AI');

        const put = await h.get(`/api/v1/memory-store/${A}/share`, {
            as: user, method: 'PUT', json: { audience: 'people' }, headers: { 'x-requested-with': 'fetch', 'if-match': '"rev-3"' },
        });
        assert.strictEqual(put.status, 200, put.text);
        assert.strictEqual(put.json().revision, 4);
        const wrote = store.last('PUT', `/api/v1/memory-store/${A}/share`);
        assert.ok(wrote && wrote.body.audience === 'people', 'the body reached AI');
        assert.strictEqual(wrote.headers['if-match'], '"rev-3"', 'the conditional header reached AI');
        assert.strictEqual(put.headers.get('etag'), '"rev-4"');
    } finally { await h.close(); await store.close(); }
});

done();
})().catch((e) => { console.error(e); process.exit(1); });
