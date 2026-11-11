'use strict';
const assert = require('assert');
const { createPublicUpdates } = require('../server/data/public-updates');
(async () => {
    let calls = 0;
    const entries = [{ subject: 'A deployed change', url: 'https://github.com/OpenVibers/OpenVibe.Codes/commit/abc', deployed_at: '2026-11-10T12:00:00Z' }];
    const read = createPublicUpdates({ base: 'https://example.test', fetchImpl: async (url, options) => {
        calls++;
        assert.ok(url.endsWith('/api/v1/changelog?service=codes&limit=50'));
        assert.ok(options.signal);
        return { ok: true, json: async () => ({ entries: [...entries, { subject: 'Bad link', url: 'javascript:alert(1)' }] }) };
    } });
    assert.deepEqual(await read(), entries);
    assert.deepEqual(await read(), entries);
    assert.equal(calls, 1, 'feed is cached');
    const failed = createPublicUpdates({ base: 'https://example.test', fetchImpl: async () => { throw new Error('offline'); } });
    assert.deepEqual(await failed(), []);
    console.log('public updates: cached server-rendered feed, safe links and failure fallback pass');
})().catch(error => { console.error(error); process.exitCode = 1; });
