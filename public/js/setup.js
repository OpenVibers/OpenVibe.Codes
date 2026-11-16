// /setup's own script (loaded there only). Copy buttons (the guided setup's commands): the code beside the button goes to the clipboard, and the button says so.
// Where the clipboard is refused, the command is selected instead, for the person to copy.
(function () {
    'use strict';
    document.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-c4-copy]') : null;
        if (!btn) return;
        var code = btn.parentNode && btn.parentNode.querySelector('code');
        if (!code) return;
        var text = code.textContent || '';
        var said = function (word) { btn.textContent = word; window.setTimeout(function () { btn.textContent = 'Copy'; }, 1600); };
        var select = function () { var r = document.createRange(); r.selectNodeContents(code); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); said('Selected'); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { said('Copied'); }, select);
        else select();
    });
})();

// Sign in on a machine, from here (2026-11-16): the agent's own sign-in runs on the machine you chose, in your sandbox
// there; its link opens here, and the code it shows goes back from here. Every step says where it is.
(function () {
    'use strict';
    var URL_RE = /https:\/\/[^\s"'<>\u001b]+/g;
    function step(box, name) {
        var order = ['start', 'link', 'code', 'done'];
        var at = order.indexOf(name);
        box.querySelectorAll('.c4-signin-steps li').forEach(function (li) {
            var i = order.indexOf(li.getAttribute('data-step'));
            li.classList.toggle('is-done', i < at || (name === 'done' && i === at));
            li.classList.toggle('is-now', i === at && name !== 'done');
        });
    }
    function say(box, text, bad) {
        var p = box.querySelector('.c4-signin-say');
        p.textContent = text;
        p.classList.toggle('is-bad', !!bad);
    }
    function pick(box) {
        var on = box.querySelector('[data-c4-signin-machine].is-on') || box.querySelector('[data-c4-signin-machine]');
        return on ? on.getAttribute('data-c4-signin-machine') : '';
    }
    document.addEventListener('click', function (e) {
        var chip = e.target && e.target.closest ? e.target.closest('[data-c4-signin-machine]') : null;
        if (chip) {
            chip.parentNode.querySelectorAll('[data-c4-signin-machine]').forEach(function (b) { b.classList.toggle('is-on', b === chip); b.setAttribute('aria-pressed', b === chip ? 'true' : 'false'); });
            return;
        }
        var start = e.target && e.target.closest ? e.target.closest('[data-c4-signin-start]') : null;
        if (!start) return;
        var box = start.closest('[data-c4-signin]');
        var agent = box.getAttribute('data-c4-signin');
        var name = box.getAttribute('data-name') || agent;
        var live = box.querySelector('.c4-signin-live');
        start.disabled = true;
        live.hidden = false;
        box.classList.add('is-going');
        step(box, 'start');
        say(box, 'Asking your machine to start ' + name + '\u2019s sign-in\u2026');
        fetch('/api/v1/me/agents/' + encodeURIComponent(agent) + '/sign-in', {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ machine: pick(box) }),
        }).then(function (r) { return r.json().then(function (doc) { return { ok: r.ok, doc: doc }; }); }).then(function (res) {
            if (!res.ok) throw new Error((res.doc && (res.doc.detail || res.doc.title)) || 'The sign-in could not start');
            var job = res.doc.job_id;
            var text = '';
            var linked = false;
            var source = new EventSource('/api/v1/me/agents/sign-in/' + encodeURIComponent(job) + '/events');
            source.addEventListener('state', function (ev) {
                try { var s = JSON.parse(ev.data).state; if (s === 'running' && !linked) say(box, 'Your machine is getting ' + name + ' ready\u2026'); } catch (err) { /* */ }
            });
            source.addEventListener('output', function (ev) {
                try { text += (JSON.parse(ev.data).chunk || ''); } catch (err) { return; }
                if (linked) return;
                var urls = text.match(URL_RE) || [];
                var url = urls.filter(function (u) { return /oauth|authorize|login|device/i.test(u); })[0] || urls[0];
                if (!url) return;
                linked = true;
                var a = box.querySelector('[data-c4-signin-link]');
                a.href = url;
                a.hidden = false;
                a.classList.add('is-in');
                step(box, 'link');
                say(box, 'Open the sign-in page, approve, and paste the code it shows.');
                var form = box.querySelector('[data-c4-signin-code]');
                form.hidden = false;
                a.addEventListener('click', function () { step(box, 'code'); setTimeout(function () { var i = form.querySelector('input'); if (i) i.focus(); }, 300); });
                form.addEventListener('submit', function (fe) {
                    fe.preventDefault();
                    var input = form.querySelector('input');
                    var code = (input.value || '').trim();
                    if (!code) return;
                    form.querySelector('button').disabled = true;
                    say(box, 'Sending the code to your machine\u2026');
                    fetch('/api/v1/me/agents/sign-in/' + encodeURIComponent(job) + '/code', {
                        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                        body: JSON.stringify({ code: code }),
                    }).then(function (r) { if (!r.ok) throw new Error('The code did not reach your machine'); say(box, 'Your machine is checking the code\u2026'); })
                        .catch(function (err) { form.querySelector('button').disabled = false; say(box, err.message, true); });
                });
            });
            source.addEventListener('end', function () {
                source.close();
                var ok = /is signed in\./.test(text);
                step(box, ok ? 'done' : 'code');
                box.classList.toggle('is-done', ok);
                say(box, ok ? name + ' is signed in on your machine. It stays signed in there for your next tasks.' : (/did not sign in|Invalid code/i.test(text) ? 'That did not sign in. Try again, and paste the newest code.' : 'The sign-in ended without signing in.'), !ok);
                start.disabled = false;
                start.textContent = ok ? 'Signed in' : 'Try again';
                if (ok) start.disabled = true;
            });
        }).catch(function (err) {
            start.disabled = false;
            say(box, err.message || 'The sign-in could not start', true);
        });
    });
})();
