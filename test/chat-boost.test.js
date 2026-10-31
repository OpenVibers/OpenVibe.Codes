'use strict';
// public/js/chat.js after a page move (the owner, 2026-10-31, a phone: "I can't open… the menu" on Machines). Codes
// moves between pages with openvibe-shared/boost, which swaps <main> without running the page's scripts again: a move
// from Agents to Machines (the same scripts) left the new page with no handlers. The rail is now the network's sidebar,
// which kit-web.js opens on the document (openvibe-shared test/kit.test.js); chat.js still owns the side panel and the
// rail's search, and sets them up on each page: its first load and every ov:boost:load.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseHTML } = require('linkedom');
const { check, done } = require('./helpers/boot');

const SRC = fs.readFileSync(path.join(__dirname, '../public/js/chat.js'), 'utf8');
const PAGE = (title) => `<div class="ch has-side" data-chat><aside class="ovk-sidebar" id="ch-rail" data-ovk-sidebar>
<form class="ovk-sidebar-find"><input></form><div class="ovk-sidebar-secs"><section class="ovk-sidebar-sec"><h2 class="ovk-sidebar-h">Today</h2>
<a class="ovk-sidebar-item" href="/tasks/1"><span class="ovk-sidebar-t">Fit the home page</span></a><a class="ovk-sidebar-item" href="/tasks/2"><span class="ovk-sidebar-t">Fix the fleet card</span></a></section>
<section class="ovk-sidebar-sec"><h2 class="ovk-sidebar-h">Earlier</h2><a class="ovk-sidebar-item" href="/tasks/3"><span class="ovk-sidebar-t">Importer</span></a></section></div></aside>
<div class="ch-scrim" data-ch-scrim hidden></div>
<section class="ch-main"><header class="ch-head"><button type="button" data-ch-side-open>side</button></header><div class="ch-page"><h1>${title}</h1></div></section>
<aside class="ch-side" id="ch-side"><button type="button" data-ch-side-close>close</button></aside></div>`;

(async () => {
    await check('the side panel and the rail&rsquo;s search work on a page that boost swapped in, not only on the first', async () => {
        const { window, document, CustomEvent, Event } = parseHTML(`<!doctype html><html><body><main id="main">${PAGE('Agents')}</main></body></html>`);
        window.EventSource = undefined;
        new Function('window', 'document', 'location', 'setTimeout', SRC)(window, document, { reload() {} }, setTimeout);
        const tap = (sel) => document.querySelector(sel).dispatchEvent(new Event('click', { bubbles: true }));
        tap('[data-ch-side-open]');
        assert.ok(document.querySelector('[data-chat]').classList.contains('side-open'), 'the first page');
        // A boost move: the old <main> goes, the new one comes in, then ov:boost:load.
        document.dispatchEvent(new CustomEvent('ov:boost:before'));
        document.getElementById('main').innerHTML = PAGE('Machines');
        document.dispatchEvent(new CustomEvent('ov:boost:load'));
        const app = document.querySelector('[data-chat]');
        tap('[data-ch-side-open]');
        assert.ok(app.classList.contains('side-open') && document.querySelector('[data-ch-scrim]').hidden === false, 'the swapped-in page, with its scrim');
        const esc = new Event('keydown'); esc.key = 'Escape'; document.dispatchEvent(esc);
        assert.ok(!app.classList.contains('side-open'), 'Escape closes the side of the page on screen');
        document.dispatchEvent(new CustomEvent('ov:boost:load'));
        assert.strictEqual(app.dataset.chReady, '1', 'a second load event does not set it up twice');
        // The rail's search filters the conversations as you type, and a section with none left hides.
        const input = document.querySelector('.ovk-sidebar-find input');
        input.value = 'fleet'; input.dispatchEvent(new Event('input'));
        const shown = [...document.querySelectorAll('.ovk-sidebar-item')].filter((a) => !a.hidden).map((a) => a.textContent.trim());
        assert.deepStrictEqual(shown, ['Fix the fleet card']);
        const secs = [...document.querySelectorAll('.ovk-sidebar-sec')].map((x) => x.hidden);
        assert.deepStrictEqual(secs, [false, true], 'Earlier has nothing left, so it hides');
    });
    done();
})().catch((e) => { console.error(e); process.exit(1); });
