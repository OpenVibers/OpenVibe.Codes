'use strict';
const assert = require('assert');
const { expandMatrix } = require('../server/domain/bench');
const { grade } = require('../server/domain/bench-publisher');
const { check, done } = require('./helpers/boot');

(async () => {
    const def = { tasks: [{ id: 'public', prompt: 'Make a page' }, { id: 'holdout', prompt: 'Make a game', holdout: true }] };
    await check('matrix expands each revealed task across models, harnesses and repetitions', () => {
        const matrix = expandMatrix(def, ['m1', 'm2'], ['h1', 'h2'], 3);
        assert.strictEqual(matrix.length, 24);
        assert.deepStrictEqual(matrix[0], { task: def.tasks[0], model: 'm1', harness: 'h1', repetition: 1 });
        assert.strictEqual(matrix.at(-1).repetition, 3);
    });
    await check('a withheld task cannot enter the executor matrix', () => {
        assert.throws(() => expandMatrix({ tasks: [{ id: 'secret', prompt: null, holdout: true }] }, ['m'], ['h'], 1),
            (e) => e.code === 'codes.bench_holdout_hidden');
    });
    await check('automatic expected-output judges grade exact and contains checks', () => {
        assert.strictEqual(grade(' a\npage ', 'a page'), 100);
        assert.strictEqual(grade({ contains: '<main>' }, '<main>ok</main>'), 100);
        assert.strictEqual(grade({ not_contains: 'script' }, '<p>safe</p>'), 100);
        assert.strictEqual(grade('expected', 'actual'), 0);
        assert.strictEqual(grade(null, 'anything'), null);
    });
    done();
})().catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exit(1); });
