'use strict';

/**
 * Proof, not promises: what a finished attempt has to show.
 *
 * When an attempt says it is done, this asks for the evidence: the tests the change reaches, the pages it touched
 * (phone and desktop), the diff, and a second model's opinion. Everything it touches is an injected adapter, so the
 * order is the same in a test with fakes as on a machine, and a step that cannot run says so instead of being
 * quietly left out.
 *
 *   collectProof({ cwd, files, adapters, author, emit })  the proof: its items, and the outcome in plain words
 *   testPlan({ pkg, files, env })                          the repo's own test command, and why it is that one
 *   pageFiles(files)                                      the changed files that are pages
 *   routesOf(pages)                                       the routes those pages are served at
 *   outcomeOf(items)                                      'Done with proof' / "Didn't finish, with what is left"
 *
 * The four steps, in order:
 *
 *   tests        the repo's own runner, narrowed to the tests the change reaches. The whole suite runs only when
 *                the owner's guard allows it (CODES_PROOF_FULL_SUITE=1): a machine may not spend an hour of its
 *                owner's battery on every task. A filter that matches no test is a skip, not a failure.
 *   screenshots  phone (390) and desktop (1440) of the pages the diff touches, because a page that overflows is a
 *                bug the diff alone never shows.
 *   diff         the stats: what changed, how many lines, which files.
 *   review       a model of another family, through OpenVibe.AI. A review by the author's own family is refused:
 *                that would be a second reading of the same mind, not a second opinion.
 *
 * The outcome is the three plain words a person reads: Done with proof, Didn't finish (with what is left), or
 * Stopped by you.
 */

const { pickReviewer, authorFamily: familyOfAuthor } = require('./review');

/** The changed files that are pages: the site's own files, and anything served as HTML or CSS. */
const PAGE_FILE = /^(?:public\/|server\/render\/|server\/http\/)|\.(?:html?|css)$/i;

/** The files that make every test matter: the shared ones. A change here runs the whole suite (when allowed). */
const SHARED_FILE = /^(?:package\.json|package-lock\.json|engine\/index\.js|server\/app\.js|server\/db\.js|server\/config\.js)$/;

/** The runners' own words for "the filter matched no test": not a failure, nothing ran. */
const NO_TEST_MATCH = /no test files? (?:matched|found)|no tests? (?:found|ran|to run)|running 0 tests/i;

/** The kinds of proof item, in the order they are collected. */
const KINDS = ['tests', 'screenshots', 'diff', 'review'];

/** The plain words for a finished task. */
const OUTCOME = {
    done: 'Done with proof',
    unfinished: "Didn't finish",
    stopped: 'Stopped by you',
};

/**
 * The changed files that are pages.
 *
 * @param {string[]} files the changed files
 * @returns {string[]} the pages among them
 */
function pageFiles(files) {
    return (Array.isArray(files) ? files : []).filter((f) => typeof f === 'string' && PAGE_FILE.test(f));
}

/**
 * The words the repo's own test runner filters by, for the changed files: a test file is named after what it
 * tests ('test/engine-proof.test.js' for 'engine/proof.js'), so the name without its extension finds it.
 *
 * @param {string[]} files the changed files
 * @returns {string[]} the filter words, unique, without the words every file shares
 */
function testWords(files) {
    const skip = new Set(['index', 'main', 'app', 'server', 'public', 'src', 'lib', 'test', 'tests', 'util', 'utils', 'helper', 'helpers', 'config']);
    const words = new Set();
    for (const f of Array.isArray(files) ? files : []) {
        if (typeof f !== 'string') continue;
        const name = String(f).split('/').pop().replace(/\.[^.]+$/, '');
        for (const part of name.split(/[-_.\s]+/)) {
            const w = part.toLowerCase();
            if (w.length >= 3 && !skip.has(w)) words.add(w);
        }
    }
    return [...words].slice(0, 8);
}

/**
 * The file a `node <file>` test script runs, or null.
 *
 * 'npm test' would run it with one more process in the way, and a machine's npm may be a guard that cannot tell a
 * narrowed run from a whole one. Running the script itself is the same runner, with the words the plan chose.
 */
