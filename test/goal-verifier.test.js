'use strict';

/**
 * AL1's independent verifier: one cheap model call, with room for the answer. A reasoning model needs more
 * than 300 tokens or it finishes with `length` and no content (the 2026-11-11 canary found this), which must
 * never become an acceptance.
 */
const assert = require('assert');
const { check, done } = require('./helpers/boot');
const { createGoalVerifier } = require('../server/domain/goal-verifier');

function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function verifier(aiAnswer) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        const target = String(url);
        if (target.endsWith('/oauth/token')) {
            calls.push({ url: target, body: null });
            return json({ access_token: 'a-test-token', token_type: 'Bearer', expires_in: 300 });
        }
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ url: target, body });
        if (target.endsWith('/v1/chat/completions')) return json({ choices: [{ message: { role: 'assistant', content: aiAnswer } }] });
        return json({ error: 'unexpected call' }, 500);
    };
    const v = createGoalVerifier({
        config: {
            oauth: { clientId: 'codes', clientSecret: 'not-a-real-secret' },
            networkInternalUrl: 'http://network.invalid',
            ai: { internalUrl: 'http://ai.invalid', audience: 'openvibe.ai' },
            goals: { model: 'deepseek-chat' },
        },
        fetchImpl,
        log: { warn: () => {} },
    });
    return { v, calls };
}

(async () => {
    await check('the verifier asks for enough answer tokens for a reasoning model', async () => {
        const { v, calls } = verifier('{"verdict":"accept","reason":"the check passed"}');
        const r = await v.verify({ goal: 'the check passes', check: { kind: 'command', value: 'true' }, proposal: 'done', evidence: '{"check_output":""}', checkOutput: '' });
        assert.strictEqual(r.status, 'accepted');
        assert.strictEqual(r.reason, 'the check passed');
        const ask = calls.find((c) => c.url.endsWith('/v1/chat/completions'));
        assert.ok(ask, 'the verifier called AI');
        assert.strictEqual(ask.body.max_tokens, 800);
        assert.strictEqual(ask.body.reasoning_effort, 'low');
        assert.strictEqual(ask.body.model, 'deepseek-chat');
    });

    await check('an empty answer is not an acceptance', async () => {
        const { v } = verifier('');
        const r = await v.verify({ goal: 'the check passes', check: { kind: 'command', value: 'true' }, proposal: 'done', evidence: '{}', checkOutput: '' });
        assert.strictEqual(r.status, 'failed');
        assert.match(r.reason, /failed to produce a verdict/);
    });

    done();
})();
