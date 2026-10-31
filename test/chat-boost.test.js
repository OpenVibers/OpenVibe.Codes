'use strict';
// public/js/chat.js after a page move (the owner, 2026-10-31, a phone: "I can't open… the menu" on Machines). Codes
// moves between pages with openvibe-shared/boost, which swaps <main> without running the page's scripts again: a move
// from Agents to Machines (the same scripts) left the new page's rail button with no handler. The script now sets up
// each page on ov:boost:load, and closes a live stream when the page moves away.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseHTML } = require('linkedom');
const { check, done } = require('./helpers/boot');

const SRC = fs.readFileSync(path.join(__dirname, '../public/js/chat.js'), 'utf8');
const PAGE = (title) => `<div class="ch is-page" data-chat><aside class="ch-rail" id="ch-rail"><a href="/agents">Agents</a></aside><div class="ch-scrim" data-ch-scrim hidden></div>
<section class="ch-main"><header class="ch-head"><button type="button" data-ch-rail-open>open</button></header><div class="ch-page"><h1>${title}</h1></div></section></div>`;

(async () => {
    await check('the rail opens on a page that boost swapped in, not only on the first', async () => {
        const { window, document, CustomEvent, Event } = parseHTML(`<!doctype html><html><body><main id="main">${PAGE('Agents')}</main></body></html>`);
        window.EventSource = undefined;
        new Function('window', 'document', 'location', 'setTimeout', SRC)(window, document, { reload() {} }, setTimeout);
        const tap = () => document.querySelector('[data-ch-rail-open]').dispatchEvent(new Event('click', { bubbles: true }));
        tap();
        assert.ok(document.querySelector('[data-chat]').classList.contains('rail-open'), 'the first page');
        // A boost move: the old <main> goes, the new one comes in, then ov:boost:load.
        document.dispatchEvent(new CustomEvent('ov:boost:before'));
        document.getElementById('main').innerHTML = PAGE('Machines');
        document.dispatchEvent(new CustomEvent('ov:boost:load'));
        tap();
        const app = document.querySelector('[data-chat]');
        assert.ok(app.classList.contains('rail-open'), 'the swapped-in page');
        assert.strictEqual(document.querySelector('[data-ch-scrim]').hidden, false, 'with its scrim');
        document.dispatchEvent(new CustomEvent('ov:boost:load'));
        assert.strictEqual(app.dataset.chReady, '1', 'a second load event does not set it up twice');
        const esc = new Event('keydown'); esc.key = 'Escape'; document.dispatchEvent(esc);
        assert.ok(!app.classList.contains('rail-open'), 'Escape closes the rail of the page on screen');
    });
    done();
})().catch((e) => { console.error(e); process.exit(1); });
