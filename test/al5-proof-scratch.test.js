'use strict';
/**
 * AL5 live proof (scratch): this test fails on purpose. A red check on its pull request is the evidence the
 * ticket-follows-PR path wakes on. This file and its PR are thrown away after the proof.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        await check('scratch: the proof test fails so the PR goes red', async () => {
            assert.strictEqual(1 + 1, 3, 'AL5 proof: intended red');
        });
        done();
    } finally {
        await t.close();
    }
})();
