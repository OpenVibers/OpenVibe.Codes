'use strict';
/**
 * The chat plays sandbox's browser, the worker's side: which headless Chromium the sandbox gets (bound read-only at
 * /opt/browser), and a small DevTools client over the pipe the supervisor relays (sandbox/supervisor.js). The browser
 * itself runs inside the sandbox, on the egress proxy, with a profile in the sandbox's own tmpfs home.
 *
 *   findBrowser(env) → the executable's path or null: CODES_SANDBOX_BROWSER, the install script's copy, or Playwright's
 *                      chrome-headless-shell in this user's cache
 *   createCdp(send)  → { call(method, params, sessionId), onMessage(text), waitFor(method, sessionId, ms), close() }
 *   openPage(cdp, url, { timeoutMs, screenshot }) → { ok, url, title, text, screenshot } | { ok: false, error }
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const INSTALLED = '/opt/openvibe-codes-sandbox/browser';

function newestHeadlessShell(base) {
    let dirs = [];
    try { dirs = fs.readdirSync(base).filter((d) => /^chromium_headless_shell-\d+$/.test(d)); } catch { return null; }
    dirs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
        const exe = path.join(base, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
        if (fs.existsSync(exe)) return exe;
    }
    return null;
}

function findBrowser(env = process.env) {
    if (env.CODES_SANDBOX_BROWSER) return fs.existsSync(env.CODES_SANDBOX_BROWSER) ? env.CODES_SANDBOX_BROWSER : null;
    const installed = newestHeadlessShell(INSTALLED);
    if (installed) return installed;
    return newestHeadlessShell(env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright'));
}

function createCdp(send) {
    let nextId = 1;
    const pending = new Map();
    const waiters = [];
    let closed = null;
    return {
        call(method, params = {}, sessionId) {
            if (closed) return Promise.reject(new Error(`the browser is gone (${closed})`));
            const id = nextId++;
            send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
            return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
        },
        waitFor(method, sessionId, ms) {
            return new Promise((resolve) => {
                const w = { method, sessionId, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); resolve(null); }, ms) };
                waiters.push(w);
            });
        },
        /** One message from the browser (untrusted: it came out of the sandbox). */
        onMessage(text) {
            let m;
            try { m = JSON.parse(text); } catch { return; }
            if (!m || typeof m !== 'object') return;
            if (typeof m.id === 'number' && pending.has(m.id)) {
                const p = pending.get(m.id);
                pending.delete(m.id);
                if (m.error) p.reject(new Error(`${p.method}: ${String(m.error.message || 'failed').slice(0, 200)}`));
                else p.resolve(m.result || {});
                return;
            }
            if (typeof m.method === 'string') {
                for (const w of [...waiters]) {
                    if (w.method === m.method && (!w.sessionId || w.sessionId === m.sessionId)) {
                        clearTimeout(w.timer);
                        waiters.splice(waiters.indexOf(w), 1);
                        w.resolve(m.params || {});
                    }
                }
            }
        },
        close(why = 'closed') {
            closed = why;
            for (const p of pending.values()) p.reject(new Error(`the browser is gone (${why})`));
            pending.clear();
            for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.resolve(null); }
        },
    };
}

/** Open a page in a new tab, wait for it to load, and read its title, text and a screenshot. */
async function openPage(cdp, url, { timeoutMs = 20_000, screenshot = true } = {}) {
    const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' });
    try {
        const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
        await cdp.call('Page.enable', {}, sessionId);
        const loaded = cdp.waitFor('Page.loadEventFired', sessionId, timeoutMs);
        const nav = await cdp.call('Page.navigate', { url: String(url) }, sessionId);
        if (nav.errorText) return { ok: false, url, error: String(nav.errorText).slice(0, 200) };
        await loaded;
        const evaluate = async (expression) => {
            const r = await cdp.call('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
            return r && r.result ? r.result.value : null;
        };
        const title = String((await evaluate('document.title')) || '').slice(0, 500);
        const text = String((await evaluate('document.body ? document.body.innerText : ""')) || '').slice(0, 20_000);
        const location = String((await evaluate('location.href')) || '').slice(0, 2000);
        let shot = null;
        if (screenshot) shot = (await cdp.call('Page.captureScreenshot', { format: 'png' }, sessionId)).data || null;
        return { ok: true, url: location || url, title, text, screenshot: shot };
    } finally {
        await cdp.call('Target.closeTarget', { targetId }).catch(() => {});
    }
}

module.exports = { findBrowser, createCdp, openPage, INSTALLED };
