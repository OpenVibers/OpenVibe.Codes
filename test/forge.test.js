'use strict';
/**
 * OpenVibe Git through Codes' service token (server/domain/forge.js, server/http/git.js): Codes names the person
 * signed in in X-OV-Subject, OpenVibe.Git makes a repository in their name and mints their clone token. Nothing is
 * linked and no person's password is involved. A stand-in Git answers the three calls Codes makes.
 */
const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('http');
const { check, done, boot } = require('./helpers/boot');
const job = require('../harness/job');

const TOKEN = 'git_test_0123456789abcdef';

function claimsOf(header) {
    const raw = String(header || '').replace(/^Bearer\s+/i, '');
    try { return JSON.parse(Buffer.from(raw.split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}

function fakeGit() {
    const st = { repos: [], tokens: [], calls: [] };
    const srv = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const u = new URL(req.url, 'http://x');
            const body = raw ? JSON.parse(raw) : null;
            const send = (status, doc) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(doc)); };
            const subject = String(req.headers['x-ov-subject'] || '');
            st.calls.push({ method: req.method, path: u.pathname, subject, body, claims: claimsOf(req.headers.authorization) });
            if (req.method === 'POST' && u.pathname === '/api/v1/repos') {
                if (!req.headers.authorization || !subject) return send(401, { code: 'auth.subject_required', detail: 'name the person' });
                if (st.repos.some((r) => r.full_name === `${body.owner_username}/${body.name}`)) return send(409, { code: 'repo.exists', detail: 'That repository already exists.' });
                const row = {
                    name: body.name, full_name: `${body.owner_username}/${body.name}`, visibility: body.visibility,
                    html_url: `https://git.openvibe.codes/${body.owner_username}/${body.name}`,
                    clone_url: `https://git.openvibe.codes/${body.owner_username}/${body.name}.git`,
                    default_branch: 'main', owner: { username: body.owner_username, subject },
                };
                st.repos.push(row);
                return send(201, row);
            }
            const repoMatch = u.pathname.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)$/);
            if (req.method === 'GET' && repoMatch) {
                const row = st.repos.find((r) => r.full_name === `${repoMatch[1]}/${repoMatch[2]}`);
                return row ? send(200, row) : send(404, { code: 'repo.not_found' });
            }
            const who = u.pathname.match(/^\/api\/v1\/profile\/([^/]+)$/);
            if (req.method === 'GET' && who) {
                if (!req.headers.authorization || !subject) return send(401, { code: 'auth.required' });
                return send(200, { username: who[1], repositories: st.repos.filter((r) => r.full_name.startsWith(`${who[1]}/`)) });
            }
            if (req.method === 'POST' && u.pathname === '/api/v1/tokens') {
                if (!req.headers.authorization || !subject) return send(401, { code: 'auth.subject_required' });
                st.tokens.push({ subject, body });
                return send(201, { token: TOKEN, token_type: 'GitToken', scopes: body.scopes, expires_at: new Date(Date.now() + 7200_000).toISOString() });
            }
            return send(404, { code: 'route.not_found' });
        });
    });
    return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ st, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) })));
}

