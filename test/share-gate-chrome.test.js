'use strict';
/**
 * The "not on the list" gate in a real headless Chrome (openvibe-shared 4.123.0's [data-ov-share-gate]): the task
 * page carries markup only, ov-share.js draws the gate when it loads, signed out it offers Sign in, and a signed-in
 * person who is not on the list is offered Ask for access — with no console error and no CSP refusal.
 *
 * Skipped (exit 0) without Chrome, or with OV_SKIP_BROWSER=1. The page is served by this repo's own app on a
 * temporary database, so the CSP headers the browser sees are Codes'.
 */
const assert = require('assert');
const fs = require('fs');
const { boot, check, done } = require('./helpers/boot');

let playwright;
try { playwright = require('playwright'); } catch { playwright = require(process.env.PLAYWRIGHT_MODULE || '/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright'); }
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
if (process.env.OV_SKIP_BROWSER === '1' || !fs.existsSync(CHROME)) {
    console.log('share-gate-chrome: skipped (no Chrome; set CHROME_BIN)');
    process.exit(0);
}

const REFUSED = /Content Security Policy|Refused to (?:load|execute|apply)|Uncaught SyntaxError/i;

(async () => {
    const run = {
        enabled: true,
        async submit() { return { id: 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J1', state: 'queued' }; },
        async read(jobId) { return { id: jobId, state: 'queued', result: null, error: null }; },
        async cancel(jobId) { return { id: jobId, state: 'cancelled' }; },
        async streamUrl() { return 'http://127.0.0.1:1/stream'; },
    };
    const t = await boot({ run });
    const ada = t.network.addUser('ada');
    const cy = t.network.addUser('cy');
    const post = (p, as, form) => t.get(p, { as, form, method: 'POST' });
    const cookieOf = (user) => {
        const [name, ...rest] = t.signIn(user).split('=');
        return { name, value: rest.join('='), url: t.base };
    };

    let browser;
    const errors = [];
    const watch = (page) => {
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('pageerror', (e) => errors.push(String(e)));
    };
    const settled = async (page) => {
        await page.waitForSelector('#share-gate .ov-share-gate', { timeout: 8000 });
        return await page.$eval('#share-gate', (el) => el.textContent.replace(/\s+/g, ' ').trim());
    };

    try {
        let taskId;
        await check('a task shared with Specific people, with nobody on the list yet', async () => {
            const made = await post('/run/project', ada, { name: 'My code', prompt: 'Fix the typo', repo: 'https://github.com/OpenVibers/OpenVibe.Codes' });
            assert.strictEqual(made.status, 303, made.text);
            const page = await t.get(made.headers.get('location'), { as: ada });
            const project = /<option value="(prj_[0-9A-Z]{26})"/.exec(page.text)[1];
            const started = await post('/run', ada, { repo: 'https://github.com/OpenVibers/OpenVibe.Codes', prompt: 'Fix the typo in README', project });
            assert.strictEqual(started.status, 303, started.text);
            taskId = /\/run\/tasks\/(tsk_[0-9A-Z]{26})$/.exec(started.headers.get('location'))[1];
            await t.ctx.sharing.shares.setAudience(
                { subject: { type: 'user', id: ada.subject } },
                { service: 'codes', kind: 'task', id: taskId }, 'people',
            );
        });

        await check('headless Chrome: the gate draws itself, signed out, with Sign in', async () => {
            browser = await playwright.chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            watch(page);
            const res = await page.goto(`${t.base}/run/tasks/${taskId}`, { waitUntil: 'load', timeout: 15000 });
            assert.strictEqual(res.status(), 404, 'the gate answers 404, never the task');
            const text = await settled(page);
            assert.ok(/Sign in/.test(text), `signed out the gate offers Sign in, got: ${text}`);
            const href = await page.$eval('#share-gate .ov-share-gate a', (a) => a.getAttribute('href'));
            assert.match(href, /^\/auth\/login\?next=/);
            await ctx.close();
        });

        await check('headless Chrome: signed in as somebody not on the list, Ask for access', async () => {
            const ctx = await browser.newContext();
            await ctx.addCookies([cookieOf(cy)]);
            const page = await ctx.newPage();
            watch(page);
            await page.goto(`${t.base}/run/tasks/${taskId}`, { waitUntil: 'load', timeout: 15000 });
            const text = await settled(page);
            assert.ok(/Ask for access/.test(text), `a stranger is offered Ask for access, got: ${text}`);
            assert.ok(/@cy/.test(text), 'the gate names the account it is signed in as');
            await ctx.close();
        });

        await check('headless Chrome: no console error and no CSP refusal on the gate page', async () => {
            const refused = errors.filter((e) => REFUSED.test(e));
            assert.deepStrictEqual(refused, [], `the gate page was refused: ${refused.join(' | ')}`);
        });
    } finally {
        if (browser) await browser.close().catch(() => {});
        await t.close();
        done();
    }
})();
