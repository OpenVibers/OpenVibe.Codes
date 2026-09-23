// OpenVibe.Codes — webhook signature check computed in the browser (Web Crypto), so the secret
// never leaves this page. Without JavaScript (or Web Crypto) the form posts to Codes instead,
// which computes the same HMAC and forgets the secret.
(function () {
    'use strict';
    var form = document.getElementById('verify-form');
    var out = document.getElementById('verify-result');
    if (!form || !out || !window.crypto || !window.crypto.subtle || !window.TextEncoder) return;

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
        var given = form.elements.signature.value.trim();
        var secret = form.elements.secret.value;
        if (!body || !secret) { show(false, ['Enter the raw body and the secret.']); return; }
        var enc = new TextEncoder();
        crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
            .then(function (key) { return crypto.subtle.sign('HMAC', key, enc.encode(body)); })
            .then(function (sig) {
                var expected = 'sha256=' + hex(sig);
                var ok = equal(given, expected);
                show(ok, [ok ? 'Signature valid.' : 'Signature NOT valid.', 'Expected: ' + expected, 'Given: ' + (given || '(none)'), 'Computed in your browser; nothing was sent.']);
            })
            .catch(function () { form.submit(); });
    });
})();
