'use strict';

/**
 * Stage C8, the engine half: the proof collector (engine/proof.js) and the second opinion (engine/review.js).
 *
 * The collector asks for four things — the repo's own tests, the pages the diff touches, the diff, and a model of
 * another family — and every one of them is an adapter, so a fake stands in for the machine here: the tests never run,
 * no browser opens and no model is called.
 */
const assert = require('assert');
const { collectProof, testPlan, testWords, pageFiles, routesOf, outcomeOf } = require('../engine/proof');
const { familyOf, authorFamily, pickReviewer, readVerdict } = require('../engine/review');
const { check, done } = require('./helpers/boot');

(async () => {
    /** A fake machine: the repo's package.json, a passing test run, a clean page and a second model's opinion. */
    const machine = ({ pkg = { scripts: { test: 'node test/run.js' } }, files = [], testExit = 0, review = null, shots = [] } = {}) => {
        const calls = [];
        const run = async (argv, options) => {
            calls.push(argv);
            if (argv[0] === 'node' && argv[1] === '-e') return { code: 0, output: JSON.stringify(pkg) };
            if (argv[0] === 'node' && argv[1] === 'test/run.js') return { code: testExit, output: testExit === 0 ? '12/12 test files passed' : 'FAIL test/foo.test.js\nAssertionError' };
            if (argv[0] === 'npm') return { code: testExit, output: testExit === 0 ? '12/12 test files passed' : 'FAIL test/foo.test.js\nAssertionError' };
            return { code: 0, output: '' };
        };
        return {
            calls,
            adapters: {
                run,
                diff: async () => ({ files, stats: files.length + ' files changed', patch: '+ the change', summary: files.length + ' files changed' }),
                screenshot: async ({ width }) => (shots.find((s) => s.width === width) || { ok: true, path: `/proof/${width}.png`, summary: 'the page renders clean' }),
                review: review || (async () => ({ family: 'deepseek', verdict: 'approved', summary: 'It holds together.' })),
                models: ['claude-sonnet-4', 'deepseek-chat', 'gpt-5'],
                env: {},
            },
        };
    };

    try {
        await check('the collector asks for the four things, in order, and says what each one found', async () => {
            const m = machine({ files: ['engine/proof.js', 'public/index.html'] });
            const proof = await collectProof({ cwd: '/repo', adapters: m.adapters, author: { agent: 'claude-code', model: 'claude-sonnet-4' } });
            assert.deepStrictEqual(proof.items.map((i) => i.kind), ['tests', 'screenshots', 'diff', 'review']);
            assert.strictEqual(proof.outcome.state, 'done');
            assert.ok(/^Done with proof/.test(proof.outcome.note), proof.outcome.note);
            assert.strictEqual(proof.review.family, 'deepseek');
        });

        await check('the repo\'s own runner is used, narrowed to the tests the change reaches', async () => {
            const m = machine({ files: ['engine/proof.js'] });
            const proof = await collectProof({ cwd: '/repo', adapters: m.adapters });
            const test = proof.items.find((i) => i.kind === 'tests');
            assert.strictEqual(test.ok, true);
            assert.strictEqual(test.command, 'node test/run.js proof');
            assert.strictEqual(test.mode, 'targeted');
        });

        await check('a test script with its own flags is left to npm, and the words follow --', async () => {
            const plan = testPlan({ pkg: { scripts: { test: 'node --test test/' } }, files: ['engine/proof.js'], env: {} });
            assert.strictEqual(plan.command, 'npm');
            assert.deepStrictEqual(plan.args, ['test', '--', 'proof']);
        });

        await check('the whole suite runs only when the change touches what every test shares and the guard allows it', async () => {
            const shared = testPlan({ pkg: { scripts: { test: 'node test/run.js' } }, files: ['package.json'], env: {} });
            assert.strictEqual(shared.mode, 'targeted');
            assert.ok(/full suite is not allowed/.test(shared.reason), shared.reason);
            const allowed = testPlan({ pkg: { scripts: { test: 'node test/run.js' } }, files: ['package.json'], env: { CODES_PROOF_FULL_SUITE: '1' } });
            assert.strictEqual(allowed.mode, 'full');
            assert.deepStrictEqual(allowed.args, ['test/run.js']);
        });

        await check('a repo with no test command of its own says so instead of failing', async () => {
            const m = machine({ pkg: { scripts: {} } });
            const proof = await collectProof({ cwd: '/repo', adapters: m.adapters });
            const test = proof.items.find((i) => i.kind === 'tests');
            assert.strictEqual(test.skipped, true);
            assert.ok(/no test command/.test(test.summary), test.summary);
        });

        await check('the pages the diff touches are shot at a phone\'s and a desktop\'s width', async () => {
            const m = machine({ files: ['public/index.html', 'server/http/run.js', 'engine/proof.js'] });
            const proof = await collectProof({ cwd: '/repo', adapters: m.adapters });
            const shots = proof.items.find((i) => i.kind === 'screenshots');
            assert.strictEqual(shots.ok, true);
            assert.deepStrictEqual(shots.shots.map((s) => s.width), [390, 1440]);
        });

        await check('a change that touches no page says so, and does not open a browser', async () => {
            const m = machine({ files: ['engine/proof.js'] });
            const proof = await collectProof({ cwd: '/repo', adapters: m.adapters });
            const shots = proof.items.find((i) => i.kind === 'screenshots');
            assert.strictEqual(shots.skipped, true);
            assert.ok(/touches no page/.test(shots.summary), shots.summary);
        });

        await check('a machine with nothing to shoot with says the screenshots were skipped, and why', async () => {
            const m = machine({ files: ['public/index.html'] });
            m.adapters.screenshot = async ({ width }) => ({ ok: true, skipped: true, width, summary: 'the site did not start, so the pages were not shot' });
            const proof = await collectProof({ cwd: '/repo', adapters: m.adapters });
            const shots = proof.items.find((i) => i.kind === 'screenshots');
            assert.strictEqual(shots.skipped, true);
            assert.ok(/did not start/.test(shots.summary), shots.summary);
            assert.ok(/screenshots was skipped/.test(proof.outcome.note), proof.outcome.note);
        });

        await check('a page that scrolls sideways is a failure of the proof, not a picture of one', async () => {
            const m = machine({ files: ['public/index.html'], shots: [{ width: 390, ok: false, summary: 'the page is 480px wide, so it scrolls sideways on a 390px screen' }] });
            const proof = await collectProof({ cwd: '/repo', adapters: m.adapters });
            const shots = proof.items.find((i) => i.kind === 'screenshots');
            assert.strictEqual(shots.ok, false);
            assert.ok(/scrolls sideways/.test(shots.summary), shots.summary);
            assert.strictEqual(proof.outcome.state, 'unfinished');
            assert.ok(/Didn't finish, with what is left/.test(proof.outcome.note), proof.outcome.note);
        });

        await check('a review by the author\'s own family is refused: it is not a second opinion', async () => {
            const m = machine({ files: ['engine/proof.js'], review: async () => ({ family: 'anthropic', verdict: 'approved', summary: 'Fine.' }) });
            const proof = await collectProof({ cwd: '/repo', adapters: m.adapters, author: { agent: 'claude-code', model: 'claude-sonnet-4' } });
            const review = proof.items.find((i) => i.kind === 'review');
            assert.strictEqual(review.ok, false);
            assert.ok(/own family/.test(review.summary), review.summary);
            assert.strictEqual(proof.review, null);
        });

        await check('a change request from the second model is said out loud, not hidden', async () => {
            const m = machine({ files: ['engine/proof.js'], review: async () => ({ family: 'deepseek', verdict: 'changes_requested', summary: 'The parser still throws on an empty file.' }) });
            const proof = await collectProof({ cwd: '/repo', adapters: m.adapters, author: { agent: 'claude-code', model: 'claude-sonnet-4' } });
            const review = proof.items.find((i) => i.kind === 'review');
            assert.strictEqual(review.ok, false);
            assert.ok(/empty file/.test(review.summary), review.summary);
            assert.strictEqual(proof.outcome.state, 'unfinished');
        });

        await check('no reviewer connected is a skip, not a failure', async () => {
            const m = machine({ files: ['engine/proof.js'] });
            const proof = await collectProof({ cwd: '/repo', adapters: { ...m.adapters, review: undefined, models: [] } });
            const review = proof.items.find((i) => i.kind === 'review');
            assert.strictEqual(review.skipped, true);
            assert.strictEqual(proof.outcome.state, 'done');
        });

        await check('a machine with only the author\'s family says nobody reviewed, and is not called unfinished', async () => {
            const m = machine({ files: ['engine/proof.js'] });
            const proof = await collectProof({
                cwd: '/repo', adapters: { ...m.adapters, models: ['claude-sonnet-4', 'claude-opus-4'] },
                author: { agent: 'claude-code', model: 'claude-sonnet-4' },
            });
            const review = proof.items.find((i) => i.kind === 'review');
            assert.strictEqual(review.skipped, true);
            assert.ok(/no model of another family/.test(review.summary), review.summary);
            assert.strictEqual(proof.outcome.state, 'done');
            assert.ok(/review was skipped/.test(proof.outcome.note), proof.outcome.note);
        });

        await check('the diff is collected: the files, the stats and the patch', async () => {
            const m = machine({ files: ['engine/proof.js'] });
            const proof = await collectProof({ cwd: '/repo', adapters: m.adapters });
            const diff = proof.items.find((i) => i.kind === 'diff');
            assert.deepStrictEqual(diff.files, ['engine/proof.js']);
            assert.strictEqual(diff.patch, '+ the change');
        });

        await check('every item is emitted as it is collected, so the page can show it live', async () => {
            const m = machine({ files: ['engine/proof.js'] });
            const seen = [];
            await collectProof({ cwd: '/repo', adapters: m.adapters, emit: async (item) => seen.push(item.kind) });
            assert.deepStrictEqual(seen, ['tests', 'screenshots', 'diff', 'review']);
        });

        await check('the model families are read from the model\'s own name', async () => {
            assert.strictEqual(familyOf('claude-sonnet-4'), 'anthropic');
            assert.strictEqual(familyOf('gpt-5'), 'openai');
            assert.strictEqual(familyOf('deepseek-chat'), 'deepseek');
            assert.strictEqual(familyOf('gemini-2.5-pro'), 'google');
            assert.strictEqual(familyOf('something-else'), null);
            assert.strictEqual(authorFamily({ agent: 'claude-code' }), 'anthropic');
            assert.strictEqual(authorFamily({ agent: 'codex', model: 'gpt-5' }), 'openai');
        });

        await check('the reviewer is a model of another family', async () => {
            const picked = pickReviewer({ models: ['claude-sonnet-4', 'deepseek-chat'], author: 'anthropic' });
            assert.strictEqual(picked.family, 'deepseek');
            assert.strictEqual(pickReviewer({ models: ['claude-sonnet-4'], author: 'anthropic' }), null);
        });

        await check('a verdict is read from JSON or from the words, and an empty answer is a change request', async () => {
            assert.strictEqual(readVerdict('{"verdict":"approved","summary":"ok"}').verdict, 'approved');
            assert.strictEqual(readVerdict('looks good to me').verdict, 'approved');
            assert.strictEqual(readVerdict('this needs changes').verdict, 'changes_requested');
            assert.strictEqual(readVerdict('').verdict, 'changes_requested');
        });

        await check('the changed files that are pages, and the routes they are served at', async () => {
            assert.deepStrictEqual(pageFiles(['public/index.html', 'engine/proof.js']), ['public/index.html']);
            assert.deepStrictEqual(routesOf(['public/index.html', 'public/a/b.html']), ['/', '/a/b']);
            assert.deepStrictEqual(testWords(['engine/proof.js']), ['proof']);
        });

        await check('the outcome in plain words: done with proof, or what is left', async () => {
            assert.strictEqual(outcomeOf([{ kind: 'tests', label: 'tests', ok: true }]).state, 'done');
            assert.ok(/Done with proof/.test(outcomeOf([{ kind: 'tests', label: 'tests', ok: true }]).note));
            assert.strictEqual(outcomeOf([{ kind: 'tests', label: 'tests', ok: false, summary: 'it failed' }]).state, 'unfinished');
        });

        console.log('proof: the tests, the pages, the diff and the second opinion are collected, and said in plain words');
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
    done();
})();
