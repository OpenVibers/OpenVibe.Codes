'use strict';
/**
 * The Setup tab's Test button for Codes' owner inputs (the owner-setup design of 2026-11-07). Each test is one call
 * that changes nothing: GitHub's rate limit for the token, GitHub's and OpenVibe Git's token endpoint with a code
 * that cannot exist (the answer says whether the app's ID and secret were accepted), npm's whoami. The answer is one
 * line; the value never appears in it, in a log line or in an error.
 */
const TIMEOUT_MS = 10_000;

async function call(fetchImpl, url, init = {}) {
    let res;
    try {
        res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
        return { status: 0, json: null, error: err && err.name === 'TimeoutError' ? 'did not answer within 10 seconds' : 'could not be reached' };
    }
    const json = await res.json().catch(() => null);
    return { status: res.status, json, error: null };
}

const said = (j) => (j && (j.error_description || j.message || (typeof j.error === 'string' ? j.error : ''))) || '';

/** An OAuth app's ID and secret against its token endpoint, with a code that cannot exist. */
async function oauthApp(name, url, clientId, clientSecret, fetchImpl) {
    if (!clientId) return { ok: false, message: `The ${name} app's client ID is not set yet; enter it first, then test the secret.` };
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: 'openvibe-setup-check', grant_type: 'authorization_code', redirect_uri: 'https://openvibe.codes/setup-check' });
    const r = await call(fetchImpl, url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    if (r.error) return { ok: false, message: `${name} ${r.error}.` };
    const code = r.json && typeof r.json.error === 'string' ? r.json.error : '';
    // The code is wrong by design: an app whose ID and secret are right gets "bad code", one whose are wrong gets refused.
    if (code === 'bad_verification_code' || code === 'invalid_grant') return { ok: true, message: `${name} accepted the app's client ID and secret.` };
    if (code === 'incorrect_client_credentials' || code === 'invalid_client' || code === 'unauthorized_client') return { ok: false, message: `${name} refused the app's client ID or secret${said(r.json) ? `: ${said(r.json)}` : '.'}` };
    return { ok: false, message: `${name} answered ${r.status}${said(r.json) ? `: ${said(r.json)}` : ''}; the app could not be checked.` };
}

function createOwnerInputTests({ ownerInputs, fetchImpl = globalThis.fetch }) {
    const github = String(process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
    const tests = {
        'codes.accounts': {
            'github.token': async (token) => {
                const r = await call(fetchImpl, `${github}/rate_limit`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'openvibe-codes', Authorization: `Bearer ${token}` } });
                if (r.status === 200) {
                    const limit = r.json && r.json.resources && r.json.resources.core && r.json.resources.core.limit;
                    return { ok: true, message: `GitHub accepted the token${limit ? `: Codes may make ${Number(limit).toLocaleString('en-US')} requests an hour` : ''}.` };
                }
                if (r.error) return { ok: false, message: `GitHub ${r.error}.` };
                return { ok: false, message: `GitHub ${r.status === 401 ? 'refused the token (401)' : `answered ${r.status}`}${said(r.json) ? `: ${said(r.json)}` : '.'}` };
            },
            'github.client_secret': async (secret) => oauthApp('GitHub', 'https://github.com/login/oauth/access_token', ownerInputs.value('codes.accounts', 'github.client_id').value, secret, fetchImpl),
        },
        'codes.publishing': {
            'npm.token': async (token) => {
                const r = await call(fetchImpl, 'https://registry.npmjs.org/-/whoami', { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
                if (r.status === 200 && r.json && r.json.username) return { ok: true, message: `npm accepted the token: it belongs to ${r.json.username}.` };
                if (r.error) return { ok: false, message: `npm ${r.error}.` };
                return { ok: false, message: `npm ${r.status === 401 || r.status === 403 ? `refused the token (${r.status})` : `answered ${r.status}`}${said(r.json) ? `: ${said(r.json)}` : '.'}` };
            },
        },
    };
    /** { value, source, env, run } for a key that has a test, else null. */
    return function find(namespace, key) {
        const t = tests[namespace] && tests[namespace][key];
        if (!t) return null;
        return { ...ownerInputs.value(namespace, key), run: t };
    };
}

module.exports = { createOwnerInputTests, oauthApp };
