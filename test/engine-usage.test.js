'use strict';
/**
 * Each plan's limit windows asked of its own provider (engine/usage.js, plan §AD.37; the owner, 11-21: "detect your usage
 * limit"): Claude Code's oauth/usage, Codex's wham/usage (or its newest session file), Command Code's credit windows;
 * the token goes only to its own provider and never into what is reported; answers are cached; nothing is asked when
 * OPENVIBE_CODES_USAGE=0.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, done } = require('./helpers/boot');
const usage = require('../engine/usage');
const { probeWithUsage } = require('../engine/logins');

const SECRET = 'tok-SECRET-never-reported';
const NOW = Date.parse('2026-11-21T01:00:00Z');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function home() {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-home-'));
    const put = (rel, body) => { fs.mkdirSync(path.dirname(path.join(h, rel)), { recursive: true }); fs.writeFileSync(path.join(h, rel), typeof body === 'string' ? body : JSON.stringify(body)); };
    put('.claude/.credentials.json', { claudeAiOauth: { accessToken: SECRET, refreshToken: 'r', expiresAt: NOW + 3600e3 } });
    put('.codex/auth.json', { tokens: { access_token: SECRET, account_id: 'acct-1' } });
    put('.commandcode/auth.json', { apiKey: SECRET });
    return { h, put };
}

(async () => {
    const calls = [];
    const providers = (overrides = {}) => async (url, init) => {
        calls.push({ url: String(url), headers: init.headers });
        const u = new URL(url);
        if (overrides[u.hostname]) return overrides[u.hostname](u, init);
        if (u.hostname === 'api.anthropic.com') return json({ five_hour: { utilization: 42, resets_at: '2026-11-21T03:00:00Z' }, seven_day: { utilization: 16.04, resets_at: '2026-11-26T15:00:00Z' }, seven_day_opus: null });
        if (u.hostname === 'chatgpt.com') return json({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 12, reset_at: 1795232400, limit_window_seconds: 18000 }, secondary_window: { used_percent: 3, reset_at: 1795600000, limit_window_seconds: 604800 } }, credits: { has_credits: false, unlimited: false, balance: 0 } });
        if (u.pathname === '/alpha/whoami') return json({ org: null });
        if (u.pathname === '/alpha/billing/credits') return json({ credits: { monthlyCredits: 12.345 }, windowLimits: { fiveHour: { used: 7, cap: 14, exceeded: false, resetAt: NOW + 3600e3 }, weekly: { used: 0, cap: 35, exceeded: false, resetAt: 0 } } });
        return json({}, 404);
    };

    await check('each plan\'s windows, asked of its own provider, as used-of-100 with the reset time', async () => {
        const { h } = home();
        const rows = await probeWithUsage({ home: h, env: { PATH: '' }, fetchImpl: providers(), now: () => NOW, cacheFile: path.join(h, 'cache.json') });
        const by = Object.fromEntries(rows.map((r) => [r.id, r]));
        assert.deepEqual(by['claude-code'].windows.map((w) => [w.name, w.used, w.limit, w.resets_at]), [['5h', 42, 100, '2026-11-21T03:00:00.000Z'], ['week', 16, 100, '2026-11-26T15:00:00.000Z']]);
        assert.deepEqual(by.codex.windows.map((w) => [w.name, w.used]), [['5h', 12], ['week', 3]]);
        assert.equal(by.codex.plan, 'plus');
        assert.deepEqual(by['command-code'].windows.map((w) => [w.name, w.used, w.resets_at]), [['5h', 50, new Date(NOW + 3600e3).toISOString()], ['week', 0, null]], 'a window that has not started has no reset time');
        assert.equal(by['command-code'].credits.balance, 12.35);
        const claudeCall = calls.find((c) => c.url.includes('api.anthropic.com/api/oauth/usage'));
        assert.equal(claudeCall.headers.Authorization, `Bearer ${SECRET}`);
        assert.equal(claudeCall.headers['anthropic-beta'], 'oauth-2025-04-20');
        assert.equal(calls.find((c) => c.url.includes('wham/usage')).headers['ChatGPT-Account-Id'], 'acct-1');
        assert.ok(calls.find((c) => c.url.endsWith('/alpha/billing/credits')), 'a personal account asks without an org');
        assert.ok(!JSON.stringify(rows).includes(SECRET), 'the token is never in what is reported');
        assert.ok(!JSON.stringify(rows).includes(h), 'nor where the login file is');
    });

    await check('answers are kept 10 minutes; a failure 2; OPENVIBE_CODES_USAGE=0 asks nothing', async () => {
        const { h } = home();
        const cacheFile = path.join(h, 'cache.json');
        calls.length = 0;
        let t = NOW;
        await probeWithUsage({ home: h, env: { PATH: '' }, fetchImpl: providers(), now: () => t, cacheFile });
        const first = calls.length;
        t += 5 * 60e3;
        await probeWithUsage({ home: h, env: { PATH: '' }, fetchImpl: providers(), now: () => t, cacheFile });
        assert.equal(calls.length, first, 'within 10 minutes nothing is asked again');
        t += 6 * 60e3;
        await probeWithUsage({ home: h, env: { PATH: '' }, fetchImpl: providers(), now: () => t, cacheFile });
        assert.ok(calls.length > first, 'after 10 minutes it is');
        calls.length = 0;
        const quiet = await probeWithUsage({ home: h, env: { PATH: '', OPENVIBE_CODES_USAGE: '0' }, fetchImpl: providers(), now: () => t, cacheFile: path.join(h, 'other.json') });
        assert.equal(calls.length, 0);
        assert.equal(quiet.find((r) => r.id === 'claude-code').windows.length, 0);
    });

    await check('an expired Claude session is unknown, never refreshed; a refused Codex call falls back to the newest session file', async () => {
        const { h, put } = home();
        put('.claude/.credentials.json', { claudeAiOauth: { accessToken: SECRET, refreshToken: 'r', expiresAt: NOW - 1000 } });
        const day = path.join('.codex', 'sessions', '2026', '11', '20');
        put(path.join(day, 'rollout-2026-11-20T10-00-00-abc.jsonl'), [
            JSON.stringify({ timestamp: '2026-11-21T00:30:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 61.5, window_minutes: 300, resets_in_seconds: 3600 }, secondary: { used_percent: 22, window_minutes: 10080, resets_in_seconds: 400000 } } } }),
            '',
        ].join('\n'));
        calls.length = 0;
        const rows = await probeWithUsage({ home: h, env: { PATH: '' }, fetchImpl: providers({ 'chatgpt.com': () => json({}, 401) }), now: () => NOW, cacheFile: path.join(h, 'c.json') });
        const by = Object.fromEntries(rows.map((r) => [r.id, r]));
        assert.equal(by['claude-code'].windows.length, 0);
        assert.match(by['claude-code'].usage_note, /expired/);
        assert.ok(!calls.some((c) => c.url.includes('anthropic.com')), 'an expired session is not used (nor refreshed)');
        assert.deepEqual(by.codex.windows.map((w) => [w.name, w.used, w.resets_at]), [['5h', 61.5, '2026-11-21T01:30:00.000Z'], ['week', 22, new Date(Date.parse('2026-11-21T00:30:00Z') + 400000e3).toISOString()]]);
        assert.match(by.codex.usage_note, /newest session/);
    });

    await check('a window\'s name follows its length', () => {
        assert.equal(usage.nameOf(18000, 'x'), '5h');
        assert.equal(usage.nameOf(604800, 'x'), 'week');
        assert.equal(usage.nameOf(86400, 'x'), '1d');
        assert.equal(usage.nameOf(null, 'fallback'), 'fallback');
    });

    done();
})();