function nodeTestScript(script) {
    const m = /^node\s+([^\s-][^\s]*)$/.exec(String(script || '').trim());
    return m ? m[1] : null;
}

/**
 * The repo's own test command, and how narrow it is.
 *
 * The runner is the repo's: 'npm test' when package.json has it (or the file it runs, when that is `node <file>`),
 * then pytest, go and cargo. The suite is narrowed to the tests the change reaches; the whole suite runs only when
 * the owner's guard allows it (CODES_PROOF_FULL_SUITE=1) — a change that touches what every test shares, or one no
 * test name reaches.
 *
 * @param {object} what
 * @param {object} what.pkg the repo's package.json (or null)
 * @param {string[]} what.files the changed files
 * @param {object} what.env the environment
 * @returns {{ command: string, args: string[], mode: string, reason: string }} the plan
 */
function testPlan({ pkg = null, files = [], env = {} } = {}) {
    const scripts = pkg && pkg.scripts ? pkg.scripts : {};
    const test = typeof scripts.test === 'string' ? scripts.test : null;
    const changed = Array.isArray(files) ? files : [];
    const shared = changed.some((f) => SHARED_FILE.test(String(f || '')));
    // The guard: the whole suite runs only when the owner allows it. CODES_PROOF_FULL_SUITE is the proof step's own
    // name for it; OV_ALLOW_SUITE is the fleet's (the harness refuses a whole suite without it too).
    const allowFull = /^(1|true|yes)$/i.test(String(env.CODES_PROOF_FULL_SUITE || env.OV_ALLOW_SUITE || ''));
    const words = testWords(changed);

    if (test) {
        const direct = nodeTestScript(test);
        const base = direct ? { command: 'node', args: [direct] } : { command: 'npm', args: ['test'] };
        const narrowed = direct ? [direct, ...words] : ['test', '--', ...words];
        if (shared && allowFull) return { ...base, mode: 'full', reason: 'the change touches what every test shares, and the full suite is allowed' };
        if (!words.length) {
            // Nothing in the diff names a test, so there is nothing to narrow to. The whole suite is not run without
            // the owner's guard: a machine may not spend an hour of its owner's battery on every task.
            if (allowFull) return { ...base, mode: 'full', reason: 'no test name matches the changed files, and the full suite is allowed' };
            return { command: '', args: [], mode: 'none', reason: 'no test name matches the changed files, and the full suite is not allowed (CODES_PROOF_FULL_SUITE=1)' };
        }
        if (!shared) return { command: base.command, args: narrowed, mode: 'targeted', reason: 'only the tests the change reaches (' + words.join(', ') + ')' };
        return { command: base.command, args: narrowed, mode: 'targeted', reason: 'the change touches what every test shares, but the full suite is not allowed (CODES_PROOF_FULL_SUITE=1)' };
    }
    if (pkg && (pkg.go || (pkg.dependencies && pkg.dependencies.go))) return { command: 'go', args: ['test', './...'], mode: 'full', reason: "the repo's own Go suite" };
    if (pkg && (pkg.pytest || (pkg.dependencies && pkg.dependencies.pytest))) return { command: 'pytest', args: [], mode: 'full', reason: "the repo's own Python suite" };
    if (pkg && pkg.rust) return { command: 'cargo', args: ['test'], mode: 'full', reason: "the repo's own Rust suite" };
    return { command: '', args: [], mode: 'none', reason: 'the repo has no test command of its own' };
}

/**
 * The outcome in plain words: done with proof, or what is left.
 *
 * @param {object[]} items the proof items
 * @returns {{ state: string, note: string }} the outcome
 */
function proofNote(items) {
    const list = Array.isArray(items) ? items : [];
    const failed = list.filter((i) => i && i.ok === false);
    const passed = list.filter((i) => i && i.ok === true && i.skipped !== true);
    const skipped = list.filter((i) => i && i.skipped === true);
    if (failed.length) {
        const left = failed.map((i) => (i.label || 'a step') + ': ' + (i.summary || 'it failed')).join('; ');
        return "Didn't finish, with what is left: " + left + '.';
    }
    const skippedText = skipped.length
        ? ' (' + skipped.map((i) => (i.label || 'a step') + ' was skipped: ' + (i.summary || 'not available here')).join('; ') + ')'
        : '';
    if (!passed.length) return 'Done.' + skippedText;
    return 'Done with proof: ' + passed.map((i) => i.label).join(', ') + '.' + skippedText;
}

