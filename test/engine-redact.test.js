'use strict';
/** The secrets that never reach an event stream (engine/redact.js). */

const assert = require('node:assert/strict');
const { check, done } = require('./helpers/boot');
const { scrub, scrubDeep } = require('../engine/redact');
const fake = require('./helpers/fakesecrets');

(async () => {
    await check('a provider key, a GitHub token and a password are replaced', () => {
        assert.ok(!scrub(`the key is ${fake.providerKey()}`).includes('abcdefghijklmnopqrstuvwx'));
        assert.ok(!scrub(fake.githubToken()).includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'));
        assert.ok(!scrub(fake.apiKey()).includes(fake.apiKeyValue()));
        assert.ok(!scrub(fake.password()).includes(fake.passwordValue()));
        assert.ok(scrub('nothing secret here').includes('nothing secret'));
    });

    await check('a value that is not a secret is left alone', () => {
        assert.equal(scrub('the file is a.js and the command is npm test'), 'the file is a.js and the command is npm test');
    });

    await check('a whole event is scrubbed, and its shape is kept', () => {
        const out = scrubDeep({ type: 'assistant', message: { content: [{ type: 'text', text: `key ${fake.providerKey()}` }] }, n: 3 });
        assert.equal(out.type, 'assistant');
        assert.equal(out.n, 3);
        assert.ok(!JSON.stringify(out).includes('abcdefghijklmnopqrstuvwx'));
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
