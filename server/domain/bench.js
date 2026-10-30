'use strict';

/** Expand a frozen benchmark into one output attempt for every task × model × harness × repetition. */
function expandMatrix(definition, models, harnesses, repeat) {
    const tasks = Array.isArray(definition && definition.tasks) ? definition.tasks : [];
    const cells = [];
    for (const model of models) for (const harness of harnesses) for (let repetition = 1; repetition <= repeat; repetition++) {
        for (const task of tasks) {
            if (!task || typeof task.id !== 'string' || typeof task.prompt !== 'string' || !task.prompt.trim()) {
                throw Object.assign(new Error('the executor definition must reveal every benchmark task prompt'), { code: 'codes.bench_holdout_hidden' });
            }
            cells.push({ task, model, harness, repetition });
        }
    }
    return cells;
}

module.exports = { expandMatrix };
