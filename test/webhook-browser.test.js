'use strict';
/**
 * public/js/webhook.js (the in-browser verifier) decides as the server and openvibe-sdk do: run in a
 * vm with Node's Web Crypto and a minimal stand-in for the form, it accepts a fresh v2 and refuses a
 * stale, wrong or missing v2. It checks v2 only: the retired v1 header (2026-09-28, shim C-61) has
 * no field and is neither read nor computed.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, done } = require('./helpers/boot');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'webhook.js'), 'utf8');

/** Runs webhook.js against a fake form; resolves with the text of the result box. */
function runBrowser(fields, nowMs) {
    return new Promise((resolve, reject) => {
        const el = (tag) => ({ tag, className: '', children: [], textContent: '', setAttribute() {}, appendChild(c) { this.children.push(c); } });
        const out = el('div');
        let submitHandler = null;
        const form = {
            // A Proxy, so reading a field the page does not have (the retired v1 one) fails the test.
            elements: new Proxy(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: v }])), {
                get(target, k) {
                    if (typeof k === 'string' && !(k in target)) throw new Error(`the script read form field ${k}`);
                    return target[k];
                },
            }),
            addEventListener: (type, fn) => { if (type === 'submit') submitHandler = fn; },
            submit: () => reject(new Error('fell back to the server')),
        };
        const text = (n) => (n.children.length ? n.children.map(text).join(' ') : n.textContent);
        // The script clears the result box with textContent = ''.
        Object.defineProperty(out, 'textContent', { set() { out.children = []; }, get() { return ''; } });
        const document = {
            getElementById: (id) => (id === 'verify-form' ? form : id === 'verify-result' ? out : null),
            createElement: el,
        };
        const window = { crypto: globalThis.crypto, TextEncoder };
        const DateStub = { now: () => nowMs };
        vm.runInNewContext(SRC, { window, document, crypto: globalThis.crypto, TextEncoder, Promise, Date: DateStub });
        assert.ok(submitHandler, 'the script binds the form');
        submitHandler({ preventDefault() {} });
        const wait = () => (out.children.length ? resolve({ ok: out.children[0].className.includes(' ok'), text: text(out.children[0]) }) : setTimeout(wait, 5));
        wait();
    });
}

(async () => {
    const secret = 'whsec_' + crypto.randomBytes(16).toString('hex');
    const body = JSON.stringify({ event: { event_type: 'media.object.ready' }, seq: 3 });
    const nowMs = 1_790_000_000_000;
    const nowSec = nowMs / 1000;
    const v2 = (ts, sec = secret) => `t=${ts},v2=${crypto.createHmac('sha256', sec).update(`${ts}.${body}`).digest('hex')}`;
    const fields = (o) => ({ body, signature_v2: '', timestamp: '', secret, ...o });

    await check('a fresh v2 is accepted, computed in the browser', async () => {
        const r = await runBrowser(fields({ signature_v2: v2(nowSec), timestamp: String(nowSec) }), nowMs);
        assert.strictEqual(r.ok, true, r.text);
        assert.match(r.text, /Accepted/);
        assert.match(r.text, /inside the ±300 s window/);
        assert.match(r.text, /nothing was sent/);
    });

    await check('a v2 301 s old matches but is refused as outside the window', async () => {
        const r = await runBrowser(fields({ signature_v2: v2(nowSec - 301) }), nowMs);
        assert.strictEqual(r.ok, false);
        assert.match(r.text, /signature matches; t=\d+ is 301 s ago, OUTSIDE/);
    });

    await check('no v2 is refused; a wrong v2 is refused; a differing X-OpenVibe-Timestamp is refused', async () => {
        const noV2 = await runBrowser(fields({}), nowMs);
        assert.strictEqual(noV2.ok, false);
        assert.match(noV2.text, /v2: not given/);
        const wrong = await runBrowser(fields({ signature_v2: v2(nowSec, 'other') }), nowMs);
        assert.strictEqual(wrong.ok, false);
        assert.match(wrong.text, /does NOT match/);
        const differs = await runBrowser(fields({ signature_v2: v2(nowSec), timestamp: String(nowSec - 1) }), nowMs);
        assert.strictEqual(differs.ok, false);
        assert.match(differs.text, /DIFFERS from t=/);
        const malformed = await runBrowser(fields({ signature_v2: 'v2=abc' }), nowMs);
        assert.match(malformed.text, /malformed/);
    });

    await check('v2 only: the result has no v1 line and the script reads no v1 field', async () => {
        const r = await runBrowser(fields({ signature_v2: v2(nowSec) }), nowMs);
        assert.strictEqual(r.ok, true, r.text);
        assert.doesNotMatch(r.text, /v1|sha256=/);
        assert.doesNotMatch(SRC, /elements\.signature\b(?!_v2)/, 'no v1 field is read');
        assert.doesNotMatch(SRC, /sha256=/, 'no v1 value is computed');
    });

    done();
})();