function outcomeOf(items) {
    const list = Array.isArray(items) ? items : [];
    const failed = list.filter((i) => i && i.ok === false);
    return { state: failed.length ? 'unfinished' : 'done', note: proofNote(list) };
}

/**
 * The routes the changed pages are served at: a public/index.html is the home, a public/a/b.html is /a/b.
 *
 * @param {string[]} pages the changed page files
 * @returns {string[]} the routes
 */
function routesOf(pages) {
    const out = [];
    for (const p of Array.isArray(pages) ? pages : []) {
        if (!String(p).startsWith('public/')) continue;
        let route = String(p).slice('public/'.length).replace(/\.(html?|css)$/i, '');
        route = route.replace(/^(.*\/)?index$/i, '');      // public/index.html is the home, public/a/index.html is /a
        if (route) out.push('/' + route);
        else if (/^public\/index\.html?$/i.test(String(p))) out.push('/');
    }
    return [...new Set(out.length ? out : ['/'])];
}

/**
 * Collect the proof of one finished attempt.
 *
 * @param {object} what
 * @param {string} what.cwd the repo the change is in
 * @param {string[]} [what.files] the changed files
 * @param {object} what.adapters { run, diff, screenshot, review, models, env }
 * @param {object} [what.author] { agent, model } the author of the change
 * @param {function} [what.emit] called with every item as it is collected
 * @returns {Promise<{ items: object[], outcome: object, review: object|null }>} the proof
 */
