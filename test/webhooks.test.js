'use strict';
/**
 * Webhook signature verification: correct against an independent HMAC, rejects tampering, wrong
 * secrets, prefixes and lengths, compares in constant time (crypto.timingSafeEqual), and sample
 * deliveries verify with the SDK receivers use. The no-JS path works through the server.
 */
const assert = require('assert');
const crypto = require('crypto');
const contracts = require('openvibe-contracts');
const { verifyDelivery, parseDelivery } = require('openvibe-sdk/events');
const webhooks = require('../server/domain/webhooks');
const { boot, check, done } = require('./helpers/boot');

const hmac = (body, secret) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

(async () => {
    const secret = 'whsec_' + crypto.randomBytes(16).toString('hex');
    const body = JSON.stringify({ event: { event_id: contracts.ids.newId('event'), event_type: 'network.app.created', version: 1, source: 'network', actor: { type: 'system', id: 'network' }, timestamp: new Date().toISOString(), subject: { type: 'app', id: 'app_1' }, payload: {} }, seq: 7 });

    await check('a correct signature verifies (independent HMAC-SHA256 of the raw body)', async () => {
        const v = webhooks.inspect({ rawBody: body, signature: hmac(body, secret), secret });
        assert.strictEqual(v.valid, true);
        assert.strictEqual(v.expected, hmac(body, secret));
        assert.strictEqual(v.parsed.event_type, 'network.app.created');
        assert.strictEqual(v.parsed.seq, 7);
    });

    await check('tampered body, wrong secret, missing prefix, wrong length, uppercase hex: all rejected', async () => {
        const good = hmac(body, secret);
        assert.strictEqual(webhooks.inspect({ rawBody: body.replace('"seq":7', '"seq":8'), signature: good, secret }).valid, false);
        assert.strictEqual(webhooks.inspect({ rawBody: body, signature: good, secret: secret + 'x' }).valid, false);
        const noPrefix = webhooks.inspect({ rawBody: body, signature: good.slice(7), secret });
        assert.strictEqual(noPrefix.valid, false);
        assert.match(noPrefix.reason, /sha256=/);
        const short = webhooks.inspect({ rawBody: body, signature: good.slice(0, -2), secret });
        assert.strictEqual(short.valid, false);
        assert.match(short.reason, /wrong length/);
        assert.strictEqual(webhooks.inspect({ rawBody: body, signature: good.toUpperCase().replace('SHA256=', 'sha256='), secret }).valid, false);
        // Re-serialised JSON (same data, different bytes) must fail: verification is over raw bytes.
        assert.strictEqual(webhooks.inspect({ rawBody: JSON.stringify(JSON.parse(body), null, 1), signature: good, secret }).valid, false);
    });

    await check('the comparison is constant-time (crypto.timingSafeEqual on equal-length buffers)', async () => {
        const orig = crypto.timingSafeEqual;
        let calls = 0;
        crypto.timingSafeEqual = (a, b) => { calls++; assert.strictEqual(a.length, b.length); return orig(a, b); };
        try {
            webhooks.inspect({ rawBody: body, signature: hmac(body, secret), secret });
            const wrong = hmac(body, 'other');
            webhooks.inspect({ rawBody: body, signature: wrong, secret });
        } finally { crypto.timingSafeEqual = orig; }
        assert.strictEqual(calls, 2, 'every equal-length comparison goes through timingSafeEqual');
    });

    await check('a generated sample is a valid envelope, signed so the SDK receiver accepts it', async () => {
        const s = webhooks.sample({ eventType: 'media.object.ready', secret, producer: 'media' });
        assert.strictEqual(s.envelopeValid, true, JSON.stringify(s.envelopeErrors));
        const headers = Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k.toLowerCase(), v]));
        assert.strictEqual(verifyDelivery(s.body, headers['x-openvibe-signature'], secret), true);
        const parsed = parseDelivery(s.body, headers, secret);
        assert.strictEqual(parsed.event.event_type, 'media.object.ready');
        assert.strictEqual(parsed.seq, 1);
        assert.strictEqual(contracts.validate('events.event-envelope@1', parsed.event).valid, true);
        assert.strictEqual(verifyDelivery(s.body, headers['x-openvibe-signature'], 'wrong'), false);
        assert.deepStrictEqual(JSON.parse(s.body).event.payload, {}, 'no invented payload');
    });

    const t = await boot();

    await check('no-JS path: the server verifies and says why a signature fails', async () => {
        const ok = await t.get('/tools/webhooks/verify', { form: { body, signature: hmac(body, secret), secret } });
        assert.strictEqual(ok.status, 200);
        assert.match(ok.text, /Signature valid\./);
        const bad = await t.get('/tools/webhooks/verify', { form: { body, signature: hmac(body, 'nope'), secret } });
        assert.strictEqual(bad.status, 422);
        assert.match(bad.text, /Signature NOT valid\./);
        assert.ok(!ok.text.includes(secret) && !bad.text.includes(secret));
        assert.match(ok.text, /<input type="password" name="secret" value=""/);
    });

    await check('no-JS path: sample generation for an event type from the contracts catalog', async () => {
        const r = await t.get('/tools/webhooks/sample', { form: { event_type: 'network.credential.rotated', secret } });
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /X-OpenVibe-Signature/);
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
