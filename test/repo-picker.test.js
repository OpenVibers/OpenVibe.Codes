'use strict';
/**
 * The repository field's dropdown (ask 348): the owner's sources in their order, each under its own time limit and a
 * failed one left out; the owner's settings (owner rank only); and making a repository on OpenVibe Git with a stub Git
 * API. The tests boot the real app, the real repo-picker and the real forge; only OpenVibe Git and GitHub are stubs.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');
const { createForge } = require('../server/domain/forge');

function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
                Promise.resolve(handler(req, raw, json)).catch((e) => json(500, { error: String(e && e.message) }));
            });
        });
        server.listen(0, '127.0.0.1', () => resolve({
            url: `http://127.0.0.1:${server.address().port}`,
            calls: [],
            close: () => new Promise((r) => server.close(r)),
        }));
    });
}

(async () => {
    // ── A stub OpenVibe Git: its token endpoint and POST /api/v1/repos, recording what Codes asked for. ──
    const git = await listen((req, raw, json) => {
        git.calls.push([req.method, req.url, raw]);
        if (req.url === '/oauth/token') return json(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 3600 });
        if (req.method === 'GET' && req.url.startsWith('/api/v1/profile/')) {
            return json(200, { repositories: [{ full_name: 'ada/one', html_url: 'https://git.openvibe.codes/ada/one', visibility: 'public', pushed_at: '2026-11-09T10:00:00Z' }] });
        }
        if (req.method === 'POST' && req.url === '/api/v1/repos') {
            const body = JSON.parse(raw || '{}');
            if (body.name === 'taken') return json(409, { code: 'repo.exists', detail: 'That repository already exists.' });
            if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(body.name || '')) return json(422, { code: 'repo.invalid_name', detail: 'That name cannot be used.' });
            return json(201, {
                full_name: `${body.owner_username}/${body.name}`, html_url: `https://git.openvibe.codes/${body.owner_username}/${body.name}`,
                clone_url: `https://git.openvibe.codes/${body.owner_username}/${body.name}.git`, visibility: body.visibility,
            });
        }
        return json(404, { code: 'repo.not_found' });
    });
    const forge = createForge({
        config: {
            git: { internalUrl: git.url, publicUrl: 'https://git.openvibe.codes' },
            networkInternalUrl: git.url,
            oauth: { clientId: 'codes', clientSecret: 'codes-secret' },
        },
        fetchImpl: globalThis.fetch,
        log: { warn() {}, info() {}, error() {} },
    });

    const github = {
        async publicRepo(owner, name) {
            if (owner !== 'OpenVibers' || name !== 'OpenVibe.Codes') return null;
            return { full_name: 'OpenVibers/OpenVibe.Codes', html_url: 'https://github.com/OpenVibers/OpenVibe.Codes', private: false, description: 'Codes', updated_at: '2026-11-08T00:00:00Z' };
        },
        async userRepos(login) {
            return login === 'adalink' ? [{ full_name: 'adalink/linked-repo', html_url: 'https://github.com/adalink/linked-repo', private: false, updated_at: '2026-11-07T00:00:00Z' }] : [];
        },
    };

    let custom = null;
    const fetchCustom = async (url, timeoutMs) => {
        custom = { url, timeoutMs };
        return { items: [{ label: 'pat/project', url: 'https://example.com/pat/project.git', private: false, sub: 'custom' }] };
    };

    const t = await boot({ forge, github, fetchCustom });
    const ada = t.network.addUser('ada');
    const bo = t.network.addUser('bo');
    const ola = t.network.addUser('ola', { role: 'owner' });
    const insertTask = (repo, at) => t.ctx.store.db.exec(
        `INSERT INTO run_tasks (id, subject, project_id, repo, prompt, state, created_at, updated_at)
         VALUES ($1, $2, 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2J1', $3, 'a task', 'succeeded', $4, $4)`,
        [`tsk_${String(at).padStart(26, '0')}`, ada.subject, repo, at],
    );
    const call = (path, { as = null, method = 'GET', body, json, origin } = {}) => {
        const payload = json !== undefined ? json : body;
        return t.get(`/api/v1${path}`, { as, method, ...(payload !== undefined ? { json: payload } : {}), ...(origin ? { headers: { origin } } : {}) });
    };

    try {
        await check('a guest is refused and the answer carries no CORS grant', async () => {
            const r = await call('/me/repos');
            assert.strictEqual(r.status, 401);
            assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
        });

        await check('sections come from the person\'s tasks and OpenVibe Git, in the owner\'s order', async () => {
            await insertTask('https://git.openvibe.codes/ada/website', 1000);
            await insertTask('https://github.com/adalink/old-thing', 2000);
            const r = await call('/me/repos', { as: ada });
            assert.strictEqual(r.status, 200, r.text);
            const out = r.json();
            assert.deepStrictEqual(out.sections.map((s) => s.id), ['recent', 'git']);
            const recent = out.sections[0].items;
            assert.strictEqual(recent[0].label, 'adalink/old-thing', 'newest first');
            assert.strictEqual(recent[0].host, 'github.com');
            assert.strictEqual(recent[1].url, 'https://git.openvibe.codes/ada/website.git');
            assert.strictEqual(out.sections[1].items[0].label, 'ada/one');
            assert.strictEqual(out.sections[1].items[0].host, 'git.openvibe.codes');
            assert.deepStrictEqual(out.create, { allowed: true, host: 'git.openvibe.codes', owner: 'ada' });
        });

        await check('a query filters each source; GitHub without a link answers only an exact owner/name', async () => {
            const one = await call('/me/repos?q=website', { as: ada });
            assert.deepStrictEqual(one.json().sections.map((s) => s.id), ['recent']);
            const exact = await call('/me/repos?q=OpenVibers%2FOpenVibe.Codes', { as: ada });
            assert.deepStrictEqual(exact.json().sections.map((s) => s.id), ['github']);
            assert.strictEqual(exact.json().sections[0].items[0].url, 'https://github.com/OpenVibers/OpenVibe.Codes.git');
            const partial = await call('/me/repos?q=OpenVibe', { as: ada });
            assert.ok(!partial.json().sections.some((s) => s.id === 'github'), 'no general GitHub search without a link');
        });

        await check('a GitHub account linked through the Network is searched by login', async () => {
            const linked = t.network.addUser('ada2', { githubLogin: 'adalink' });
            const r = await call('/me/repos?q=linked', { as: linked });
            assert.strictEqual(r.status, 200, r.text);
            const githubSection = r.json().sections.find((s) => s.id === 'github');
            assert.ok(githubSection, JSON.stringify(r.json()));
            assert.strictEqual(githubSection.items[0].label, 'adalink/linked-repo');
        });

        await check('a failed source is left out with no error to the person', async () => {
            const failing = { enabled: true, async repos() { throw new Error('Git did not answer'); }, async createRepo() { throw new Error('unused'); } };
            const t2 = await boot({ forge: failing, github });
            try {
                await t2.ctx.store.db.exec(
                    `INSERT INTO run_tasks (id, subject, project_id, repo, prompt, state, created_at, updated_at)
                     VALUES ('tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2J2', $1, 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2J1', 'https://git.openvibe.codes/ada/one', 'a task', 'succeeded', 1, 1)`,
                    [ada.subject],
                );
                const r = await t2.get('/api/v1/me/repos', { as: ada });
                assert.strictEqual(r.status, 200);
                const out = r.json();
                assert.ok(!out.problem && !out.error);
                assert.deepStrictEqual(out.sections.map((s) => s.id), ['recent']);
            } finally { await t2.close(); }
        });

        await check('a source over its time limit is left out and the answer still comes', async () => {
            const slow = { enabled: true, async repos() { return await new Promise(() => {}); }, async createRepo() { return {}; } };
            const t3 = await boot({ forge: slow, github });
            try {
                const owner3 = t3.network.addUser('slo', { role: 'owner' });
                const put = await t3.get('/api/v1/admin/repo-sources', {
                    as: owner3, method: 'PUT',
                    json: { sources: [
                        { id: 'recent', kind: 'recent', label: 'Used here', enabled: true, position: 1, limit_n: 8, timeout_ms: 1500 },
                        { id: 'git', kind: 'git', label: 'OpenVibe Git', enabled: true, position: 2, limit_n: 8, timeout_ms: 100 },
                        { id: 'github', kind: 'github', label: 'GitHub', enabled: false, position: 3, limit_n: 8, timeout_ms: 1500 },
                    ] },
                });
                assert.strictEqual(put.status, 200, put.text);
                const at = Date.now();
                const r = await t3.get('/api/v1/me/repos', { as: owner3 });
                assert.strictEqual(r.status, 200);
                assert.ok(Date.now() - at < 1000, 'did not wait for the slow source');
                assert.ok(!r.json().sections.some((s) => s.id === 'git'));
            } finally { await t3.close(); }
        });

        await check('the owner can turn, reorder and add sources; a custom one is fetched with {q}', async () => {
            const put = await call('/admin/repo-sources', {
                as: ola, method: 'PUT',
                json: { sources: [
                    { id: 'git', kind: 'git', label: 'OpenVibe Git', enabled: true, position: 1, limit_n: 5, timeout_ms: 1500 },
                    { id: 'recent', kind: 'recent', label: 'Used here', enabled: true, position: 2, limit_n: 3, timeout_ms: 1500 },
                    { id: 'github', kind: 'github', label: 'GitHub', enabled: false, position: 3, limit_n: 8, timeout_ms: 1500 },
                    { id: 'src_mine', kind: 'url', label: 'My host', url_template: 'https://example.com/repos?q={q}', enabled: true, position: 4, limit_n: 4, timeout_ms: 1500 },
                ] },
            });
            assert.strictEqual(put.status, 200, put.text);
            assert.deepStrictEqual(put.json().sources.map((s) => s.id), ['git', 'recent', 'github', 'src_mine']);
            const got = await call('/admin/repo-sources', { as: ola });
            assert.strictEqual(got.status, 200);
            assert.deepStrictEqual(got.json().sources.map((s) => s.id), ['git', 'recent', 'github', 'src_mine']);
            const r = await call('/me/repos?q=a', { as: ada });
            assert.deepStrictEqual(r.json().sections.map((s) => s.id), ['git', 'recent', 'src_mine']);
            assert.strictEqual(custom.url, 'https://example.com/repos?q=a');
            assert.strictEqual(r.json().sections[2].items[0].label, 'pat/project');
            // The form the owner sees is the same rows.
            const page = await t.get('/admin/repo-sources', { as: ola });
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('Repository sources') && page.text.includes('https://example.com/repos?q={q}'));
        });

        await check('the plain owner form saves the same list without JavaScript', async () => {
            const form = {
                'source.recent.kind': 'recent', 'source.recent.label': 'Used here', 'source.recent.enabled': '1',
                'source.recent.position': '2', 'source.recent.limit_n': '8', 'source.recent.timeout_ms': '1500',
                'source.git.kind': 'git', 'source.git.label': 'OpenVibe Git', 'source.git.enabled': '1',
                'source.git.position': '1', 'source.git.limit_n': '8', 'source.git.timeout_ms': '1500',
                'source.github.kind': 'github', 'source.github.label': 'GitHub',
                'source.github.position': '3', 'source.github.limit_n': '8', 'source.github.timeout_ms': '1500',
                'new.label': 'Form host', 'new.url_template': 'https://example.com/list?q={q}', 'new.enabled': '1', 'new.limit_n': '4', 'new.timeout_ms': '1200',
            };
            const saved = await t.get('/admin/repo-sources', { as: ola, method: 'POST', form });
            assert.strictEqual(saved.status, 303, saved.text);
            assert.strictEqual(saved.headers.get('location'), '/admin/repo-sources?saved=1');
            const page = await t.get('/admin/repo-sources', { as: ola });
            assert.ok(page.text.includes('Form host') && page.text.includes('https://example.com/list?q={q}'));
        });

        await check('a non-owner gets 403 and the guest 401 on the owner settings', async () => {
            assert.strictEqual((await call('/admin/repo-sources', { as: ada })).status, 403);
            assert.strictEqual((await call('/admin/repo-sources', { as: ada, method: 'PUT', json: { sources: [] } })).status, 403);
            assert.strictEqual((await call('/admin/repo-sources')).status, 401);
            assert.strictEqual((await t.get('/admin/repo-sources', { as: ada })).status, 403);
        });

        await check('a custom source must be https and carry {q}', async () => {
            const bad = await call('/admin/repo-sources', {
                as: ola, method: 'PUT',
                json: { sources: [
                    { id: 'recent', kind: 'recent', label: 'Used here', enabled: true, position: 1, limit_n: 8, timeout_ms: 1500 },
                    { id: 'src_x', kind: 'url', label: 'X', url_template: 'http://example.com/?q={q}', enabled: true, position: 2 },
                ] },
            });
            assert.strictEqual(bad.status, 422);
            const noQ = await call('/admin/repo-sources', {
                as: ola, method: 'PUT',
                json: { sources: [{ id: 'recent', kind: 'recent', label: 'Used here', enabled: true, position: 1 }, { id: 'src_y', kind: 'url', label: 'Y', url_template: 'https://example.com/?q=', enabled: true, position: 2 }] },
            });
            assert.strictEqual(noQ.status, 422);
        });

        await check('creating a repository against the stub Git API: a bad name, a good one, and a taken one', async () => {
            const bad = await call('/repos', { as: ada, method: 'POST', body: { name: 'not a name!' } });
            assert.strictEqual(bad.status, 422, bad.text);
            assert.strictEqual(bad.json().code, 'repo.name_invalid');
            const good = await call('/repos', { as: ada, method: 'POST', body: { name: 'new-site', private: true } });
            assert.strictEqual(good.status, 201, good.text);
            assert.deepStrictEqual(good.json(), { url: 'https://git.openvibe.codes/ada/new-site.git', label: 'ada/new-site' });
            const sent = git.calls.filter((c) => c[0] === 'POST' && c[1] === '/api/v1/repos').pop();
            assert.strictEqual(JSON.parse(sent[2]).visibility, 'private');
            assert.strictEqual(JSON.parse(sent[2]).owner_username, 'ada');
            const taken = await call('/repos', { as: ada, method: 'POST', body: { name: 'taken' } });
            assert.strictEqual(taken.status, 409);
            assert.strictEqual(taken.json().code, 'repo.name_taken');
        });

        await check('creating is rate limited per person', async () => {
            const t4 = await boot({ forge, github, actorLimits: true });
            try {
                const u = t4.network.addUser('rita');
                const statuses = [];
                for (let i = 0; i < 4; i++) {
                    const r = await t4.get('/api/v1/repos', { as: u, method: 'POST', json: { name: `rate-${i}` } });
                    statuses.push(r.status);
                }
                assert.deepStrictEqual(statuses.slice(0, 3), [201, 201, 201]);
                assert.strictEqual(statuses[3], 429, statuses.join(','));
            } finally { await t4.close(); }
        });

        await check('a guest cannot create and a cross-site post is refused', async () => {
            assert.strictEqual((await call('/repos', { method: 'POST', body: { name: 'x' } })).status, 401);
            const cross = await call('/repos', { as: ada, method: 'POST', body: { name: 'x' }, origin: 'https://evil.example' });
            assert.strictEqual(cross.status, 403);
        });
    } finally {
        await t.close();
        await git.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
