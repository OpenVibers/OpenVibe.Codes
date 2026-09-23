'use strict';
/**
 * Sign-in with PKCE S256, the outbox relay with Codes' own service token, truthful readiness,
 * /release.json, loopback-only /metrics, pages useful without JavaScript, and form protection.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const user = t.network.addUser('kim');

    await check('login redirects to Network with state and an S256 code challenge', async () => {
        const r = await t.get('/auth/login?next=/projects');
        assert.strictEqual(r.status, 302);
        const loc = new URL(r.headers.get('location'));
        assert.strictEqual(loc.origin + loc.pathname, `${t.network.url}/oauth/authorize`);
        assert.strictEqual(loc.searchParams.get('client_id'), 'codes');
        assert.strictEqual(loc.searchParams.get('code_challenge_method'), 'S256');
        assert.match(loc.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
        assert.match(loc.searchParams.get('state'), /^[0-9a-f]{32}$/);
        assert.match(r.headers.get('set-cookie'), /codes_oauth=.*Path=\/auth.*HttpOnly/i);
    });

    await check('callback exchanges the code with the matching verifier and sets httpOnly session cookies', async () => {
        const login = await t.get('/auth/login?next=/projects');
        const loc = new URL(login.headers.get('location'));
        const flowCookie = login.headers.get('set-cookie').split(';')[0];
        const code = t.network.issueCode(user, loc.searchParams.get('code_challenge'));
        const r = await t.get(`/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`, { cookie: flowCookie });
        assert.strictEqual(r.status, 302, r.text);
        assert.strictEqual(r.headers.get('location'), '/projects');
        const set = r.headers.get('set-cookie');
        assert.match(set, /codes_at=[^;]+;.*HttpOnly/i);
        assert.match(set, /codes_rt=[^;]+;.*HttpOnly/i);
        const at = set.match(/codes_at=([^;]+)/)[1];
        const me = await t.get('/auth/me', { cookie: `codes_at=${at}` });
        assert.strictEqual(me.json().user.username, 'kim');
        assert.ok(!me.text.includes(at), '/auth/me never returns the token');
    });

    await check('a wrong state or a verifier that does not match is refused', async () => {
        const login = await t.get('/auth/login');
        const loc = new URL(login.headers.get('location'));
        const flowCookie = login.headers.get('set-cookie').split(';')[0];
        const code = t.network.issueCode(user, loc.searchParams.get('code_challenge'));
        const bad = await t.get(`/auth/callback?code=${code}&state=${'0'.repeat(32)}`, { cookie: flowCookie });
        assert.strictEqual(bad.status, 400);
        const other = t.network.issueCode(user, crypto.createHash('sha256').update('another-verifier').digest('base64url'));
        const mismatch = await t.get(`/auth/callback?code=${other}&state=${loc.searchParams.get('state')}`, { cookie: flowCookie });
        assert.strictEqual(mismatch.status, 400, 'Network refuses the PKCE check; Codes reports it');
        const noCookie = await t.get(`/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`);
        assert.strictEqual(noCookie.status, 400);
    });

    await check('next= only accepts same-site paths', async () => {
        const r = await t.get('/auth/login?next=//evil.example/x');
        const flow = decodeURIComponent(r.headers.get('set-cookie').match(/codes_oauth=([^;]+)/)[1]);
        assert.strictEqual(JSON.parse(flow).next, '/');
    });

    await check('forms need the form token and a same-site Origin', async () => {
        const noToken = await t.get('/projects', { as: user, form: { name: 'x', csrf: 'nope' } });
        assert.strictEqual(noToken.status, 403);
        const crossSite = await t.get('/projects', { as: user, form: { name: 'x' }, headers: { origin: 'https://evil.example' } });
        assert.strictEqual(crossSite.status, 403);
        const ok = await t.get('/projects', { as: user, form: { name: 'x' }, headers: { origin: 'https://openvibe.codes' } });
        assert.strictEqual(ok.status, 303);
    });

    await check('readiness is truthful: required db + docs; Network, relay and client are optional', async () => {
        const r = await t.get('/api/ready');
        const b = r.json();
        assert.strictEqual(r.status, 200);
        assert.strictEqual(b.checks.db.status, 'ok');
        assert.strictEqual(b.checks.docs.status, 'ok');
        assert.strictEqual(b.checks.network_jwks.status, 'ok');
        assert.strictEqual(b.checks.network.status, 'ok');
        assert.strictEqual(b.checks.events_relay.status, 'fail', 'EVENTS_URL is unset in this boot, and it says so');
        assert.ok(b.degraded.includes('events_relay'));
    });

    await check('/release.json and /metrics (loopback only)', async () => {
        const rel = await t.get('/release.json');
        assert.strictEqual(rel.status, 200);
        assert.strictEqual(rel.json().service, 'codes');
        const m = await t.get('/metrics');
        assert.strictEqual(m.status, 200);
        assert.match(m.text, /http_requests_total|release_info/);
        const proxied = await t.get('/metrics', { headers: { 'x-forwarded-for': '203.0.113.9' } });
        assert.notStrictEqual(proxied.status, 200, 'a proxied request is not loopback');
    });

    await check('public pages are complete without JavaScript (forms, noscript nav, SSR footer)', async () => {
        for (const p of ['/', '/docs', '/oauth', '/tools/webhooks', '/manifests/validate', '/policy/transparency']) {
            const r = await t.get(p);
            assert.strictEqual(r.status, 200, p);
            assert.match(r.text, /<noscript><nav/);
            assert.match(r.text, /<footer id="ov-footer"/);
            assert.match(r.text, /<main id="main"/);
        }
        const hook = await t.get('/tools/webhooks');
        assert.match(hook.text, /<form method="post" action="\/tools\/webhooks\/verify"/);
    });

    await check('the OAuth test callback shows what came back and never exchanges it', async () => {
        const before = t.network.tokenRequests.length;
        const r = await t.get('/oauth/test-callback?code=abc123&state=s1');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /<code>abc123<\/code>/);
        assert.strictEqual(r.headers.get('cache-control'), 'no-store');
        assert.strictEqual(r.headers.get('referrer-policy'), 'no-referrer');
        assert.match(r.text, /noindex/);
        assert.strictEqual(t.network.tokenRequests.length, before, 'no token request');
        const err = await t.get('/oauth/test-callback?error=access_denied&state=s1');
        assert.strictEqual(err.status, 400);
        assert.match(err.text, /access_denied/);
        const xss = await t.get('/oauth/test-callback?code=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
        assert.ok(!xss.text.includes('<script>alert(1)</script>'));
    });

    await check('the OAuth helper builds a PKCE authorize URL for the developer\'s app', async () => {
        const r = await t.get('/oauth?client_id=app_01JABCDEFGHJKMNPQRSTVWXYZ0&scope=media.object.upload');
        const url = new URL(r.text.match(/<a href="([^"]+oauth\/authorize[^"]+)"/)[1].replace(/&amp;/g, '&'));
        assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
        const verifier = r.text.match(/code_verifier<\/dt><dd><code>([A-Za-z0-9_-]{43})<\/code>/)[1];
        assert.strictEqual(crypto.createHash('sha256').update(verifier).digest('base64url'), url.searchParams.get('code_challenge'));
        assert.strictEqual(url.searchParams.get('redirect_uri'), 'https://openvibe.codes/oauth/test-callback');
    });

    await t.close();

    // ── Outbox relay: Codes' own token, events.event.publish, to Events ──
    const t2 = await boot({ relay: true });
    await check('with EVENTS_URL set, the relay publishes codes.app.* with Codes\' own service token', async () => {
        const owner = t2.network.addUser('rel');
        const p = await t2.project(owner);
        const a = await t2.app(owner, p);
        const manifest = JSON.stringify(require('../server/domain/manifests').template('app', { appId: a.id, projectId: p }));
        const c = await t2.get(`/projects/${p}/apps/${a.id}/releases`, { as: owner, form: { kind: 'app', manifest, intent: 'create' } });
        const id = c.headers.get('location').split('/').pop();
        await t2.get(`/releases/${id}/publish`, { as: owner, form: {} });
        for (let i = 0; i < 60 && !t2.events.published.length; i++) await new Promise((r) => setTimeout(r, 50));
        assert.strictEqual(t2.events.published.length, 1);
        assert.strictEqual(t2.events.published[0].sub, 'svc:codes');
        assert.strictEqual(t2.events.published[0].event.event_type, 'codes.app.published');
        const tok = t2.network.tokenRequests.find((x) => x.client_id === 'codes' && x.grant_type === 'client_credentials');
        assert.strictEqual(tok.audience, 'openvibe.events');
        assert.strictEqual(tok.scope, 'events.event.publish');
        const ready = (await t2.get('/api/ready')).json();
        assert.strictEqual(ready.checks.events_relay.status, 'ok');
    });
    await t2.close();
    done();
})();
