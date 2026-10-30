'use strict';

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { parseArgs } = require('../harness/job');

(async () => {
    const published = [];
    const t = await boot({
        run: { async submit() { throw new Error('machine unavailable'); } },
        benchAttemptEnded: async (row) => published.push(row),
    });
    try {
        const person = t.network.addUser('bench-person');
        await check('a benchmark task rejected by Run is sent to the publisher as a terminal failure', async () => {
            const row = await t.ctx.tasks.start({
                subject: person.subject,
                project: 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1',
                args: parseArgs(JSON.stringify({ kind: 'bench', prompt: 'Return one short answer.', agent: 'deepseek', model: 'deepseek/test' })),
                actorRef: { bench: { run_id: 'brn_01J8Z3Q4R5S6T7V8W9X0Y1Z2R1', task_count: 1 } },
            });
            assert.strictEqual(row.state, 'failed');
            assert.strictEqual(published.length, 1);
            assert.strictEqual(published[0].id, row.id);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
