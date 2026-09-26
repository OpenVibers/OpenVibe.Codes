'use strict';
/**
 * The codes_at session cookie must hold a Network SESSION token (audience openvibe.network, a
 * person), not just anything the Network signed. The Network signs FedCM assertions (audience =
 * the relying party's origin, any https://*.openvibe.* origin), app/service tokens and internal
 * tokens with the same key and issuer; none of them is a Codes session.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { signJwt } = require('./helpers/mocks');

(async () => {
    const s = await boot();
    const staff = s.network.addUser('stafferson');
    s.ctx.config.staffSubjects.push(staff.subject);     // as CODES_STAFF_SUBJECTS would
    const APP = 'app_01JABCDEFGHJKMNPQRSTVWXYZ0';

    const now = () => Math.floor(Date.now() / 1000);
    // What POST /fedcm/assertion hands to ANY page on an owned zone the person continues on.
    const fedcm = () => signJwt({
        iss: s.network.url, sub: staff.id, id: staff.id, subject_id: staff.subject, username: staff.username, display_name: staff.username,
        nonce: null, typ: 'fedcm', jti: 'x', aud: 'https://tenant.openvibe.host', iat: now(), exp: now() + 300,
    }, s.network.privatePem);

    await check('a FedCM assertion is not a Codes session (cannot act as staff)', async () => {
        const cookie = `codes_at=${fedcm()}`;
        const page = await s.get('/staff', { cookie });
        assert.notStrictEqual(page.status, 200, 'the staff console must not open for an assertion');
        const body = new URLSearchParams({ app_id: APP, tier: 'first-party', note: 'pwned', csrf: s.csrf(staff) }).toString();
        const r = await s.get('/staff/trust', { cookie, body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        assert.notStrictEqual(r.status, 303, 'the trust tier must not be set');
        assert.strictEqual(s.ctx.trust.get(APP).tier, 'unreviewed');
    });

    await check('an app token is not a Codes session', async () => {
        const token = signJwt({ iss: s.network.url, sub: `app:${APP}`, actor_type: 'app', aud: ['openvibe.network'], cap: ['x.y.z'], subject_id: staff.subject, iat: now(), exp: now() + 300 }, s.network.privatePem);
        const me = await s.get('/auth/me', { cookie: `codes_at=${token}` });
        assert.strictEqual(me.status, 401);
    });

    await check('/auth/me: a guest is signed out (200 { user: null }); a session cookie that fails is 401', async () => {
        const guest = await s.get('/auth/me');
        assert.strictEqual(guest.status, 200, 'no session cookie at all: not an error');
        assert.deepStrictEqual(JSON.parse(guest.text), { user: null });
        assert.strictEqual(guest.headers.get('cache-control'), 'private, no-store');
        assert.strictEqual((await s.get('/auth/me', { cookie: 'codes_at=garbage' })).status, 401, 'a present but invalid access cookie');
        assert.strictEqual((await s.get('/auth/me', { cookie: 'codes_rt=stale' })).status, 401, 'a refresh cookie alone is a session that did not resolve');
        assert.strictEqual((await s.get('/auth/me', { as: staff })).status, 200);
    });

    await check('a real Network session token still signs the staff member in', async () => {
        const page = await s.get('/staff', { as: staff });
        assert.strictEqual(page.status, 200, page.text.slice(0, 200));
        const r = await s.get('/staff/trust', { as: staff, form: { app_id: APP, tier: 'reviewed', note: 'checked' } });
        assert.strictEqual(r.status, 303);
        assert.strictEqual(s.ctx.trust.get(APP).tier, 'reviewed');
    });

    await check('another site cannot sign a person out; this site can', async () => {
        const cross = await s.get('/auth/logout', { as: staff, headers: { 'sec-fetch-site': 'cross-site' } });
        assert.strictEqual(cross.status, 200, 'a confirm page, not a sign-out');
        assert.ok(!/codes_at=;|codes_at=deleted/i.test(String(cross.headers.get('set-cookie') || '')), 'the session cookie is kept');
        assert.match(cross.text, /method="post"/);
        const crossPost = await s.get('/auth/logout', { as: staff, method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } });
        assert.strictEqual(crossPost.status, 403);
        const same = await s.get('/auth/logout?next=/projects', { as: staff, headers: { 'sec-fetch-site': 'same-origin' } });
        assert.strictEqual(same.status, 303);
        assert.strictEqual(same.headers.get('location'), '/projects');
        assert.match(String(same.headers.get('set-cookie') || ''), /codes_at=;/);
    });

    await s.close();
    done();
})();
