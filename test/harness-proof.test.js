'use strict';

/**
 * Stage C8, the machine half: the proof adapters (harness/proof.js) with fakes for every effect.
 *
 * No command runs, no browser opens and no network is touched: the command runner, Playwright, the site and fetch are
 * all fakes, so what is tested is the adapter's own reasoning — the diff's shape, the change going to a site instead
 * of a file, the overflow and the console errors, the reviewer's family, and a token that is never required to try.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    diffAdapter, screenshotAdapter, reviewAdapter, waitForSite, freePort,
} = require('../harness/proof');
const { check, done } = require('./helpers/boot');

/** A fake Playwright: one page per viewport, with a scroll width, console errors and page errors to report. */
function fakeBrowser({ scrollWidth = null, consoleErrors = [], pageErrors = [], finalUrl = null } = {}) {
    const shots = [];
    const launched = [];
    return {
        shots, launched,
        chromium: {
            async launch(options) {
                launched.push(options);
                return {
                    async close() {},
                    async newPage(options) {
                        const width = options.viewport.width;
                        let at = null;
                        const handlers = {};
                        return {
                            on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); },
                            async goto(url) {
                                at = url;
                                for (const text of consoleErrors) {
                                    for (const fn of handlers.console || []) fn({ type: () => 'error', text: () => text });
                                }
                                for (const text of pageErrors) {
                                    for (const fn of handlers.pageerror || []) fn(new Error(text));
                                }
                            },
                            async waitForTimeout() {},
                            async evaluate() { return scrollWidth == null ? width - 1 : scrollWidth; },
                            async screenshot({ path: file }) { shots.push({ path: file, width, url: at }); },
                            url() { return finalUrl || at; },
                        };
                    },
                };
            },
        },
    };
}

/** A fake command runner: git's three questions, answered. */
function fakeRun(answers = {}) {
    const calls = [];
    const run = async (argv) => {
        calls.push(argv.join(' '));
        const key = argv.slice(1).join(' ');
        return { code: 0, output: answers[key] !== undefined ? answers[key] : '' };
    };
    run.calls = calls;
    run.cwd = '/repo';
    return run;
}

const OK = async () => ({ status: 200, ok: true, json: async () => ({ choices: [{ message: { content: '{"verdict":"approved","summary":"It holds together."}' } }] }) });

