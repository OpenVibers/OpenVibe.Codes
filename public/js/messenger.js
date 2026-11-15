/* openvibe.codes, signed in: the start page is the network's messenger full-page (openvibe-shared ov-run.js
   OpenVibeRun.page, 4.250.0; plan §AB.8/47, the owner: "Combine, remake entire system … the same conversation system
   everywhere"). Your agents and conversations on the left, the open one on the right; one box for everything, and one
   engine (the Frame's Run API) decides per message whether it is code, a chat, a task or a computer's work, so a coding
   task started here is the same run in the menu's Vibe on every site.
   It takes over only once ov-run.js has `page` and the navbar has the person's token: until then, and when either never
   comes, the server-rendered page (public/js/chat.js) stays and works. ?prompt= fills the box. */
(function () {
  'use strict';
  var app = document.querySelector('[data-chat]');
  if (!app) return;
  var STARTERS = [
    ['code', 'Make me a one-page site for my stream'],
    ['code', 'Fix a bug in one of my repositories'],
    ['spark', 'Build a goal bar overlay for my stream'],
    ['search', 'What changed in OpenVibe this week?'],
  ];
  function loadRun() {
    if (window.OpenVibeRun && window.OpenVibeRun.page) return Promise.resolve(window.OpenVibeRun);
    return new Promise(function (resolve, reject) {
      var sc = document.createElement('script'); sc.src = '/shared/ov-run.js'; sc.async = true;
      sc.onload = function () { return window.OpenVibeRun && window.OpenVibeRun.page ? resolve(window.OpenVibeRun) : reject(new Error('ov-run.js has no page')); };
      sc.onerror = function () { reject(new Error('ov-run.js')); };
      document.head.appendChild(sc);
    });
  }
  // 11-15 (the owner: the messenger is Actor's; Codes gets "a coding agent harness layout … the same underlying shared
  // modular powerful system"): openvibe-shared 4.257.0's ov-harness.js draws the same runs as a harness (projects and
  // their threads, the thread, what it changed). Before Codes serves it, the messenger stays.
  function loadHarness() {
    if (window.OpenVibeHarness && window.OpenVibeHarness.page) return Promise.resolve(window.OpenVibeHarness);
    return new Promise(function (resolve) {
      var sc = document.createElement('script'); sc.src = '/shared/ov-harness.js'; sc.async = true;
      sc.onload = function () { resolve(window.OpenVibeHarness && window.OpenVibeHarness.page ? window.OpenVibeHarness : null); };
      sc.onerror = function () { resolve(null); };
      document.head.appendChild(sc);
    });
  }
  /** The person's recent repositories, as the server-rendered page lists them (its chips and its repository field). */
  function recentRepos() {
    var out = [];
    app.querySelectorAll('[data-ch-saved-repo]').forEach(function (b) { var t = (b.textContent || '').trim(); if (t && out.indexOf(t) < 0) out.push(t); });
    var field = app.querySelector('input[name="repo"]');
    var v = field && field.value ? String(field.value).trim().replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '') : '';
    if (v && out.indexOf(v) < 0) out.unshift(v);
    return out.slice(0, 8);
  }
  function tokenSoon() {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function look() {
        var N = window.OpenVibeNavbar; var t = N && typeof N.token === 'function' ? N.token() : null;
        if (t) return resolve(t);
        if (Date.now() - start > 8000) return resolve(null);
        setTimeout(look, 150);
      })();
    });
  }
  var q = null; try { q = new URLSearchParams(location.search); } catch (e) { q = null; }
  var prompt = q ? String(q.get('prompt') || '').slice(0, 4000) : '';
  var open = q ? String(q.get('run') || '') : '';
  Promise.all([loadRun(), tokenSoon()]).then(function (got) {
    var R = got[0], token = got[1];
    if (!token) return;
    return loadHarness().then(function (H) { show(R, H, token); });
  }).catch(function () { /* ov-run.js did not load: the server-rendered page stays */ });

  function show(R, H, token) {
    var repos = recentRepos();
    var host = document.createElement('div'); host.className = 'co-messenger';
    app.replaceWith(host);
    document.documentElement.classList.add('co-has-messenger');
    var opened = /^[a-z][a-z0-9-]{0,30}:[A-Za-z0-9._~-]{1,160}$/.test(open) ? open : null;
    var place = function (p) {
      try { if (p && p.ref) history.replaceState(null, '', '/?run=' + encodeURIComponent(p.ref)); else if (p && p.blank) history.replaceState(null, '', '/'); } catch (e) { /* the address stays */ }
    };
    if (H) {
      document.documentElement.classList.add('co-has-harness');
      var h = H.page(host, {
        base: 'https://openvibe.network/api/frame',
        token: function () { var N = window.OpenVibeNavbar; return (N && N.token && N.token()) || token; },
        sibling: function (file) { return '/shared/' + file; },
        repos: repos,
        target: repos[0] ? { repo: repos[0] } : 'new',
        open: opened,
        onPlace: place,
      });
      if (prompt && h && typeof h.prefill === 'function') h.prefill(prompt);
      return;
    }
    var page = R.page(host, {
      base: 'https://openvibe.network/api/frame',
      token: function () { var N = window.OpenVibeNavbar; return (N && N.token && N.token()) || token; },
      agent: true, starters: STARTERS,
      actions: { base: 'https://openvibe.network' },
      sibling: function (file) { return '/shared/' + file; },
      open: opened,
      onPlace: place,
    });
    if (prompt && page.main && page.main.prefill) page.main.prefill(prompt);
  }
})();
