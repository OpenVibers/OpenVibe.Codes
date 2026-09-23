'use strict';
/**
 * Webhook signature verification, v1 and v2: correct against independent HMACs, rejects tampering,
 * wrong secrets, prefixes, lengths and malformed headers, applies the ±300 s v2 window exactly as
 * openvibe-sdk's parseDelivery(..., { requireV2: true }) does (v2 decides; v1 never rescues it),
 * compares in constant time (crypto.timingSafeEqual), and sample deliveries carry v1 and v2 that
 * the SDK receivers use accept. The no-JS path works through the server.
 */
const assert = require('assert');
const crypto = require('crypto');
const contracts = require('openvibe-contracts');
const { verifyDelivery, verifyDeliveryV2, parseDelivery } = require('openvibe-sdk/events');
const webhooks = require('../server/domain/webhooks');
const { boot, check, done } = require('./helpers/boot');

const hmac = (body, secret) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

(async () => {
    const secret = 'whsec_' + crypto.randomBytes(16).toString('hex');
    const body = JSON.stringify({ event: { event_id: contracts.ids.newId('event'), event_type: 'network.app.created', version: 1, source: 'network', actor: { type: 'system', id: 'network' }, timestamp: new Date().toISOString(), subject: { type: 'app', id: 'app_1' }, payload: {} }, seq: 7 });

    // A clock 0.7 s into a second: ages are whole seconds, the window is checked on the exact time.
    const nowSec = Math.floor(Date.now() / 1000);
    const nowMs = nowSec * 1000 + 700;
    const v2 = (b, sec, ts) => `t=${ts},v2=${crypto.createHmac('sha256', sec).update(`${ts}.${b}`).digest('hex')}`;

    await check('v1: a correct signature verifies (independent HMAC-SHA256 of the raw body)', async () => {
        const v = webhooks.inspect({ rawBody: body, signature: hmac(body, secret), secret });
        assert.strictEqual(v.v1.valid, true);
        assert.strictEqual(v.v1.expected, hmac(body, secret));
        assert.strictEqual(v.parsed.event_type, 'network.app.created');
        assert.strictEqual(v.parsed.seq, 7);
    });

    await check('v1: tampered body, wrong secret, missing prefix, wrong length, uppercase hex: all rejected', async () => {
        const good = hmac(body, secret);
        const v1 = (o) => webhooks.inspect({ rawBody: body, signature: good, secret, ...o }).v1;
        assert.strictEqual(v1({ rawBody: body.replace('"seq":7', '"seq":8') }).valid, false);
        assert.strictEqual(v1({ secret: secret + 'x' }).valid, false);
        const noPrefix = v1({ signature: good.slice(7) });
        assert.strictEqual(noPrefix.valid, false);
        assert.match(noPrefix.reason, /sha256=/);
        const short = v1({ signature: good.slice(0, -2) });
        assert.strictEqual(short.valid, false);
        assert.match(short.reason, /wrong length/);
        assert.strictEqual(v1({ signature: good.toUpperCase().replace('SHA256=', 'sha256=') }).valid, false);
        // Re-serialised JSON (same data, different bytes) must fail: verification is over raw bytes.
        assert.strictEqual(v1({ rawBody: JSON.stringify(JSON.parse(body), null, 1) }).valid, false);
    });

    await check('v2: a fresh, correct signature is accepted (independent HMAC of "<t>.<raw body>")', async () => {
        const v = webhooks.inspect({ rawBody: body, signature: hmac(body, secret), signatureV2: v2(body, secret, nowSec), timestamp: String(nowSec), secret, now: nowMs });
        assert.strictEqual(v.accepted, true);
        assert.strictEqual(v.v2.valid, true);
        assert.strictEqual(v.v2.signatureValid, true);
        assert.strictEqual(v.v2.withinWindow, true);
        assert.strictEqual(v.v2.timestampsAgree, true);
        assert.strictEqual(v.v2.timestamp, nowSec);
        assert.strictEqual(v.v2.expected, v2(body, secret, nowSec));
        assert.strictEqual(v.v2.windowSec, 300);
        assert.strictEqual(v.v1.valid, true, 'v1 is still checked and shown');
    });

    await check('v2: the ±300 s window, both directions, with the signature told apart from the time', async () => {
        const at = (ts) => webhooks.inspect({ rawBody: body, signatureV2: v2(body, secret, ts), secret, now: nowMs });
        assert.strictEqual(at(nowSec - 299).accepted, true);
        assert.strictEqual(at(nowSec + 299).accepted, true);
        const stale = at(nowSec - 301);
        assert.strictEqual(stale.accepted, false);
        assert.strictEqual(stale.v2.signatureValid, true, 'the HMAC matches; only the time is wrong');
        assert.strictEqual(stale.v2.withinWindow, false);
        assert.strictEqual(stale.v2.ageSec, 301);
        assert.match(stale.v2.reason, /301 s in the past, outside the ±300 s window/);
        const future = at(nowSec + 400);
        assert.strictEqual(future.accepted, false);
        assert.strictEqual(future.v2.withinWindow, false);
        assert.match(future.v2.reason, /in the future/);
        // Agrees with the SDK a receiver uses.
        for (const ts of [nowSec - 301, nowSec - 299, nowSec + 299, nowSec + 301]) {
            const headers = { 'x-openvibe-signature-v2': v2(body, secret, ts) };
            assert.strictEqual(at(ts).accepted, parseDelivery(body, headers, secret, { requireV2: true, now: nowMs }) !== null, `t offset ${ts - nowSec}`);
        }
    });

    await check('v2: wrong secret, tampered body, a v2 signed for another t, malformed and mismatched headers: refused', async () => {
        const good = v2(body, secret, nowSec);
        const run = (o) => webhooks.inspect({ rawBody: body, signatureV2: good, secret, now: nowMs, ...o });
        const wrongSecret = run({ secret: secret + 'x' });
        assert.strictEqual(wrongSecret.accepted, false);
        assert.strictEqual(wrongSecret.v2.signatureValid, false);
        assert.match(wrongSecret.v2.reason, /does not match/);
        assert.strictEqual(run({ rawBody: body.replace('"seq":7', '"seq":8') }).accepted, false);
        // The HMAC for one time moved onto another: the time is covered by the signature.
        const moved = run({ signatureV2: good.replace(`t=${nowSec}`, `t=${nowSec - 1}`) });
        assert.strictEqual(moved.accepted, false);
        assert.strictEqual(moved.v2.signatureValid, false);
        for (const bad of ['v2=abc', `t=${nowSec}`, `t=x,v2=${'0'.repeat(64)}`, 'nonsense', `t=${nowSec},t=${nowSec},v2=${'0'.repeat(64)}`]) {
            const r = run({ signatureV2: bad });
            assert.strictEqual(r.accepted, false, bad);
            assert.match(r.v2.reason, /t=<unix seconds>,v2=/, bad);
        }
        const short = run({ signatureV2: good.slice(0, -2) });
        assert.match(short.v2.reason, /wrong length/);
        const mismatch = run({ timestamp: String(nowSec - 5) });
        assert.strictEqual(mismatch.accepted, false);
        assert.strictEqual(mismatch.v2.signatureValid, true);
        assert.strictEqual(mismatch.v2.timestampsAgree, false);
        assert.match(mismatch.v2.reason, /X-OpenVibe-Timestamp \(\d+\) is not the t=/);
    });

    await check('v2 decides: a valid v1 alone is refused, and a valid v1 never rescues a bad v2', async () => {
        const v1Only = webhooks.inspect({ rawBody: body, signature: hmac(body, secret), secret, now: nowMs });
        assert.strictEqual(v1Only.v1.valid, true);
        assert.strictEqual(v1Only.v2.present, false);
        assert.strictEqual(v1Only.accepted, false);
        assert.match(v1Only.v2.reason, /no X-OpenVibe-Signature-V2/);
        const staleWithV1 = webhooks.inspect({ rawBody: body, signature: hmac(body, secret), signatureV2: v2(body, secret, nowSec - 3600), secret, now: nowMs });
        assert.strictEqual(staleWithV1.v1.valid, true);
        assert.strictEqual(staleWithV1.accepted, false);
    });

    await check('the comparisons are constant-time (crypto.timingSafeEqual on equal-length buffers)', async () => {
        const orig = crypto.timingSafeEqual;
        let calls = 0;
        crypto.timingSafeEqual = (a, b) => { calls++; assert.strictEqual(a.length, b.length); return orig(a, b); };
        try {
            webhooks.inspect({ rawBody: body, signature: hmac(body, secret), secret });
            webhooks.inspect({ rawBody: body, signature: hmac(body, 'other'), secret });
            assert.strictEqual(calls, 2, 'every equal-length v1 comparison goes through timingSafeEqual');
            calls = 0;
            webhooks.inspect({ rawBody: body, signatureV2: v2(body, 'other', nowSec), secret, now: nowMs });
            assert.ok(calls >= 1, 'the v2 comparison goes through timingSafeEqual');
        } finally { crypto.timingSafeEqual = orig; }
    });

    await check('a generated sample carries v1, X-OpenVibe-Timestamp and v2, and the SDK receiver requiring v2 accepts it', async () => {
        const s = webhooks.sample({ eventType: 'media.object.ready', secret, producer: 'media', now: nowMs });
        assert.strictEqual(s.envelopeValid, true, JSON.stringify(s.envelopeErrors));
        const headers = Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k.toLowerCase(), v]));
        assert.strictEqual(verifyDelivery(s.body, headers['x-openvibe-signature'], secret), true);
        assert.strictEqual(headers['x-openvibe-timestamp'], String(nowSec));
        assert.strictEqual(headers['x-openvibe-signature-v2'], v2(s.body, secret, nowSec));
        assert.strictEqual(verifyDeliveryV2(s.body, headers, secret, { now: nowMs }), true);
        const parsed = parseDelivery(s.body, headers, secret, { requireV2: true, now: nowMs });
        assert.strictEqual(parsed.event.event_type, 'media.object.ready');
        assert.strictEqual(parsed.seq, 1);
        assert.strictEqual(contracts.validate('events.event-envelope@1', parsed.event).valid, true);
        assert.strictEqual(parseDelivery(s.body, headers, secret, { requireV2: true, now: nowMs + 301_000 }), null, 'the sample goes stale after 300 s');
        assert.strictEqual(verifyDelivery(s.body, headers['x-openvibe-signature'], 'wrong'), false);
        assert.deepStrictEqual(JSON.parse(s.body).event.payload, {}, 'no invented payload');
        // What the tester says about its own sample.
        const v = webhooks.inspect({ rawBody: s.body, signature: headers['x-openvibe-signature'], signatureV2: headers['x-openvibe-signature-v2'], timestamp: headers['x-openvibe-timestamp'], secret, now: nowMs });
        assert.strictEqual(v.accepted, true);
    });

    const t = await boot();

    await check('no-JS path: the server checks v2 and v1, shows the window, and says why a delivery is refused', async () => {
        const ts = Math.floor(Date.now() / 1000);
        const ok = await t.get('/tools/webhooks/verify', { form: { body, signature: hmac(body, secret), signature_v2: v2(body, secret, ts), timestamp: String(ts), secret } });
        assert.strictEqual(ok.status, 200);
        assert.match(ok.text, /Accepted: v2 verifies and is inside the window\./);
        assert.match(ok.text, /badge ok">inside</);
        assert.match(ok.text, /v1 \(X-OpenVibe-Signature\) <span class="badge ok">valid/);
        const stale = await t.get('/tools/webhooks/verify', { form: { body, signature: hmac(body, secret), signature_v2: v2(body, secret, ts - 600), secret } });
        assert.strictEqual(stale.status, 422);
        assert.match(stale.text, /Refused: a receiver that requires v2 rejects this delivery\./);
        assert.match(stale.text, /badge warn">stale</);
        assert.match(stale.text, /badge bad">outside</);
        const v1Only = await t.get('/tools/webhooks/verify', { form: { body, signature: hmac(body, secret), secret } });
        assert.strictEqual(v1Only.status, 422);
        assert.match(v1Only.text, /no X-OpenVibe-Signature-V2 value given/);
        const bad = await t.get('/tools/webhooks/verify', { form: { body, signature: hmac(body, 'nope'), signature_v2: v2(body, 'nope', ts), secret } });
        assert.strictEqual(bad.status, 422);
        assert.match(bad.text, /v2 \(X-OpenVibe-Signature-V2\) <span class="badge bad">NOT valid/);
        for (const r of [ok, stale, v1Only, bad]) {
            assert.ok(!r.text.includes(secret));
            assert.match(r.text, /<input type="password" name="secret" value=""/);
        }
        assert.ok(ok.text.includes(`value="${v2(body, secret, ts)}"`), 'the v2 header comes back in the form');
    });

    await check('no-JS path: sample generation for an event type from the contracts catalog', async () => {
        const r = await t.get('/tools/webhooks/sample', { form: { event_type: 'network.credential.rotated', secret } });
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /X-OpenVibe-Signature-V2/);
        assert.match(r.text, /X-OpenVibe-Timestamp/);
        assert.match(r.text, /The envelope validates/);
        const unknown = await t.get('/tools/webhooks/sample', { form: { event_type: 'made.up.event', secret } });
        assert.strictEqual(unknown.status, 422);
    });

    await check('the page offers only event types some service manifest produces', async () => {
        const r = await t.get('/tools/webhooks');
        const offered = [...r.text.matchAll(/<option(?: selected)?>([^<]+)<\/option>/g)].map((m) => m[1]).sort();
        const expected = [...new Set(contracts.services.manifests.flatMap((m) => m.eventsProduced || []))].sort();
        assert.deepStrictEqual(offered, expected);
    });

    await t.close();
    done();
})();
