'use strict';

/**
 * GET /api/v1/runner (Link v0.76.0): which Codes job runner is current. Every Link running the Codes worker reads it and
 * moves its runner to that release by itself. It answers this server's own version (the server and the runner are one
 * release) and the job protocol, to anyone, and names nothing to download: the Link builds the address itself.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { version } = require('../package.json');

(async () => {
    const t = await boot({});
    try {
        await check("the current runner is this release, for anyone, with no address in it", async () => {
            const r = await t.get('/api/v1/runner');
            assert.strictEqual(r.status, 200, r.text);
            assert.deepStrictEqual(r.json(), { version, protocol: 'openvibe-codes@1.0.0' });
            assert.match(String(r.headers.get('cache-control')), /max-age=300/);
            assert.ok(!/https?:/.test(r.text), 'no download address in the answer');
        });
        await check('it stays on openvibe.codes (not moved to openvibe.services)', async () => {
            const { movedTo } = require('../server/http/moved');
            assert.strictEqual(movedTo({ path: '/api/v1/runner', originalUrl: '/api/v1/runner' }), null);
            const r = await t.get('/api/v1/runner');
            assert.notStrictEqual(r.status, 301);
        });
    } finally {
        await t.close();
        done();
    }
})();
