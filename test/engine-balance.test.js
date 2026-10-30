'use strict';

/**
 * What an agent's account has left, read the way the portal reads it (Codes C9c): the key is the person's own file,
 * the call is DeepSeek's own balance endpoint, and the number is `balance_infos[0].total_balance`. Nothing else is read,
 * and nothing else leaves: the key goes to DeepSeek and only the number comes back.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, done } = require('./helpers/boot');
const { readBalance, readBalances, keyOf, ACCOUNTS } = require('../engine/balance');

/** A home with a DeepSeek key in it, and a fetch that answers like DeepSeek does. */
function withKey(body, run) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-balance-'));
    fs.mkdirSync(path.join(home, '.config', 'deepseek'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'deepseek', 'api_key'), body);
    return run(home);
}

(async () => {
    try {
        await check('the key is the file the CLI keeps it in, and nothing else', () => {
            withKey('  sk-secret\n', (home) => {
                assert.equal(keyOf(ACCOUNTS.deepseek, { home }), 'sk-secret');
                assert.equal(keyOf(ACCOUNTS.deepseek, { home: path.join(home, 'nowhere') }), null, 'no file, no key');
            });
            const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-balance-'));
            fs.writeFileSync(path.join(empty, 'key'), '   \n');
            assert.equal(keyOf(ACCOUNTS.deepseek, { home: empty }), null, 'a blank file is no key');
        });

        await check('the balance is what DeepSeek says it is', async () => {
            const seen = [];
            const fetchImpl = async (url, opts) => {
                seen.push({ url, auth: opts.headers.Authorization });
                return { ok: true, json: async () => ({ balance_infos: [{ total_balance: '0.02' }, { total_balance: '5.00' }] }) };
            };
            const out = await withKey('sk-secret', (home) => readBalance('deepseek', { home, fetchImpl }));
            assert.equal(out.usd, 0.02, 'the first balance is the account\'s');
            assert.ok(out.at, 'and when it was read');
            assert.equal(seen.length, 1);
            assert.equal(seen[0].url, 'https://api.deepseek.com/user/balance', 'the portal\'s own call');
            assert.equal(seen[0].auth, 'Bearer sk-secret', 'with the person\'s own key');
        });

        await check('an answer that says nothing about a balance is unknown, never zero', async () => {
            const noKey = await readBalance('deepseek', { home: os.tmpdir(), fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
            assert.equal(noKey, null, 'no key, no balance');
            await withKey('sk-secret', async (home) => {
                const empty = await readBalance('deepseek', { home, fetchImpl: async () => ({ ok: true, json: async () => ({ balance_infos: [] }) }) });
                assert.equal(empty, null, 'no balance_infos, no balance');
                const broken = await readBalance('deepseek', { home, fetchImpl: async () => ({ ok: false, status: 402, json: async () => ({}) }) });
                assert.equal(broken, null, 'a refused call is no balance');
                const down = await readBalance('deepseek', { home, fetchImpl: async () => { throw new Error('unreachable'); } });
                assert.equal(down, null, 'a call that does not answer is no balance');
                const nan = await readBalance('deepseek', { home, fetchImpl: async () => ({ ok: true, json: async () => ({ balance_infos: [{ total_balance: 'nope' }] }) }) });
                assert.equal(nan, null, 'a number that is not a number is no balance');
            });
        });

        await check('every account is read, and the ones that cannot be are absent', async () => {
            const out = await withKey('sk-secret', (home) => readBalances({
                home,
                fetchImpl: async () => ({ ok: true, json: async () => ({ balance_infos: [{ total_balance: 12.5 }] }) }),
            }));
            assert.equal(out.deepseek.usd, 12.5);
            assert.deepEqual(Object.keys(out), ['deepseek'], 'an account with no key is absent, not zero');
        });
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    }
    done();
})();
