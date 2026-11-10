'use strict';
const assert = require('node:assert/strict');
const { check, done } = require('./helpers/boot');
const goal = require('../engine/goal');

(async () => {
    await check('goal verification is bounded and only an explicit independent acceptance passes', async () => {
        const evidence = 'x'.repeat(goal.MAX_EVIDENCE_BYTES + 50);
        assert.ok(Buffer.byteLength(goal.boundedEvidence(evidence)) <= goal.MAX_EVIDENCE_BYTES);
        let seen;
        const accepted = await goal.verify({ goal: 'file exists', check: { kind: 'command', value: 'test -f x' }, proposal: 'done', evidence,
            checkOutput: 'exit 0', callVerifier: async ({ prompt }) => { seen = prompt; return JSON.stringify({ verdict: 'accept', reason: 'check passed' }); } });
        assert.equal(accepted.status, 'accepted');
        assert.match(seen, /person’s own recorded input/);
        const invalid = await goal.verify({ goal: 'approved', check: {}, callVerifier: async () => 'maybe' });
        assert.equal(invalid.status, 'rejected');
        // A verifier that did not run is neither an acceptance nor the worker's failure: the task waits on a person.
        const failed = await goal.verify({ goal: 'file exists', check: { kind: 'command', value: 'test -f x' }, callVerifier: async () => { throw new Error('AI is down'); } });
        assert.equal(failed.status, 'failed');
    });
    done();
})();
