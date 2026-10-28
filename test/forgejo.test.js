'use strict';
/**
 * OpenVibe Git / Forgejo client (server/domain/forgejo.js): branches, pull requests, reviews and webhooks.
 * The client uses node:http / node:https (not fetch) so it can reach Forgejo on 127.0.0.1:5060, and it refuses to do
 * anything without a token. A stand-in Forgejo answers the same paths so no real forge is contacted.
 */
const assert = require('assert');
const http = require('http');
const { createForgejoClient } = require('../server/domain/forgejo');
const { check, done } = require('./helpers/boot');

function mockForgejo() {
    const calls = [];
    const repoBase = '/api/v1/repos/OpenVibers/OpenVibe.Codes';
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const auth = req.headers.authorization || '';
            const body = raw ? JSON.parse(raw) : null;
            const pathname = new URL(req.url, 'http://x').pathname;
            calls.push({ method: req.method, path: req.url, auth, body });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (pathname === repoBase) {
                return res.end(JSON.stringify({ full_name: 'OpenVibers/OpenVibe.Codes', default_branch: 'main' }));
            }
            if (pathname === `${repoBase}/branches` && req.method === 'POST') {
                return res.end(JSON.stringify({ name: body.new_branch_name }));
            }
            if (pathname === `${repoBase}/branches`) {
                return res.end(JSON.stringify([{ name: 'main' }, { name: 'feature' }]));
            }
            if (pathname === `${repoBase}/pulls` && req.method === 'POST') {
                return res.end(JSON.stringify({ number: 5, title: body.title }));
            }
            if (pathname === `${repoBase}/pulls`) {
                return res.end(JSON.stringify([{ number: 5, title: 'A PR' }]));
            }
            if (pathname === `${repoBase}/pulls/5`) {
                return res.end(JSON.stringify({ number: 5, title: 'PR' }));
            }
            if (pathname === `${repoBase}/pulls/5/reviews`) {
                return res.end(JSON.stringify([{ id: 1, state: 'APPROVED' }]));
            }
            if (pathname === `${repoBase}/hooks` && req.method === 'POST') {
                return res.end(JSON.stringify({ id: 9 }));
            }
            if (pathname === `${repoBase}/hooks/9` && req.method === 'DELETE') {
                return res.end('{}');
            }
            res.end('{}');
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

(async () => {
    const forgejo = await mockForgejo();
    const old = process.env.FORGEJO_TOKEN;
    process.env.FORGEJO_TOKEN = 'f-token';
    const client = createForgejoClient({ config: { git: { internalUrl: forgejo.url, publicUrl: 'https://git.openvibe.codes' } }, log: { warn() {} } });

    try {
        await check('without a token the client is unconfigured', async () => {
            delete process.env.FORGEJO_TOKEN;
            delete process.env.CODES_GIT_TOKEN;
            const noToken = createForgejoClient({ config: { git: { internalUrl: forgejo.url } }, log: { warn() {} } });
            const c = noToken.configured();
            assert.strictEqual(c.ok, false);
            assert.strictEqual(c.code, 'forgejo.unconfigured');
            await assert.rejects(noToken.getRepo('OpenVibers', 'OpenVibe.Codes'), (e) => e.code === 'forgejo.unconfigured');
            process.env.FORGEJO_TOKEN = 'f-token';
        });

        await check('getRepo, listBranches and createBranch call the right Forgejo paths', async () => {
            const repo = await client.getRepo('OpenVibers', 'OpenVibe.Codes');
            assert.strictEqual(repo.default_branch, 'main');
            const branches = await client.listBranches('OpenVibers', 'OpenVibe.Codes');
            assert.strictEqual(branches.length, 2);
            const created = await client.createBranch('OpenVibers', 'OpenVibe.Codes', { base_branch: 'main', new_branch_name: 'feature' });
            assert.strictEqual(created.name, 'feature');
            assert.ok(forgejo.calls.some((c) => c.method === 'GET' && c.path === '/api/v1/repos/OpenVibers/OpenVibe.Codes/branches'));
            assert.ok(forgejo.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/repos/OpenVibers/OpenVibe.Codes/branches'));
            assert.ok(forgejo.calls.some((c) => c.auth === 'token f-token'));
        });

        await check('pull requests and reviews are read and created', async () => {
            const prs = await client.listPullRequests('OpenVibers', 'OpenVibe.Codes');
            assert.strictEqual(prs[0].number, 5);
            const pr = await client.getPullRequest('OpenVibers', 'OpenVibe.Codes', 5);
            assert.strictEqual(pr.number, 5);
            const created = await client.createPullRequest('OpenVibers', 'OpenVibe.Codes', { base: 'main', head: 'feature', title: 'Add test', body: 'Desc' });
            assert.strictEqual(created.number, 5);
            const reviews = await client.listReviews('OpenVibers', 'OpenVibe.Codes', 5);
            assert.strictEqual(reviews[0].state, 'APPROVED');
        });

        await check('webhooks are created and deleted', async () => {
            const hook = await client.createWebhook('OpenVibers', 'OpenVibe.Codes', { type: 'forgejo', config: { url: 'https://openvibe.codes/hooks' }, events: ['push'] });
            assert.strictEqual(hook.id, 9);
            await client.deleteWebhook('OpenVibers', 'OpenVibe.Codes', 9);
            assert.ok(forgejo.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/repos/OpenVibers/OpenVibe.Codes/hooks'));
            assert.ok(forgejo.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/repos/OpenVibers/OpenVibe.Codes/hooks/9'));
        });
    } finally {
        process.env.FORGEJO_TOKEN = old;
        await new Promise((r) => forgejo.server.close(r));
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
