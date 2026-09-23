// OpenVibe.Codes — webhook signature checks computed in the browser (Web Crypto), so the secret
// never leaves this page. Without JavaScript (or Web Crypto) the form posts to Codes instead,
// which computes the same HMACs with openvibe-sdk and forgets the secret.
//
// v1: X-OpenVibe-Signature    = sha256=<hex HMAC-SHA256 of the raw body>
// v2: X-OpenVibe-Signature-V2 = t=<unix seconds>,v2=<hex HMAC-SHA256 of "<t>.<raw body>">
// A receiver requiring v2 accepts only a matching v2 within ±300 s of its clock; v1 never decides.
(function () {
    'use strict';
    var WINDOW_SEC = 300;
    var form = document.getElementById('verify-form');
    var out = document.getElementById('verify-result');
    if (!form || !out || !window.crypto || !window.crypto.subtle || !window.TextEncoder) return;
    var enc = new TextEncoder();

    function hex(buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    }
    // Compare every character regardless of where the first difference is.
    function equal(a, b) {
        if (a.length !== b.length) return false;
        var diff = 0;
        for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
        return diff === 0;
    }
    // t and v2 values from the header, parsed as openvibe-sdk does; null when malformed.
    function parseV2(header) {
        var t = null, values = [], parts = header.split(',');
        for (var i = 0; i < parts.length; i++) {
            var at = parts[i].indexOf('=');
            if (at < 0) return null;
            var k = parts[i].slice(0, at).trim(), v = parts[i].slice(at + 1).trim();
            if (k === 't') {
                if (t !== null || !/^\d{1,12}$/.test(v)) return null;
                t = Number(v);
            } else if (k === 'v2') values.push(v);
        }
        return t === null || !values.length ? null : { t: t, values: values };
    }
    function show(ok, lines) {
        out.textContent = '';
        var box = document.createElement('div');
        box.className = 'result ' + (ok ? 'ok' : 'bad');
        box.setAttribute('role', 'status');
        lines.forEach(function (l, i) {
            var p = document.createElement('p');
            if (i === 0) { var s = document.createElement('strong'); s.textContent = l; p.appendChild(s); } else { p.textContent = l; }
            box.appendChild(p);
        });
        out.appendChild(box);
    }

    form.addEventListener('submit', function (e) {
        e.preventDefault();
        var body = form.elements.body.value.replace(/\r\n/g, '\n');
        var given1 = form.elements.signature.value.trim();
        var given2 = form.elements.signature_v2.value.trim();
        var stated = form.elements.timestamp.value.trim();
        var secret = form.elements.secret.value;
        if (!body || !secret) { show(false, ['Enter the raw body and the secret.']); return; }
        var parsed = given2 ? parseV2(given2) : null;
        var nowSec = Date.now() / 1000;
        crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
            .then(function (key) {
                return Promise.all([
                    crypto.subtle.sign('HMAC', key, enc.encode(body)),
                    parsed ? crypto.subtle.sign('HMAC', key, enc.encode(parsed.t + '.' + body)) : null,
                ]);
            })
            .then(function (sigs) {
                var expected1 = 'sha256=' + hex(sigs[0]);
                var ok1 = equal(given1, expected1);
                var lines = [];
                var accepted = false, v2Line;
                if (!given2) {
                    v2Line = 'v2: not given. Events sends X-OpenVibe-Signature-V2 on every delivery; a receiver that requires v2 refuses a delivery without it.';
                } else if (!parsed) {
                    v2Line = 'v2: malformed. It must look like t=<unix seconds>,v2=<64 lowercase hex characters>.';
                } else {
                    var hex2 = hex(sigs[1]);
                    var sigOk = parsed.values.some(function (v) { return equal(v, hex2); });
                    var age = Math.floor(nowSec) - parsed.t;
                    var inside = Math.abs(nowSec - parsed.t) <= WINDOW_SEC;
                    var agree = !stated || stated === String(parsed.t);
                    accepted = sigOk && inside && agree;
                    v2Line = 'v2: signature ' + (sigOk ? 'matches' : 'does NOT match') + '; t=' + parsed.t + ' is ' + (age >= 0 ? age + ' s ago' : (-age) + ' s in the future') +
                        ', ' + (inside ? 'inside' : 'OUTSIDE') + ' the ±' + WINDOW_SEC + ' s window by your clock' +
                        (stated ? '; X-OpenVibe-Timestamp ' + (agree ? 'equals t=' : 'DIFFERS from t= (' + stated + ')') : '') + '.';
                    lines.push('Expected v2: t=' + parsed.t + ',v2=' + hex2);
                }
                lines.unshift(v2Line);
                lines.unshift(accepted ? 'Accepted: v2 verifies and is inside the window.' : 'Refused: a receiver that requires v2 rejects this delivery.');
                lines.push('v1 (reference only, never decides): ' + (given1 ? (ok1 ? 'valid' : 'NOT valid') : 'not given') + '. Expected ' + expected1);
                lines.push('Computed in your browser; nothing was sent.');
                show(accepted, lines);
            })
            .catch(function () { form.submit(); });
    });
})();
