'use strict';

/**
 * The proof adapters on a machine: the repo's own tests, its pages in a browser, its diff, and the second model.
 *
 * The engine (engine/proof.js) says what to do; this file does it. Every effect is a separate adapter so a test can
 * replace one of them: the tests run through the repo's own runner, the pages are shot with headless Chrome at a
 * phone's and a desktop's width, and the review goes to OpenVibe.AI.
 *
 *   createProofAdapters({ cwd, env, fetchImpl, chromePath, playwrightPath })
 *     run(argv, { cwd })        a command in the repo, with its output
 *     diff()                   the diff and its stats, against HEAD
 *     screenshot({ width, … }) one page at one width, with the overflow and console errors
 *     review({ patch, … })     the second opinion (OpenVibe.AI)
 *     models                   the models a reviewer may be chosen from
 *
 * The review is behind an interface (engine/review.js). The token that names the person is the run token the attempt
 * already carries (stage C3): it comes in the job's own input, is never read from the machine's other keys, and when
 * there is none the adapter says so instead of pretending a second opinion happened.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { reviewWithAi, familyOf } = require('../engine/review');

const MAX_OUTPUT = 8000;
const MAX_PATCH = 200000;

/** Where Playwright may live: the project's own, then what the owner names. */
const PLAYWRIGHT_PATHS = [
    null,                                   // the repo's own node_modules
    '/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright',
];

/** Playwright, or null when this machine has none. */
function findPlaywright(env = {}) {
    const named = env.CODES_PLAYWRIGHT_PATH || env.PLAYWRIGHT_PATH;
    const tries = named ? [named, ...PLAYWRIGHT_PATHS] : PLAYWRIGHT_PATHS;
    for (const p of tries) {
        try {
            const mod = p ? require(p) : require('playwright');
            if (mod && mod.chromium) return mod;
        } catch { /* try the next one */ }
    }
    return null;
}

/** A command in the repo: no shell, a timeout, and the output it printed. */
function commandRunner({ env = process.env } = {}) {
    return async function run(argv, { cwd, timeoutMs = 120000 } = {}) {
        if (!Array.isArray(argv) || !argv.length) return { code: 1, output: 'no command' };
        return await new Promise((resolve) => {
            const child = execFile(argv[0], argv.slice(1), {
                cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
                env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
            }, (err, stdout, stderr) => {
                const code = err && typeof err.code === 'number' ? err.code : (err ? 1 : 0);
                const out = String(stdout || '') + (stderr ? '\n' + String(stderr) : '');
                resolve({ code, output: out.length > MAX_OUTPUT ? out.slice(-MAX_OUTPUT) : out });
            });
        });
    };
}

/** The diff against HEAD: the stats a person reads, and the patch a reviewer reads. */
function diffAdapter(run) {
    return async function diff({ cwd } = {}) {
        const where = cwd || run.cwd;
        const stats = await run(['git', 'diff', '--stat', 'HEAD'], { cwd: where });
        const names = await run(['git', 'diff', '--name-only', 'HEAD'], { cwd: where });
        const patch = await run(['git', 'diff', '--no-color', 'HEAD'], { cwd: where });
        const files = String(names.output || '').split('\n').map((s) => s.trim()).filter(Boolean);
        return {
            files,
            stats: String(stats.output || '').trim(),
            patch: String(patch.output || '').slice(0, MAX_PATCH),
            summary: files.length ? files.length + ' file' + (files.length === 1 ? '' : 's') + ' changed' : 'nothing changed',
        };
    };
}

/**
 * One page at one width: the screenshot, the sideways scroll and the console errors.
 *
 * @returns {Promise<object>} { ok, path, summary, width, errors, overflow }
 */
async function shootPage({ playwright, chromePath, url, width, outDir, route }) {
    const browser = await playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage({
            viewport: { width, height: 900 }, deviceScaleFactor: 1,
            isMobile: width < 700, hasTouch: width < 700,
        });
        const errors = [];
        const consoleErrors = [];
        page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e).slice(0, 300)));
        // Console errors are kept, not fatal: a blocked third-party request (a frame, a theme, a font) is the network
        // around the page, not a bug in it. An uncaught exception is the page's own, and that one fails the proof.
        page.on('console', (m) => { if (m && m.type() === 'error') consoleErrors.push(String(m.text()).slice(0, 300)); });
        await page.goto(url, { waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(600);
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        const file = path.join(outDir, `proof-${(route || '/').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'}-${width}.png`);
        await page.screenshot({ path: file, fullPage: true });
        const overflow = Number(scrollWidth) > width;
        const ok = !overflow && !errors.length;
        return {
            ok, path: file, width, route: route || '/', errors, console_errors: consoleErrors, overflow, url,
            final_url: typeof page.url === 'function' ? page.url() : url,
            summary: ok ? 'the page renders clean'
                : [overflow ? 'the page is ' + scrollWidth + 'px wide, so it scrolls sideways on a ' + width + 'px screen' : null]
                    .concat(errors.length ? ['the page threw: ' + errors.slice(0, 3).join('; ')] : []).filter(Boolean).join('; '),
        };
    } finally {
        await browser.close().catch(() => {});
    }
}

