'use strict';

/**
 * Stage C8, the second opinion: engine/review.js with a fake fetch.
 *
 * The rule that makes the review worth reading is the family: a model of the family that wrote the change repeats its
 * own reasoning, so its verdict is refused. The call itself is one request to OpenVibe.AI, read as a verdict even
 * when the model answers in prose.
 */
const assert = require('assert');
const {
    familyOf, authorFamily, pickReviewer, reviewPrompt, readVerdict, reviewWithAi,
} = require('../engine/review');
const { check, done } = require('./helpers/boot');

const OK = async () => ({ status: 200, ok: true, json: async () => ({ choices: [{ message: { content: '{"verdict":"approved","summary":"It holds together."}' } }] }) });

(async () => {
    try {
        await check('the model families are read from the model\'s own name', () => {
            assert.strictEqual(familyOf('claude-sonnet-4'), 'anthropic');
            assert.strictEqual(familyOf('gpt-5'), 'openai');
            assert.strictEqual(familyOf('deepseek-chat'), 'deepseek');
            assert.strictEqual(familyOf('gemini-2.5-pro'), 'google');
            assert.strictEqual(familyOf('something-else'), null);
            assert.strictEqual(authorFamily({ agent: 'claude-code' }), 'anthropic');
            assert.strictEqual(authorFamily({ agent: 'codex', model: 'gpt-5' }), 'openai');
        });

        await check('the reviewer is a model of another family', () => {
            const picked = pickReviewer({ models: ['claude-sonnet-4', 'deepseek-chat'], author: 'anthropic' });
            assert.strictEqual(picked.family, 'deepseek');
            assert.strictEqual(pickReviewer({ models: ['claude-sonnet-4'], author: 'anthropic' }), null);
        });

        await check('a verdict is read from JSON or from the words, and an empty answer is a change request', () => {
            assert.strictEqual(readVerdict('{"verdict":"approved","summary":"ok"}').verdict, 'approved');
            assert.strictEqual(readVerdict('looks good to me').verdict, 'approved');
            assert.strictEqual(readVerdict('this needs changes').verdict, 'changes_requested');
            assert.strictEqual(readVerdict('').verdict, 'changes_requested');
            assert.strictEqual(readVerdict('{"verdict":"changes_requested","summary":"no"}').verdict, 'changes_requested');
        });

        await check('the prompt carries the change, what it was for, and the tests, and asks for JSON', () => {
            const prompt = reviewPrompt({ patch: '+const x = 1;', summary: 'add x', tests: '3 passed' });
            assert.ok(prompt.includes('+const x = 1;'), 'the diff is in the prompt');
            assert.ok(prompt.includes('add x'), 'what the change was for is in the prompt');
            assert.ok(prompt.includes('3 passed'), 'the tests are in the prompt');
            assert.ok(/approved/.test(prompt) && /changes_requested/.test(prompt), 'the verdict is asked for');
        });

        await check('the review is one chat completion, with the token, read as a verdict', async () => {
            const calls = [];
            const fetchImpl = async (url, options) => { calls.push({ url, options }); return OK(); };
            const verdict = await reviewWithAi({
                baseUrl: 'https://ai.openvibe.services/v1', token: 'test-token', model: 'deepseek-chat',
                patch: '+x', summary: 'a change', fetchImpl,
            });
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].url, 'https://ai.openvibe.services/v1/chat/completions');
            assert.strictEqual(calls[0].options.headers.authorization, 'Bearer test-token');
            assert.strictEqual(JSON.parse(calls[0].options.body).model, 'deepseek-chat');
            assert.strictEqual(verdict.verdict, 'approved');
            assert.strictEqual(verdict.family, 'deepseek');
        });

        await check('a provider that speaks the messages dialect is tried when chat completions is not there', async () => {
            const calls = [];
            const fetchImpl = async (url) => {
                calls.push(url);
                if (url.endsWith('/chat/completions')) return { status: 404, ok: false, json: async () => ({}) };
                return { status: 200, ok: true, json: async () => ({ content: [{ type: 'text', text: 'changes requested: the parser still throws' }] }) };
            };
            const verdict = await reviewWithAi({ token: 'test-token', model: 'claude-sonnet-4', patch: '+x', fetchImpl });
            assert.ok(calls[1].endsWith('/messages'), calls[1]);
            assert.strictEqual(verdict.verdict, 'changes_requested');
        });

        await check('a review needs the token and the model, and says which is missing', async () => {
            await assert.rejects(() => reviewWithAi({ model: 'x', fetchImpl: OK }), /token/);
            await assert.rejects(() => reviewWithAi({ token: 't', fetchImpl: OK }), /model/);
        });

        await check('a refused review is an error, not a verdict', async () => {
            const fetchImpl = async () => ({ status: 429, ok: false, json: async () => ({}) });
            await assert.rejects(() => reviewWithAi({ token: 't', model: 'deepseek-chat', patch: '+x', fetchImpl }), /refused the review \(HTTP 429\)/);
        });

        console.log('review: a model of another family, one call to OpenVibe.AI, and a verdict read from what it says');
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
    done();
})();
