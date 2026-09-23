'use strict';
/**
 * Network API errors surface honestly: the page carries Network's HTTP status, problem code, detail
 * and request id; an unreachable Network is a 502 that says so, never an empty list; an expired
 * session is refreshed once and the call retried.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const owner = t.network.addUser('grace');
    const viewer = t.network.addUser('vera');
    const stranger = t.network.addUser('sam');
    const projectId = await t.project(owner, 'Errors');
    await t.get(`/projects/${projectId}/members`, { as: owner, form: { username: 'vera', role: 'viewer' } });

    await check('a project the person cannot see: 404 with project.not_found', async () => {
        const r = await t.get(`/projects/${projectId}`, { as: stranger });
        assert.strictEqual(r.status, 404);
        assert.match(r.text, /project\.not_found/);
        assert.match(r.text, /no such project/);
        assert.match(r.text, /request <code>req_/);
    });

    await check('a role Network refuses: 403 with project.forbidden and its detail', async () => {
        const r = await t.get(`/projects/${projectId}/apps`, { as: viewer, form: { name: 'x', environment: 'sandbox', type: 'confidential' } });
        assert.strictEqual(r.status, 403);
        assert.match(r.text, /project\.forbidden/);
        assert.match(r.text, /requires developer role/);
    });

    await check('a validation failure: 422 with Network\'s own detail', async () => {
        const r = await t.get(`/projects/${projectId}/apps`, { as: owner, form: { name: 'pub', environment: 'sandbox', type: 'public', redirect_uris: '' } });
        assert.strictEqual(r.status, 422);
        assert.match(r.text, /app\.invalid/);
        assert.match(r.text, /public app needs at least one redirect URI/);
    });

    await check('production on a sandbox-only project: 403 app.environment_not_allowed', async () => {
        const r = await t.get(`/projects/${projectId}/apps`, { as: owner, form: { name: 'prod', environment: 'production', type: 'confidential' } });
        assert.strictEqual(r.status, 403);
        assert.match(r.text, /app\.environment_not_allowed/);
    });

    await check('a conflict: 409 member.exists', async () => {
        const r = await t.get(`/projects/${projectId}/members`, { as: owner, form: { username: 'vera', role: 'viewer' } });
        assert.strictEqual(r.status, 409);
        assert.match(r.text, /member\.exists/);
    });

    await check('approving outside the allowance: 403 grant.beyond_allowance', async () => {
        const app = await t.app(owner, projectId);
        const req = await t.get(`/projects/${projectId}/apps/${app.id}/grants`, { as: owner, form: { capability: 'media.object.read' } });
        assert.strictEqual(req.status, 303);
        const r = await t.get(`/projects/${projectId}/apps/${app.id}/grants/media.object.read/approve`, { as: owner, form: {} });
        assert.strictEqual(r.status, 403);
        assert.match(r.text, /grant\.beyond_allowance/);
    });

    await check('Network answering 503: the page is 503 with Network\'s code, not an empty list', async () => {
        t.network.setDown(true);
        const r = await t.get('/projects', { as: owner });
        t.network.setDown(false);
        assert.strictEqual(r.status, 503);
        assert.match(r.text, /network\.down/);
        assert.ok(!/not a member of any project/.test(r.text));
    });

    await check('Network unreachable: 502 "did not answer", and the registry page says so too', async () => {
        // A separate instance whose Network mock is shut down.
        const t2 = await boot();
        const u = t2.network.addUser('ivy');
        await t2.network.close();
        const r = await t2.get('/projects', { as: u });
        assert.strictEqual(r.status, 502);
        assert.match(r.text, /OpenVibe\.Network could not be reached/);
        assert.match(r.text, /did not answer/);
        const s = await t2.get('/docs/services');
        assert.strictEqual(s.status, 502);
        assert.match(s.text, /The registry could not be read/);
        assert.match(s.text, /without health/);
        const ready = await t2.get('/api/ready');
        assert.strictEqual(ready.status, 200);
        const body = ready.json();
        assert.ok(body.degraded.includes('network'), 'readiness reports the Network as degraded');
        await t2.events.close(); await t2.media.close();
    });

    await check('an expired access token is refreshed once and the call retried', async () => {
        const expired = t.network.userToken(owner, { iat: Math.floor(Date.now() / 1000) - 7200, ttl: 3600 });
        // Hand the mock a refresh token for this user.
        t.network.state.refresh.set('rt_test', owner);
        const r = await t.get('/projects', { cookie: `codes_at=${expired}; codes_rt=rt_test` });
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.match(r.text, /Errors/);
        const set = r.headers.get('set-cookie') || '';
        assert.match(set, /codes_at=/);
        assert.match(set, /HttpOnly/i);
    });

    await check('an expired token with no refresh token reads as signed out (401), not as an error', async () => {
        const expired = t.network.userToken(owner, { iat: Math.floor(Date.now() / 1000) - 7200, ttl: 3600 });
        const r = await t.get('/projects', { cookie: `codes_at=${expired}` });
        assert.strictEqual(r.status, 401);
        assert.match(r.text, /Sign in/);
    });

    await t.close();
    done();
})();
