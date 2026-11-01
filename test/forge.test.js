'use strict';
/**
 * OpenVibe Git through the person's own account (server/domain/forge.js, server/http/git.js; the owner, 2026-11-01:
 * "make a repository through your OpenVibe account on our actual Git"). A stand-in forge answers the OAuth2 token
 * exchange (checking the PKCE verifier against the challenge the page sent), who the person is, their repositories and
 * a new one. Linking is off without the app and the seal key; the tokens are sealed; a repository on the forge takes
 * the person's credential line to their machine, and the job keeps it from the agent.
 */
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { check, done, boot } = require('./helpers/boot');
const { createSeal } = require('../server/domain/seal');
const job = require('../harness/job');

const SEAL_KEY = crypto.randomBytes(32).toString('base64');
const TOKEN = 'forge-access-0123456789abcdef';

function fakeForge() {
    const st = { challenges: new Map(), repos: [], codes: new Map(), refreshes: 0 };
    const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const u = new URL(req.url, 'http://x');
            const send = (status, doc) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(doc)); };
            const authed = req.headers.authorization === `Bearer ${TOKEN}`;
            if (req.method === 'POST' && u.pathname === '/login/oauth/access_token') {
                const f = new URLSearchParams(body);
                if (f.get('client_id') !== 'codes-app' || f.get('client_secret') !== 'codes-app-secret') return send(401, { error: 'invalid_client' });
                if (f.get('grant_type') === 'refresh_token') { st.refreshes++; return send(200, { access_token: TOKEN, refresh_token: 'r2', expires_in: 3600 }); }
                const challenge = st.codes.get(f.get('code'));
                const ok = challenge && crypto.createHash('sha256').update(String(f.get('code_verifier'))).digest('base64url') === challenge;
                return ok ? send(200, { access_token: TOKEN, refresh_token: 'r1', expires_in: 3600 }) : send(400, { error: 'invalid_grant' });
            }
            if (!authed) return send(401, { message: 'token is required' });
            if (req.method === 'GET' && u.pathname === '/api/v1/user') return send(200, { login: 'ada', id: 7 });
            if (req.method === 'GET' && u.pathname === '/api/v1/user/repos') return send(200, st.repos);
            if (req.method === 'POST' && u.pathname === '/api/v1/user/repos') {
                const b = JSON.parse(body || '{}');
                if (st.repos.some((r) => r.name === b.name)) return send(409, { message: 'exists' });
                const r = { name: b.name, full_name: `ada/${b.name}`, html_url: `https://git.openvibe.codes/ada/${b.name}`, clone_url: `https://git.openvibe.codes/ada/${b.name}.git`, private: !!b.private, description: b.description, updated_at: new Date().toISOString(), auto_init: b.auto_init };
                st.repos.push(r);
                return send(201, r);
            }
            return send(404, { message: 'not found' });
        });
    });
    return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ st, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) })));
}

