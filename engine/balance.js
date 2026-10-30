'use strict';

/**
 * What an agent's account has left, read the way the portal reads it (Codes C9c).
 *
 * A plan window (the fleet) says how much of a paid plan is used. A pay-per-token agent has no window: it has a
 * balance, and DeepSeek says what is left of it at `GET https://api.deepseek.com/user/balance` — the same call the
 * portal's account card makes, with the person's own key in `~/.config/deepseek/api_key`, and the same reading of the
 * answer: `balance_infos[0].total_balance`.
 *
 * The key never leaves the machine that holds it: it goes to DeepSeek and nowhere else, and only the number comes
 * back. A key that is not there, a call that does not answer, or an answer that says nothing about a balance, is
 * "unknown" (null) — never a number of zero, which would read as "spent".
 *
 *   readBalances({ home, fetchImpl, endpoint }) → { deepseek: { usd, at } } (a harness with no key is absent)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** The call the portal makes, and the file the key is in. */
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/user/balance';
const DEEPSEEK_KEY_FILE = path.join('.config', 'deepseek', 'api_key');

/** The harness each balance belongs to: the pay-per-token agents Codes runs. */
const ACCOUNTS = { deepseek: { endpoint: DEEPSEEK_ENDPOINT, keyFile: DEEPSEEK_KEY_FILE } };

/**
 * The key of an account, read from the file the CLI keeps it in. Nothing else: no key file, no key.
 *
 * @returns {string|null} the trimmed key, or null when there is none
 */
function keyOf(account, { home = os.homedir() } = {}) {
    try {
        const key = fs.readFileSync(path.join(home, account.keyFile), 'utf8').trim();
        return key || null;
    } catch {
        return null;
    }
}

/**
 * One account's balance, as the provider says it.
 *
 * @param {string} name the account's name (deepseek)
 * @param {object} opts
 * @param {string} [opts.home] the home the key file is under
 * @param {Function} [opts.fetchImpl] the fetch to use
 * @param {string} [opts.endpoint] the endpoint to call
 * @returns {Promise<{usd: number, at: string}|null>} the balance, or null when it is unknown
 */
async function readBalance(name, { home = os.homedir(), fetchImpl = globalThis.fetch, endpoint = null } = {}) {
    const account = ACCOUNTS[name];
    if (!account) return null;
    const key = keyOf(account, { home });
    if (!key) return null;
    const url = endpoint || account.endpoint;
    let doc;
    try {
        const res = await fetchImpl(url, {
            headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;
        doc = await res.json().catch(() => null);
    } catch {
        return null;
    }
    const infos = doc && Array.isArray(doc.balance_infos) ? doc.balance_infos : [];
    const first = infos[0];
    if (!first || typeof first !== 'object') return null;
    const usd = Number(first.total_balance);
    if (!Number.isFinite(usd)) return null;
    return { usd, at: new Date().toISOString() };
}

/**
 * Every account's balance this module knows: { [harness]: { usd, at } }. A harness with no key, or one that did not
 * answer, is absent — an unknown balance, which is never a reason to skip an agent.
 *
 * @param {object} opts
 * @returns {Promise<object>} the balances
 */
async function readBalances({ home = os.homedir(), fetchImpl = globalThis.fetch, endpoint = null, names = Object.keys(ACCOUNTS) } = {}) {
    const out = {};
    for (const name of names) {
        const one = await readBalance(name, { home, fetchImpl, endpoint });
        if (one) out[name] = one;
    }
    return out;
}

module.exports = { readBalance, readBalances, keyOf, ACCOUNTS, DEEPSEEK_ENDPOINT, DEEPSEEK_KEY_FILE };
