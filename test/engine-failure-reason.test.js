'use strict';
// The failure reasons, ported from the portal's test-failure-reason.js: why a run failed, and what that means for the
// routing. A limit, a lost sign-in, a busy model and a runner turned off are the runner switch's business; a real
// error is not (and must not be mistaken for one).

const assert = require('node:assert/strict');
const { check, done } = require('./helpers/boot');
const { reason, SWITCHABLE } = require('../engine/chain');
const { track } = require('../engine/router');

const generic = 'API Error: Command Code ended without a result (credits, rate limit or a crash: check its exit code)';
const CASES = [
    [generic, 'error'],
    [generic + '\nAPI Error: usage limit reached', 'limit'],
    ['mcode exec failed: The run failed: Internal server error. Please retry your request. (500). Retry after the connection recovers.', 'capacity'],
    ['HTTP 502 Bad Gateway', 'capacity'], ['status code: 504', 'capacity'],
    ['Request rejected (429)', 'limit'], ['HTTP 429', 'limit'],
    ['API key has expired', 'auth'], ['model at capacity', 'capacity'],
    ['turned off in the agent portal', 'refused'],
    ['AssertionError: expected 500 items, got 429', 'error'],
    ['test failed: expected HTTP 200, got 404', 'error'],
];

(async () => {
    await check('every error is classified', () => {
        for (const [text, expected] of CASES) assert.equal(reason(text), expected, text);
        assert.equal(reason(''), 'unknown');
    });

    await check('a provider outage is the runner switch\'s business', () => {
        assert.equal(SWITCHABLE.has(reason(CASES[2][0])), true, 'provider outages use existing fallback');
    });

    await check('an unknown failure is not excluded as a quota failure', () => {
        assert.deepEqual(track([{ runner: 'cc', status: 'failed', updated: Date.now(), reason: reason(generic) }]), { cc: { done: 0, failed: 1 } }, 'unknown failures must not be excluded as quota failures');
    });

    await check('a provider outage does not penalise a runner\'s reliability', () => {
        assert.deepEqual(track([{ runner: 'mm', status: 'failed', updated: Date.now(), reason: reason(CASES[2][0]) }]), {}, 'provider outages do not penalize coding reliability');
    });

    done();
})();
