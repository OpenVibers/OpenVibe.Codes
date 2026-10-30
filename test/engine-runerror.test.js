'use strict';
// What a failed run really said, ported from the portal's test-runerror.js: the wrapper's own no-result message is
// possible causes, not an observed failure; the launch command echoed after a killed child is never the error.

const assert = require('node:assert/strict');
const { check, done } = require('./helpers/boot');
const { failureError } = require('../engine/runerror');

const generic = 'API Error: Command Code ended without a result (credits, rate limit or a crash: check its exit code)';
const event = (result) => JSON.stringify({ type: 'result', is_error: true, result });

(async () => {
    await check('the error of a failed run is told from the feed, the stderr and the summary', () => {
        assert.equal(failureError(event('API Error: model "x" is unavailable\nRetry later.'), 'launcher noise'), 'API Error: model "x" is unavailable\nRetry later.');
        assert.equal(failureError(event(generic), '/r/cc-run.sh: line 61: 998 Killed cmd -p "# brief\n- report PRs --yolo -m model\n"'), 'Killed');
        assert.equal(failureError(event(generic), '/r/cc-run.sh: line 61: 998 Killed cmd -p "# brief\nAPI Error: quota in a quoted example\n"'), 'Killed');
        assert.equal(failureError(event(generic), 'Terminated.\n- report PRs --yolo'), 'Terminated.');
        assert.equal(failureError(event(generic), '- report PRs --yolo'), generic);
        assert.equal(failureError(event(generic), 'API Error: usage limit reached'), 'API Error: usage limit reached');
        assert.equal(failureError('partial JSON\n' + event('Refused: off'), ''), 'Refused: off');
        assert.equal(failureError(JSON.stringify({ type: 'tool_result', text: 'Error: test fixture' }), '', 'actual provider failure'), 'actual provider failure');
        assert.equal(failureError(JSON.stringify({ type: 'result', is_error: true, errors: ['one', { message: 'two' }] }), ''), 'one; two');
        assert.equal(failureError('', '[claude-code:unrecognized_model] {"model":"example"}'), '[claude-code:unrecognized_model] {"model":"example"}');
        assert.equal(failureError('', 'mcode exec failed: Internal server error. (500).'), 'mcode exec failed: Internal server error. (500).');
    });

    await check('the error is short and never empty by accident', () => {
        assert.equal(failureError(event('x'.repeat(500)), '').length, 200);
        assert.equal(failureError('', ''), '');
    });

    done();
})();