(async () => {
    const git = await fakeGit();
    const submits = [];
    const run = {
        enabled: true,
        async submit(o) { submits.push(o); return { id: `job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J${String(submits.length).padStart(2, '0')}`, state: 'queued' }; },
        async read(id) { return { id, state: 'queued' }; },
        async cancel(id) { return { id, state: 'cancelled' }; },
        async streamUrl() { throw new Error('not used'); },
    };
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-git-data-'));
    const t = await boot({ run, env: { CODES_GIT_INTERNAL_URL: git.url, CODES_GIT_DATA_DIR: dataDir } });
    const ada = t.network.addUser('ada');
    const nameless = t.network.addUser('');
    try {
        await check('the page asks for no link: Codes acts with its service token for the person signed in', async () => {
            const page = await t.get('/git', { as: ada });
            assert.strictEqual(page.status, 200);
            assert.doesNotMatch(page.text, /Link OpenVibe Git/);
            assert.match(page.text, /A new repository/);
            assert.match(page.text, /No repositories yet/);
            const call = git.st.calls.find((c) => c.path === '/api/v1/profile/ada');
            assert.ok(call, 'the page read ada\'s repositories');
            assert.strictEqual(call.subject, ada.subject, 'named in X-OV-Subject');
            assert.strictEqual(call.claims.sub, 'svc:codes', 'the service token, not a person\'s');
            assert.ok(call.claims.cap.includes('git.repo.write'), 'with git.repo.write');
            assert.ok(call.claims.aud.includes('openvibe.git'));
        });

        await check('a person with no username is told where to choose one', async () => {
            const page = await t.get('/git', { as: nameless });
            assert.match(page.text, /One more step on your account/);
            const refused = await t.get('/git/repos', { as: nameless, form: { name: 'x' } });
            assert.strictEqual(refused.status, 303);
            assert.match(decodeURIComponent(refused.headers.get('location')), /no username/);
        });

        await check('a new repository is made in their name, private, and opens a new chat', async () => {
            const made = await t.get('/git/repos', { as: ada, form: { name: 'my-site', description: 'A site for my bakery', private: '1' } });
            assert.strictEqual(made.status, 303);
            assert.strictEqual(made.headers.get('location'), `/?mode=code&repo=${encodeURIComponent('https://git.openvibe.codes/ada/my-site')}`);
            const call = git.st.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/repos').pop();
            assert.strictEqual(call.subject, ada.subject);
            assert.deepStrictEqual([call.body.name, call.body.owner_username, call.body.visibility, call.body.starter], ['my-site', 'ada', 'private', 'empty']);
        });

        await check('their repositories are listed, private ones too, with a way to work on each', async () => {
            const page = await t.get('/git', { as: ada });
            assert.match(page.text, /ada\/my-site<\/a>[\s\S]*?Private[\s\S]*?href="\/\?mode=code&amp;repo=https%3A%2F%2Fgit\.openvibe\.codes%2Fada%2Fmy-site">Work on it/);
            assert.ok(!page.text.includes(TOKEN), 'no token on a page');
        });

        await check('a task on the repository gets a Git token for the person, and the local disk when Codes shares it', async () => {
            fs.mkdirSync(path.join(dataDir, 'repos', 'ada', 'my-site.git'), { recursive: true });
            const start = await t.get('/chat', { as: ada, form: { mode: 'code', repo: 'https://git.openvibe.codes/ada/my-site', text: 'Add a menu page' } });
            assert.match(start.headers.get('location'), /^\/tasks\/tsk_/, start.headers.get('location'));
            const sent = submits[submits.length - 1];
            assert.strictEqual(sent.args.env.OPENVIBE_GIT_CREDENTIALS, `https://x-access-token:${TOKEN}@git.openvibe.codes`);
            assert.strictEqual(sent.args.env.OPENVIBE_GIT_LOCAL_ROOT, dataDir, 'clones from the disk, not the network');
            const minted = git.st.tokens.pop();
            assert.strictEqual(minted.subject, ada.subject, 'the token is the person\'s');
            assert.deepStrictEqual(minted.body.scopes, ['git.repo.read', 'git.repo.write']);
            assert.ok(job.ENV_NAMES.has('OPENVIBE_GIT_LOCAL_ROOT'), 'the job accepts the local root');
            const header = job.gitAuthFor('https://git.openvibe.codes/ada/my-site', { OPENVIBE_GIT_CREDENTIALS: sent.args.env.OPENVIBE_GIT_CREDENTIALS });
            assert.strictEqual(header.env.GIT_CONFIG_KEY_0, 'http.https://git.openvibe.codes/.extraheader', 'the machine clones and pushes with it');
            assert.strictEqual(Buffer.from(header.env.GIT_CONFIG_VALUE_0.replace(/^Authorization: Basic /, ''), 'base64').toString(), `x-access-token:${TOKEN}`);
            await t.get('/chat', { as: ada, form: { mode: 'code', repo: 'https://github.com/ada/elsewhere', text: 'Fix it' } });
            assert.ok(!(submits[submits.length - 1].args.env && submits[submits.length - 1].args.env.OPENVIBE_GIT_LOCAL_ROOT), 'no local root for another host');
        });

        await check('a repository on another host takes no OpenVibe Git token', async () => {
            assert.strictEqual(await t.ctx.forge.jobEnv(ada.subject, 'https://code.example.org/ada/site'), null);
            assert.strictEqual(await t.ctx.forge.jobEnv(ada.subject, 'not a url'), null);
        });
    } finally {
        await t.close();
        await git.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
