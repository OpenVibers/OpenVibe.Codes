'use strict';
// The job scopes, ported from the portal's jobscope.js. On a machine without systemd (or with the scopes turned off)
// the module must do nothing at all: the command is spawned as it was, and the reaper has nothing to reap.

const assert = require('node:assert/strict');
const { check, done } = require('./helpers/boot');

process.env.OV_NO_JOB_SCOPES = '1';
const scope = require('../engine/scope');

(async () => {
    await check('without systemd the command is spawned as it was', () => {
        assert.equal(scope.available(), false);
        const wrapped = scope.wrap('node', ['server.js'], 'cc-my-job');
        assert.equal(wrapped.cmd, 'node');
        assert.deepEqual(wrapped.args, ['server.js']);
        assert.equal(wrapped.unit, null);
    });

    await check('without systemd the reaper has nothing to reap', async () => {
        assert.deepEqual(await scope.reap(), []);
        assert.deepEqual(await scope.reap({ log: () => { throw new Error('the reaper must stay quiet'); } }), []);
        assert.equal(await scope.stopFor(1234), null);
    });

    await check('the slice and the per-job caps are the portal\'s', () => {
        assert.equal(scope.SLICE, 'ovjobs.slice');
    });

    done();
})();