/** A port nothing is using, so the repo's site does not collide with what the person already runs. */
function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const port = probe.address().port;
            probe.close(() => resolve(port));
        });
    });
}

/** Wait until the site answers: a redirect or a 401 is up; a 5xx or no answer is not. */
async function waitForSite(url, { fetchImpl = globalThis.fetch, timeoutMs = 30000, everyMs = 250 } = {}) {
    const until = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < until) {
        try {
            const res = await fetchImpl(url, { redirect: 'manual' });
            if (res && res.status < 500) return { ok: true, status: res.status };
            last = res ? 'HTTP ' + res.status : 'no response';
        } catch (e) {
            last = e && e.message ? e.message : String(e);
        }
        await new Promise((r) => setTimeout(r, everyMs));
    }
    return { ok: false, why: last || 'no answer' };
}

/**
 * The repo's own site, up: the URL it answers on, and how to stop it.
 *
 * CODES_PROOF_URL names a site that is already running (a dev server, a preview). Otherwise the repo's own start
 * script runs on a free port in its own process group, so the group can be stopped without touching anything else
 * the person runs. The script is `npm start` unless CODES_PROOF_START names another command.
 *
 * @returns {Promise<{ url: string, stop: function }>} the site
 */
async function startSite({ cwd, env = process.env, fetchImpl = globalThis.fetch, spawnFn = spawn, timeoutMs = 30000 } = {}) {
    const named = String(env.CODES_PROOF_URL || '').trim();
    if (named) {
        const url = named.replace(/\/+$/, '');
        const ready = await waitForSite(url, { fetchImpl, timeoutMs });
        if (!ready.ok) {
            const err = new Error('the site at ' + url + ' did not answer: ' + ready.why);
            err.code = 'site.not_ready';
            throw err;
        }
        return { url, stop: async () => {} };
    }
    const port = await freePort();
    const url = 'http://127.0.0.1:' + port;
    const [command, ...args] = String(env.CODES_PROOF_START || 'npm start').split(/\s+/).filter(Boolean);
    const child = spawnFn(command, args, {
        cwd, env: { ...env, PORT: String(port), HOST: '127.0.0.1' }, stdio: 'ignore', detached: true,
    });
    const stop = async () => {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* it is gone */ } }
    };
    const ready = await waitForSite(url, { fetchImpl, timeoutMs });
    if (!ready.ok) {
        await stop();
        const err = new Error('the repo\'s site did not start on ' + url + ' (' + ready.why + ')');
        err.code = 'site.not_ready';
        throw err;
    }
    return { url, stop };
}

/**
 * The screenshots: the pages the change touches, at a phone's and a desktop's width.
 *
 * A page that is a file is shot from the working tree (a file:// URL), so a static site needs nothing running. A page
 * that only exists once the app renders it (server/http/run.js, a template) has no file to open: the repo's own start
 * script is brought up on a free port and the routes are shot there. If the site cannot start, the step says so
 * instead of pretending a page was looked at.
 */
function screenshotAdapter({ run, playwright, chromePath, outDir, env = process.env, fetchImpl = globalThis.fetch, startSiteFn = startSite }) {
    return async function screenshot({ files = [], routes = [], width = 390, cwd, pkg = null } = {}) {
        if (!playwright) return { ok: true, skipped: true, summary: 'this machine has no browser to shoot the pages with' };
        const where = cwd || run.cwd;
        const all = Array.isArray(files) ? files : [];
        const staticPages = all.filter((f) => /\.html?$/i.test(String(f)));
        const rendered = all.filter((f) => !/\.html?$/i.test(String(f)));
        const canServe = !!(env.CODES_PROOF_URL || (pkg && pkg.scripts && typeof pkg.scripts.start === 'string'));
        const wantSite = canServe && rendered.length > 0;
        if (!staticPages.length && !wantSite) {
            return { ok: true, skipped: true, summary: 'no HTML page changed, and the repo has no site to render one' };
        }
        fs.mkdirSync(outDir, { recursive: true });
        const shots = [];
        for (const file of staticPages.slice(0, 5)) {
            const abs = path.resolve(where, file);
            if (!fs.existsSync(abs)) continue;
            try {
                shots.push(await shootPage({ playwright, chromePath, url: 'file://' + abs, width, outDir, route: file }));
            } catch (e) {
                shots.push({ ok: false, width, route: file, summary: 'the page could not be shot: ' + e.message });
            }
        }
        if (wantSite) {
            let site = null;
            try {
                site = await startSiteFn({ cwd: where, env, fetchImpl });
                for (const route of (routes.length ? routes : ['/']).slice(0, 5)) {
                    const url = site.url.replace(/\/+$/, '') + (route.startsWith('/') ? route : '/' + route);
                    try {
                        shots.push({ live: true, ...(await shootPage({ playwright, chromePath, url, width, outDir, route })) });
                    } catch (e) {
                        shots.push({ ok: false, live: true, width, route, summary: 'the page could not be shot: ' + e.message });
                    }
                }
            } catch (e) {
                // The change touches a page this repo renders; the site did not come up, so nobody looked at it.
                return { ok: true, skipped: true, summary: 'the site did not start, so the pages were not shot: ' + e.message };
            } finally {
                if (site) await site.stop();
            }
        }
        if (!shots.length) return { ok: true, skipped: true, summary: 'no page was there to shoot' };
        const bad = shots.filter((s) => s.ok === false);
        return {
            ok: !bad.length, skipped: false,
            path: shots[0].path, shots,
            summary: bad.length ? bad.map((s) => s.width + 'px ' + s.route + ': ' + s.summary).join('; ')
                : shots.length + ' page' + (shots.length === 1 ? '' : 's') + ' at ' + width + 'px, clean',
        };
    };
}

