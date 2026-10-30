'use strict';

const assert = require('assert');
const { collectProof } = require('../engine/proof');

(async () => {
    const calls = [];
    const emitted = [];
    const proof = await collectProof({
        cwd: '/repo', authorFamily: 'family-a', emit: async (item) => emitted.push(item),
        run: async (argv, options) => {
            calls.push([argv, options]);
            if (argv[0] === 'node') return { code: 0, output: JSON.stringify({ test: 'node test/run.js' }) };
            if (argv[0] === 'git' && argv[1] === 'diff' && argv.includes('--name-only')) return { code: 0, output: 'public/index.html\nserver/app.js\n' };
            if (argv[0] === 'git' && argv.includes('--stat')) return { code: 0, output: ' 2 files changed' };
            if (argv[0] === 'git' && argv.includes('--no-ext-diff')) return { code: 0, output: '+change' };
            return { code: 0, output: 'all passed' };
        },
        screenshot: async ({ width }) => ({ passed: true, path: `/proof/${width}.png` }),
        review: async ({ patch, authorFamily }) => {
            assert.strictEqual(patch, '+change');
            assert.strictEqual(authorFamily, 'family-a');
            return { family: 'family-b', verdict: 'approved', summary: 'Looks good.' };
        },
    });
    assert.strictEqual(proof.outcome, 'Done with proof');
    assert.deepStrictEqual(proof.items.filter((x) => x.label === 'screenshot').map((x) => x.width), [390, 1440]);
    assert.strictEqual(proof.items.find((x) => x.label === 'review').family, 'family-b');
    assert.strictEqual(emitted.length, proof.items.length);
    assert.ok(calls.every(([, options]) => options.cwd === '/repo'));

    await assert.rejects(() => collectProof({ cwd: '/repo', run: async () => ({ code: 0 }), screenshot: async () => ({ passed: true }),
        review: async () => ({ family: 'family-a', verdict: 'approved' }), authorFamily: 'family-a' }), /different model family/);
    console.log('proof pipeline: fake test, screenshots, diff and independent review verified');
})().catch((e) => { console.error(e); process.exit(1); });