(async () => {
    await check('a sealed token opens only with the same key for the same person', () => {
        const seal = createSeal(SEAL_KEY);
        const sealed = seal.close('secret-token', 'usr_A');
        assert.ok(!sealed.includes('secret-token'));
        assert.strictEqual(seal.open(sealed, 'usr_A'), 'secret-token');
        assert.strictEqual(seal.open(sealed, 'usr_B'), null, 'moved to another person, it does not open');
        assert.strictEqual(createSeal(crypto.randomBytes(32).toString('base64')).open(sealed, 'usr_A'), null, 'another key cannot open it');
        assert.strictEqual(createSeal('short'), null, 'no key, no sealing');
    });

    await check('without the forge app and a seal key, linking says it opens soon and nothing else answers', async () => {
        const t = await boot();
        try {
            const ada = t.network.addUser('ada-off');
            const page = await t.get('/git', { as: ada });
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /Linking opens soon/);
            assert.strictEqual((await t.get('/git/connect', { as: ada })).status, 404);
        } finally { await t.close(); }
    });

    const forge = await fakeForge();
    const submits = [];
    const run = {
        enabled: true,
        async submit(o) { submits.push(o); return { id: `job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J${String(submits.length).padStart(2, '0')}`, state: 'queued' }; },
        async read(id) { return { id, state: 'queued' }; },
        async cancel(id) { return { id, state: 'cancelled' }; },
        async streamUrl() { throw new Error('not used'); },
    };
    const t = await boot({ run, env: { CODES_GIT_INTERNAL_URL: forge.url, CODES_FORGE_CLIENT_ID: 'codes-app', CODES_FORGE_CLIENT_SECRET: 'codes-app-secret', CODES_SEAL_KEY: SEAL_KEY } });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    const cookieOf = (r) => String(r.headers.get('set-cookie') || '').split(';')[0];
    try {
        await check('linking: the forge’s consent with PKCE, back with a code, the tokens sealed', async () => {
            const first = await t.get('/git', { as: ada });
            assert.match(first.text, /<a class="c4-button" href="\/git\/connect">Link OpenVibe Git<\/a>/);
            const go = await t.get('/git/connect', { as: ada });
            assert.strictEqual(go.status, 303);
            const to = new URL(go.headers.get('location'));
            assert.strictEqual(to.origin + to.pathname, 'https://git.openvibe.codes/login/oauth/authorize');
            assert.strictEqual(to.searchParams.get('code_challenge_method'), 'S256');
            assert.strictEqual(to.searchParams.get('redirect_uri'), 'https://openvibe.codes/git/callback');
            const cookie = cookieOf(go);
            assert.match(cookie, /^codes_forge_oauth=/);
            assert.match(String(go.headers.get('set-cookie')), /HttpOnly/i);
            forge.st.codes.set('code-1', to.searchParams.get('code_challenge'));
            const wrong = await t.get(`/git/callback?code=code-1&state=nope`, { as: ada, headers: { cookie: `${t.signIn(ada)}; ${cookie}` } });
            assert.match(decodeURIComponent(wrong.headers.get('location')), /did not start here/, 'a state that is not ours is refused');
            const back = await t.get(`/git/callback?code=code-1&state=${to.searchParams.get('state')}`, { as: ada, headers: { cookie: `${t.signIn(ada)}; ${cookie}` } });
            assert.strictEqual(back.status, 303);
            assert.match(decodeURIComponent(back.headers.get('location')), /ok=Linked as ada/);
            const row = await db.maybe('SELECT forge_user, token_sealed, refresh_sealed FROM codes_forge_links WHERE subject = $1', [ada.subject]);
            assert.strictEqual(row.forge_user, 'ada');
            assert.ok(!row.token_sealed.includes(TOKEN) && row.token_sealed.startsWith('v1.'), 'sealed, never plain');
            assert.ok(!(await t.dbDump()).includes(TOKEN), 'the token is nowhere in the database in the clear');
        });

        await check('a new repository in the person’s name opens a new chat on it; a taken or bad name is said in words', async () => {
            const made = await t.get('/git/repos', { as: ada, form: { name: 'my-site', description: 'A site for my bakery', private: '1' } });
            assert.strictEqual(made.status, 303);
            assert.strictEqual(made.headers.get('location'), `/?mode=code&repo=${encodeURIComponent('https://git.openvibe.codes/ada/my-site')}`);
            assert.ok(forge.st.repos[0].private && forge.st.repos[0].auto_init, 'private, with a README on main');
            const again = await t.get('/git/repos', { as: ada, form: { name: 'my-site' } });
            assert.match(decodeURIComponent(again.headers.get('location')), /already have a repository called my-site/);
            const bad = await t.get('/git/repos', { as: ada, form: { name: '../etc' } });
            assert.match(decodeURIComponent(bad.headers.get('location')), /A name is letters/);
            const page = await t.get('/git', { as: ada });
            assert.match(page.text, /ada\/my-site<\/a>[\s\S]*?Private[\s\S]*?href="\/\?mode=code&amp;repo=https%3A%2F%2Fgit\.openvibe\.codes%2Fada%2Fmy-site">Work on it/);
            assert.ok(!page.text.includes(TOKEN), 'no token on a page');
        });

        await check('a task on a forge repository takes the credential line to the machine; any other repository does not', async () => {
            const start = await t.get('/chat', { as: ada, form: { mode: 'code', repo: 'https://git.openvibe.codes/ada/my-site', text: 'Add a menu page' } });
            assert.match(start.headers.get('location'), /^\/tasks\/tsk_/, start.headers.get('location'));
            const sent = submits[submits.length - 1];
            assert.strictEqual(sent.args.env.OPENVIBE_GIT_CREDENTIALS, `https://ada:${TOKEN}@git.openvibe.codes`);
            await t.get('/chat', { as: ada, form: { mode: 'code', repo: 'https://github.com/ada/elsewhere', text: 'Fix it' } });
            const other = submits[submits.length - 1];
            assert.ok(!(other.args.env && other.args.env.OPENVIBE_GIT_CREDENTIALS), 'no forge line for a GitHub repository');
            assert.ok(job.ENV_NAMES.has('OPENVIBE_GIT_CREDENTIALS'), 'the job accepts it');
            const header = job.gitAuthFor('https://git.openvibe.codes/ada/my-site', { OPENVIBE_GIT_CREDENTIALS: sent.args.env.OPENVIBE_GIT_CREDENTIALS });
            assert.strictEqual(header.env.GIT_CONFIG_KEY_0, 'http.https://git.openvibe.codes/.extraheader', 'the machine clones and pushes with it');
            assert.ok(job.giteaHosts({}).has('git.openvibe.codes'), 'a push to OpenVibe Git opens its pull request there');
        });

        await check('the composer offers a new repository on OpenVibe Git, and the rail has its place', async () => {
            const home = await t.get('/', { as: ada });
            assert.match(home.text, /<a class="ch-chip ch-chip-new" href="\/git">[\s\S]*?New on OpenVibe Git<\/a>/);
            assert.match(home.text, /href="\/git"[^>]*>[\s\S]{0,400}?OpenVibe Git/);
        });

        await check('unlinking forgets the tokens', async () => {
            const r = await t.get('/git/unlink', { as: ada, form: { confirm: '1' } });
            assert.strictEqual(r.status, 303);
            assert.strictEqual(await db.maybe('SELECT 1 FROM codes_forge_links WHERE subject = $1', [ada.subject]), null);
            assert.match((await t.get('/git', { as: ada })).text, /Link OpenVibe Git/);
        });
    } finally {
        await t.close();
        await forge.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