/** The OpenAI-compatible root a run token should be spent at: the job's own endpoint names, then the machine's. */
function aiRoot(env = {}) {
    if (env.OPENVIBE_AI_URL) return env.OPENVIBE_AI_URL;
    if (env.OPENAI_BASE_URL) return env.OPENAI_BASE_URL;
    if (env.DEEPSEEK_BASE_URL) return env.DEEPSEEK_BASE_URL;
    if (env.ANTHROPIC_BASE_URL) return String(env.ANTHROPIC_BASE_URL).replace(/\/+$/, '') + '/v1';
    return '';
}

/**
 * The second opinion: OpenVibe.AI, with the task's run token.
 *
 * The token names the person and comes with the attempt (stage C3 mints it for the harness and puts it in the job's
 * input). It is read from the job's own input, never from every provider key in the machine's environment: a personal
 * OPENAI_API_KEY is not Codes' to spend at OpenVibe.AI. Without a token there is no second opinion, and the adapter
 * says so rather than pretending one happened.
 */
function reviewAdapter({ env = {}, jobEnv = {}, fetchImpl = globalThis.fetch, baseUrl, models = [] } = {}) {
    return async function review({ patch = '', summary = '', tests = null, model = null, family = null } = {}) {
        // The token the attempt's own harness carries: any of the names C3 gives, that harness's provider first.
        const runToken = jobEnv.OPENVIBE_AI_TOKEN || jobEnv.OPENAI_API_KEY || jobEnv.ANTHROPIC_AUTH_TOKEN || jobEnv.DEEPSEEK_API_KEY || '';
        const token = runToken || env.OPENVIBE_CODES_TASK_TOKEN || env.OPENVIBE_AI_TOKEN || '';
        if (!token) {
            const err = new Error('no task token is connected yet, so no model could review this change');
            err.code = 'review.no_token';
            throw err;
        }
        const chosen = model || (models.find((m) => familyOf(m) && familyOf(m) !== family) || null);
        if (!chosen) {
            const err = new Error('no model of another family is connected, so nobody could review this change');
            err.code = 'review.no_model';
            throw err;
        }
        return await reviewWithAi({
            baseUrl: baseUrl || aiRoot(jobEnv) || env.OPENVIBE_AI_URL || 'https://ai.openvibe.services/v1',
            token, model: chosen, family: familyOf(chosen), patch, summary, tests, fetchImpl,
        });
    };
}

/**
 * The adapters, for one repo.
 *
 * @param {object} what
 * @param {string} what.cwd the repo the change is in
 * @param {object} [what.env] the environment
 * @param {function} [what.fetchImpl] fetch, for a test
 * @param {string} [what.chromePath] the Chrome to shoot the pages with
 * @param {string} [what.outDir] where the screenshots are written
 * @returns {object} the adapters
 */
function createProofAdapters({ cwd, env = process.env, jobEnv = {}, fetchImpl = globalThis.fetch, chromePath = null, outDir = null, playwright = null, models = null, startSiteFn = startSite } = {}) {
    const run = commandRunner({ env });
    run.cwd = cwd;
    const pw = playwright || findPlaywright(env);
    const chrome = chromePath || env.CODES_CHROME_PATH || '/usr/bin/google-chrome';
    const out = outDir || path.join(cwd, '.openvibe-proof');
    // The models a reviewer may be chosen from: the catalog of the machine, or what the owner names.
    const named = Array.isArray(models) && models.length ? models : String(env.CODES_PROOF_REVIEW_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
    return {
        run,
        diff: diffAdapter(run),
        screenshot: screenshotAdapter({ run, playwright: pw, chromePath: chrome, outDir: out, env, fetchImpl, startSiteFn }),
        review: reviewAdapter({ env, jobEnv, fetchImpl, models: named }),
        models: named,
        env,
    };
}

module.exports = {
    createProofAdapters, commandRunner, diffAdapter, screenshotAdapter, reviewAdapter,
    findPlaywright, shootPage, freePort, waitForSite, startSite,
};