(async () => {
    try {
        await check('the diff is read: the files, the stats and the patch', async () => {
            const run = fakeRun({
                'diff --stat HEAD': ' a.js | 3 ++-',
                'diff --name-only HEAD': 'a.js\nb.css\n',
                'diff --no-color HEAD': '+x\n-y',
            });
            const diff = await diffAdapter(run)({ cwd: '/repo' });
            assert.deepStrictEqual(diff.files, ['a.js', 'b.css']);
            assert.strictEqual(diff.stats, 'a.js | 3 ++-');
            assert.strictEqual(diff.patch, '+x\n-y');
            assert.strictEqual(diff.summary, '2 files changed');
        });

        await check('a static page is shot from the working tree, at a phone\'s width', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-proof-'));
            fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><p>hi</p>');
            const browser = fakeBrowser();
            const shot = await screenshotAdapter({
                run: fakeRun(), playwright: browser, chromePath: '/bin/true', outDir: path.join(dir, 'shots'),
            })({ cwd: dir, width: 390, files: ['index.html'], routes: ['/'] });
            assert.strictEqual(shot.ok, true);
            assert.strictEqual(shot.shots.length, 1);
            assert.ok(shot.shots[0].url.startsWith('file://'), shot.shots[0].url);
        });

        await check('a page only the app renders is shot from the repo\'s own site, which is stopped afterwards', async () => {
            const browser = fakeBrowser();
            const seen = [];
            let stopped = 0;
            const shot = await screenshotAdapter({
                run: fakeRun(), playwright: browser, chromePath: '/bin/true', outDir: path.join(os.tmpdir(), 'codes-proof-shots'),
                startSiteFn: async ({ cwd }) => {
                    seen.push(cwd);
                    return { url: 'http://127.0.0.1:4321', stop: async () => { stopped++; } };
                },
            })({
                cwd: '/repo', width: 1440, files: ['server/http/run.js'], routes: ['/'],
                pkg: { scripts: { start: 'node server/index.js' } },
            });
            assert.deepStrictEqual(seen, ['/repo']);
            assert.strictEqual(stopped, 1, 'the site is stopped even when it answered');
            assert.strictEqual(shot.ok, true);
            assert.strictEqual(shot.shots[0].url, 'http://127.0.0.1:4321/');
            assert.strictEqual(shot.shots[0].live, true);
        });

        await check('a site that does not start is said out loud, not turned into a clean screenshot', async () => {
            const browser = fakeBrowser();
            const shot = await screenshotAdapter({
                run: fakeRun(), playwright: browser, chromePath: '/bin/true', outDir: path.join(os.tmpdir(), 'codes-proof-shots'),
                startSiteFn: async () => { const e = new Error('the repo\'s site did not start'); e.code = 'site.not_ready'; throw e; },
            })({ cwd: '/repo', width: 390, files: ['server/http/run.js'], routes: ['/'], pkg: { scripts: { start: 'node server/index.js' } } });
            assert.strictEqual(shot.skipped, true);
            assert.ok(/did not start/.test(shot.summary), shot.summary);
        });

        await check('a page that scrolls sideways fails the screenshots', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-proof-'));
            fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><p>wide</p>');
            const shot = await screenshotAdapter({
                run: fakeRun(), playwright: fakeBrowser({ scrollWidth: 480 }), chromePath: '/bin/true', outDir: path.join(dir, 'shots'),
            })({ cwd: dir, width: 390, files: ['index.html'], routes: ['/'] });
            assert.strictEqual(shot.ok, false);
            assert.ok(/scrolls sideways/.test(shot.summary), shot.summary);
        });

        await check('a page that throws fails the screenshots', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-proof-'));
            fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><p>hi</p>');
            const shot = await screenshotAdapter({
                run: fakeRun(), playwright: fakeBrowser({ pageErrors: ['TypeError: x is undefined'] }), chromePath: '/bin/true', outDir: path.join(dir, 'shots'),
            })({ cwd: dir, width: 1440, files: ['index.html'], routes: ['/'] });
            assert.strictEqual(shot.ok, false);
            assert.ok(/the page threw/.test(shot.summary), shot.summary);
        });

        await check('a blocked third-party request is kept as detail, and does not fail the page', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-proof-'));
            fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><p>hi</p>');
            const shot = await screenshotAdapter({
                run: fakeRun(), playwright: fakeBrowser({ consoleErrors: ['Failed to load resource: net::ERR_FAILED'] }), chromePath: '/bin/true', outDir: path.join(dir, 'shots'),
            })({ cwd: dir, width: 390, files: ['index.html'], routes: ['/'] });
            assert.strictEqual(shot.ok, true);
            assert.deepStrictEqual(shot.shots[0].console_errors, ['Failed to load resource: net::ERR_FAILED']);
        });

        await check('a machine with no browser says it cannot shoot, instead of failing', async () => {
            const shot = await screenshotAdapter({ run: fakeRun(), playwright: null, chromePath: null, outDir: '/tmp/x' })({ files: ['index.html'] });
            assert.strictEqual(shot.skipped, true);
            assert.ok(/no browser/.test(shot.summary), shot.summary);
        });

        await check('the review needs the task\'s token, and says so when it has none', async () => {
            const review = reviewAdapter({ env: {}, fetchImpl: OK, models: ['deepseek-chat'] });
            await assert.rejects(() => review({ patch: '+x', family: 'anthropic' }), (e) => e.code === 'review.no_token');
        });

        await check('the review goes to OpenVibe.AI as chat completions, with the token', async () => {
            const calls = [];
            const fetchImpl = async (url, options) => { calls.push({ url, options }); return OK(); };
            const review = reviewAdapter({ env: { OPENVIBE_CODES_TASK_TOKEN: 'test-token' }, fetchImpl, models: ['deepseek-chat'] });
            const verdict = await review({ patch: '+x', summary: 'a change', family: 'anthropic', model: 'deepseek-chat' });
            assert.strictEqual(verdict.verdict, 'approved');
            assert.strictEqual(verdict.family, 'deepseek');
            assert.ok(calls[0].url.endsWith('/chat/completions'), calls[0].url);
            assert.strictEqual(calls[0].options.headers.authorization, 'Bearer test-token');
        });

        await check('the review spends the run token the attempt carries, at the endpoint that token names', async () => {
            const calls = [];
            const fetchImpl = async (url, options) => { calls.push({ url, options }); return OK(); };
            const review = reviewAdapter({
                env: { OPENAI_API_KEY: 'a-personal-key' },
                jobEnv: { ANTHROPIC_BASE_URL: 'https://ai.openvibe.services', ANTHROPIC_AUTH_TOKEN: 'run-token' },
                fetchImpl,
            });
            const verdict = await review({ patch: '+x', family: 'anthropic', model: 'deepseek-chat' });
            assert.strictEqual(verdict.verdict, 'approved');
            assert.strictEqual(calls[0].url, 'https://ai.openvibe.services/v1/chat/completions');
            assert.strictEqual(calls[0].options.headers.authorization, 'Bearer run-token');
        });

        await check('a personal provider key in the environment is not spent as a run token', async () => {
            const review = reviewAdapter({ env: { OPENAI_API_KEY: 'a-personal-key' }, fetchImpl: OK, models: ['deepseek-chat'] });
            await assert.rejects(() => review({ patch: '+x', family: 'anthropic' }), (e) => e.code === 'review.no_token');
        });

        await check('a provider that speaks the messages dialect is tried when chat completions is not there', async () => {
            const calls = [];
            const fetchImpl = async (url) => {
                calls.push(url);
                if (url.endsWith('/chat/completions')) return { status: 404, ok: false, json: async () => ({}) };
                return { status: 200, ok: true, json: async () => ({ content: [{ type: 'text', text: 'changes requested: the parser still throws' }] }) };
            };
            const review = reviewAdapter({ env: { OPENVIBE_AI_TOKEN: 'test-token' }, fetchImpl });
            const verdict = await review({ patch: '+x', family: 'anthropic', model: 'claude-sonnet-4' });
            assert.ok(calls[1].endsWith('/messages'), calls[1]);
            assert.strictEqual(verdict.verdict, 'changes_requested');
        });

        await check('the site readiness probe waits through a failure and accepts a redirect', async () => {
            let tries = 0;
            const fetchImpl = async () => {
                tries++;
                if (tries < 3) throw new Error('ECONNREFUSED');
                return { status: 302 };
            };
            const ready = await waitForSite('http://127.0.0.1:1', { fetchImpl, timeoutMs: 5000, everyMs: 5 });
            assert.strictEqual(ready.ok, true);
            assert.strictEqual(tries, 3);
        });

        await check('a free port is a port a site can answer on', async () => {
            const port = await freePort();
            assert.ok(Number.isInteger(port) && port > 0 && port < 65536, String(port));
        });

        console.log('harness proof: the diff, the pages (file or site), the overflow and the second opinion, with fakes');
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
    done();
})();