async function collectProof({ cwd, files = [], adapters = {}, author = null, emit = null } = {}) {
    if (!cwd) throw new TypeError('proof needs the repo it is about');
    const run = adapters.run;
    if (typeof run !== 'function') throw new TypeError('proof needs a run adapter');
    const items = [];
    const say = async (item) => { items.push(item); if (typeof emit === 'function') await emit(item); };

    // The diff: what changed, in numbers and in words. Every later step reads it.
    const diff = typeof adapters.diff === 'function' ? await adapters.diff({ cwd }) : null;
    const changed = Array.isArray(diff && diff.files) ? diff.files : (Array.isArray(files) ? files : []);
    const stats = diff && diff.stats ? String(diff.stats) : '';
    const patch = diff && diff.patch ? String(diff.patch) : '';

    // 1. the tests the change reaches.
    let pkg = null;
    const pkgRead = await run(['node', '-e', "try{process.stdout.write(require('fs').readFileSync('package.json','utf8'))}catch(e){}"], { cwd });
    if (pkgRead && pkgRead.code === 0 && pkgRead.output) { try { pkg = JSON.parse(pkgRead.output); } catch { pkg = null; } }
    const plan = testPlan({ pkg, files: changed, env: adapters.env || {} });
    if (!plan.command) {
        await say({ kind: 'tests', label: 'tests', ok: true, skipped: true, summary: plan.reason, mode: 'none' });
    } else {
        const result = await run([plan.command, ...plan.args], { cwd, timeoutMs: adapters.testTimeoutMs || 600000 });
        const output = String((result && result.output) || '');
        const ok = !!result && result.code === 0;
        // The runner's filter matched nothing: no test reaches the change by name, so nothing is proved and nothing
        // failed. Saying "the tests failed" would be a false alarm on a docs or asset change.
        const noMatch = !ok && NO_TEST_MATCH.test(output);
        await say({
            kind: 'tests', label: 'tests', ok: noMatch ? true : ok, skipped: noMatch, mode: plan.mode, reason: plan.reason,
            command: [plan.command, ...plan.args].join(' '),
            summary: noMatch ? 'no test matches the changed files, so none ran'
                : (ok ? plan.reason : (output.trim().split('\n').slice(-6).join(' ') || 'the tests failed (exit ' + result.code + ')')),
        });
    }

    // 2. the pages it touched, at the widths a person reads them.
    const pages = pageFiles(changed);
    if (!pages.length) {
        await say({ kind: 'screenshots', label: 'screenshots', ok: true, skipped: true, summary: 'the change touches no page' });
    } else if (typeof adapters.screenshot !== 'function') {
        await say({ kind: 'screenshots', label: 'screenshots', ok: true, skipped: true, summary: 'this machine cannot take screenshots' });
    } else {
        const shots = [];
        for (const width of [390, 1440]) {
            const shot = await adapters.screenshot({ cwd, width, files: pages, routes: routesOf(pages), pkg });
            shots.push({ width, ...(shot || {}) });
        }
        const made = shots.filter((s) => s && !s.skipped);
        const bad = made.filter((s) => s.ok === false);
        // A machine with nothing to shoot with (no browser, a site that did not start) says so: it is a skip, and the
        // reason is the adapter's own words, not a clean bill of health.
        const why = shots.find((s) => s && s.skipped);
        await say({
            kind: 'screenshots', label: 'screenshots', ok: !bad.length, skipped: !made.length,
            summary: bad.length
                ? bad.map((s) => s.width + 'px: ' + (s.summary || 'the page did not render')).join('; ')
                : (made.length ? made.length + ' screenshots of ' + pages.length + ' page' + (pages.length === 1 ? '' : 's')
                    : (why && why.summary) || 'no page was there to shoot'),
            shots,
        });
    }

    // 3. the diff itself.
    await say({
        kind: 'diff', label: 'diff', ok: true, skipped: false,
        summary: stats || (changed.length ? changed.length + ' file' + (changed.length === 1 ? '' : 's') + ' changed' : 'nothing changed'),
        files: changed, stats, patch: patch.slice(0, 262144),
    });

    // 4. the second opinion, from a model of another family.
    const family = familyOfAuthor(author || {});
    let verdict = null;
    if (typeof adapters.review !== 'function') {
        await say({ kind: 'review', label: 'review', ok: true, skipped: true, summary: 'no reviewer is connected here' });
    } else {
        const models = Array.isArray(adapters.models) ? adapters.models : [];
        const chosen = pickReviewer({ models, author: family });
        if (!chosen) {
            // Nobody reviewed this: not a refusal, and not a second opinion either. It is said out loud as a skip.
            await say({ kind: 'review', label: 'review', ok: true, skipped: true, summary: 'no model of another family is connected, so no second opinion was asked for' });
        } else {
            try {
                const tests = items.find((i) => i.kind === 'tests');
                verdict = await adapters.review({
                    patch, summary: (diff && diff.summary) || '',
                    tests: tests ? tests.summary : null,
                    model: chosen.model, family: chosen.family,
                });
            } catch (e) {
                // A reviewer that is not connected is a skip, not a failure: the change was not refused, nobody looked.
                if (e && (e.code === 'review.no_token' || e.code === 'review.no_model')) {
                    await say({ kind: 'review', label: 'review', ok: true, skipped: true, summary: e.message });
                    return { items, outcome: outcomeOf(items), review: null };
                }
                verdict = { family: chosen.family, model: chosen.model, verdict: 'changes_requested', summary: 'the review failed: ' + e.message, error: true };
            }
            if (!verdict || !verdict.family || verdict.family === family) {
                await say({ kind: 'review', label: 'review', ok: false, skipped: false, family: verdict && verdict.family, summary: "the review came from the author's own family, so it is not a second opinion" });
                verdict = null;
            } else {
                await say({
                    kind: 'review', label: 'review', ok: verdict.verdict === 'approved', skipped: false,
                    family: verdict.family, model: verdict.model,
                    summary: verdict.summary || (verdict.verdict === 'approved' ? 'approved' : 'changes requested'),
                });
            }
        }
    }

    return { items, outcome: outcomeOf(items), review: verdict };
}

module.exports = { collectProof, testPlan, testWords, pageFiles, routesOf, outcomeOf, proofNote, OUTCOME, KINDS, PAGE_FILE, SHARED_FILE };
