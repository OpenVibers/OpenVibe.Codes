'use strict';
// The chat app after a page move (the owner, 2026-10-31, a phone: "I can't open… the menu" on Machines). Codes moves
// between pages with openvibe-shared/boost, which swaps <main> without running the page's scripts again. The rail is
// the network's sidebar (kit-web.js opens it on the document); the panel ("What it did") and the rail's search are the
// conversation kit's (ov-thread.js, plan L55 C4); chat.js keeps Codes' own parts. Each sets itself up on a page's first
// load and on every ov:boost:load.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseHTML } = require('linkedom');
const thread = require('openvibe-shared/thread');
const kit = require('openvibe-shared/kit');
const { check, done } = require('./helpers/boot');

const CHAT = fs.readFileSync(path.join(__dirname, '../public/js/chat.js'), 'utf8');
const KIT = fs.readFileSync(path.join(path.dirname(require.resolve('openvibe-shared/package.json')), 'ov-thread.js'), 'utf8');
const rail = kit.sidebar({ id: 'ch-rail', label: 'Codes', find: { action: '/tasks', name: 'q', placeholder: 'Search conversations' }, sections: [
    { title: 'Today', items: [{ href: '/tasks/1', label: 'Fit the home page' }, { href: '/tasks/2', label: 'Fix the fleet card' }] },
    { title: 'Earlier', items: [{ href: '/tasks/3', label: 'Importer' }] },
] });
const PAGE = (title) => `<div class="ch" data-chat>${thread.page({
    sidebar: rail,
    head: thread.head({ title, sidebar: 'ch-rail', panel: 'ch-side', panelLabel: 'What it did' }),
    turns: [thread.turn({ id: 'a1', you: { text: 'Fit the home page' }, reply: '<p>Done</p>' })],
    panel: thread.panel({ id: 'ch-side', title: 'What it did' }),
    composer: thread.composer({ action: '/tasks/1/continue' }),
})}</div>`;

(async () => {
    await check('the panel, the rail&rsquo;s search and the composer work on a page that boost swapped in, not only on the first', async () => {
        const { window, document, CustomEvent, Event } = parseHTML(`<!doctype html><html><body><main id="main">${PAGE('Agents')}</main></body></html>`);
        window.EventSource = undefined;
        window.matchMedia = () => ({ matches: false });
        const run = (src) => new Function('window', 'document', 'location', 'setTimeout', 'matchMedia', 'navigator', src)(window, document, { reload() {}, hash: '' }, setTimeout, window.matchMedia, {});
        run(KIT);
        run(CHAT);
        const tap = (sel) => document.querySelector(sel).dispatchEvent(new Event('click', { bubbles: true }));
        tap('[data-ovt-panel-open]');
        assert.ok(document.querySelector('[data-ovt]').classList.contains('is-panel'), 'the first page');
        // A boost move: the old <main> goes, the new one comes in, then ov:boost:load.
        document.dispatchEvent(new CustomEvent('ov:boost:before'));
        document.getElementById('main').innerHTML = PAGE('Machines');
        document.dispatchEvent(new CustomEvent('ov:boost:load'));
        const box = document.querySelector('[data-ovt]');
        tap('[data-ovt-panel-open]');
        assert.ok(box.classList.contains('is-panel') && document.querySelector('[data-ovt-panel-scrim]').hidden === false, 'the swapped-in page, with its scrim');
        const esc = new Event('keydown'); esc.key = 'Escape'; document.dispatchEvent(esc);
        assert.ok(!box.classList.contains('is-panel'), 'Escape closes the panel of the page on screen');
        document.dispatchEvent(new CustomEvent('ov:boost:load'));
        assert.strictEqual(document.querySelector('[data-chat]').dataset.chReady, '1', 'a second load event does not set it up twice');
        // The rail's search filters the conversations as you type, and a section with none left hides.
        const input = document.querySelector('.ovk-sidebar-find input');
        input.value = 'fleet'; input.dispatchEvent(new Event('input'));
        const shown = [...document.querySelectorAll('.ovk-sidebar-item')].filter((a) => !a.hidden).map((a) => a.textContent.trim());
        assert.deepStrictEqual(shown, ['Fix the fleet card']);
        const secs = [...document.querySelectorAll('.ovk-sidebar-sec')].map((x) => x.hidden);
        assert.deepStrictEqual(secs, [false, true], 'Earlier has nothing left, so it hides');
        // Codes' own: the keyboard hint in the composer's status line.
        assert.strictEqual(document.querySelector('[data-ovt-note]').textContent, 'Enter sends · Shift+Enter for a new line', 'the hint where Enter sends');
    });
    done();
})().catch((e) => { console.error(e); process.exit(1); });
