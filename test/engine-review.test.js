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
    familyOf, authorFamily, pickReviewer, reviewPrompt, readReview, readVerdict, reviewWithAi, reviewTwoAxes,
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

        await check('standards and spec have separate contexts, and absent spec is not run', async () => {
            const prompts = [];
            const fetchImpl = async (_url, options) => {
                prompts.push(JSON.parse(options.body).messages[0].content);
                return OK();
            };
            const opts = { token: 'test-token', model: 'deepseek-chat', patch: '+x', summary: 'ticket requirement', standards: 'repository rule', fetchImpl };
            const reviewed = await reviewTwoAxes(opts);
            assert.strictEqual(reviewed.verdict, 'approved');
            assert.strictEqual(prompts.length, 2);
            assert.match(prompts[0], /repository rule/);
            assert.ok(!prompts[0].includes('ticket requirement'));
            assert.match(prompts[1], /ticket requirement/);
            assert.ok(!prompts[1].includes('repository rule'));
            const missing = await reviewTwoAxes({ ...opts, summary: '' });
            assert.strictEqual(missing.axes.spec.verdict, 'not_run');
            assert.strictEqual(prompts.length, 3);
            const findingsFetch = async (_url, options) => {
                const isSpec = JSON.parse(options.body).messages[0].content.includes('Spec axis only');
                const findings = isSpec ? [{ file: 'spec.js', line: 3, text: 'ticket case is missing' }] : [
                    { file: 'a.js', line: 1, text: 'duplicated code' },
                    { file: 'b.js', line: 2, text: 'hidden side effect' },
                    { file: 'c.js', line: 4, text: 'misleading name' },
                ];
                return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ verdict: 'changes_requested', summary: 'findings', findings }) } }] }) };
            };
            const withFindings = await reviewTwoAxes({ ...opts, fetchImpl: findingsFetch });
            assert.deepEqual(withFindings.findings.map((f) => f.file), ['a.js', 'spec.js', 'b.js']);
        });

        await check('an incremental re-review names the reviewed and current heads', () => {
            const prompt = reviewPrompt({ patch: '+fix', reviewedHead: 'abc123', head: 'def456' });
            assert.ok(prompt.includes('incremental re-review of abc123..def456'));
            assert.ok(!reviewPrompt({ patch: '+fix', reviewedHead: 'abc123' }).includes('incremental re-review'));
        });

        await check('quiet by default: only this diff, at most three, no style, and a prior ledger on a re-review', () => {
            const prompt = reviewPrompt({ patch: '+x', summary: 'add x' });
            assert.match(prompt, /only issues this change introduces/i);
            assert.match(prompt, /at most 3 findings/i);
            assert.match(prompt, /No style nits/i);
            assert.match(prompt, /empty findings list/i);
            const prior = [{ finding_id: 'a.js:it races', file: 'a.js', line: 1, text: 'it races', state: 'ACTIVE', severity: 'high' }];
            const again = reviewPrompt({ patch: '+y', prior });
            assert.match(again, /previous review of an earlier revision/i);
            assert.match(again, /a\.js:1 — it races \(id a\.js:it races\)/);
        });

        await check('findings are read from JSON findings and from the legacy numbered bullets', () => {
            const doc = readReview('{"verdict":"changes_requested","summary":"one bug","findings":[{"file":"a.js","line":2,"text":"it races","severity":"high"}]}');
            assert.deepEqual([doc.verdict, doc.findings.length, doc.findings[0].file], ['changes_requested', 1, 'a.js']);
            const prose = readReview('VERDICT: FIX\n1. a.js:2 it races with the writer');
            assert.equal(prose.findings.length, 1);
            assert.equal(prose.findings[0].line, 2);
            assert.deepEqual(readReview('{"verdict":"approved","summary":"ok","findings":[]}').findings, []);
        });

        await check('a re-review reconciles its findings and keeps a dead reviewer\'s ledger', async () => {
            const prior = [{ finding_id: 'a.js:it races', file: 'a.js', line: 1, text: 'it races', state: 'ACTIVE', severity: 'high' }];
            const approved = async () => ({ status: 200, ok: true, json: async () => ({ choices: [{ message: { content: '{"verdict":"approved","summary":"fixed","findings":[]}' } }] }) });
            const fixed = await reviewWithAi({ token: 't', model: 'deepseek-chat', patch: '+x', prior, fetchImpl: approved });
            assert.deepEqual(fixed.lifecycle, { addressed: 1, reappeared: 0, still_open: 0, new: 0 });
            assert.strictEqual(fixed.lifecycle_line, 'Findings: 1 addressed, 0 reappeared, 0 still open, 0 new');
            assert.strictEqual(fixed.findings[0].state, 'RESOLVED');
            // A reviewer that says nothing reviewed nothing: the prior ledger stays ACTIVE, not silently addressed.
            const silent = async () => ({ status: 200, ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) });
            const kept = await reviewWithAi({ token: 't', model: 'deepseek-chat', patch: '+x', prior, fetchImpl: silent });
            assert.strictEqual(kept.lifecycle, null);
            assert.strictEqual(kept.findings[0].state, 'ACTIVE');
        });

        await check('the review is one chat completion, with the token, read as a verdict', async () => {
            const calls = [];
            const fetchImpl = async (url, options) => { calls.push({ url, options }); return OK(); };
            const verdict = await reviewWithAi({
                baseUrl: 'https://ai.openvibe.services/v1', token: 'test-token', model: 'deepseek-chat',
                patch: '+x', summary: 'a change', reviewedHead: 'abc123', head: 'def456', fetchImpl,
            });
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].url, 'https://ai.openvibe.services/v1/chat/completions');
            assert.strictEqual(calls[0].options.headers.authorization, 'Bearer test-token');
            assert.strictEqual(JSON.parse(calls[0].options.body).model, 'deepseek-chat');
            assert.strictEqual(verdict.verdict, 'approved');
            assert.strictEqual(verdict.family, 'deepseek');
            assert.deepStrictEqual([verdict.reviewed_head, verdict.head], ['abc123', 'def456']);
            assert.deepEqual(verdict.findings, [], 'an approval is an empty findings list, not a "no issues" note');
        });

        await check('the review records the resolved model and cost from the API\'s disclosure', async () => {
            const fetchImpl = async () => ({
                status: 200, ok: true,
                json: async () => ({
                    choices: [{ message: { content: '{"verdict":"approved","summary":"It holds."}' } }],
                    x_openvibe: { resolved_model: 'deepseek/chat@rev2', provider_access: 'OWN_DEPLOYMENT', cost_usd: 0.0042 },
                }),
            });
            const verdict = await reviewWithAi({ token: 'test-token', model: 'deepseek-chat', patch: '+x', fetchImpl });
            assert.deepStrictEqual([verdict.model, verdict.resolved_model, verdict.requested_model], ['deepseek/chat@rev2', 'deepseek/chat@rev2', 'deepseek-chat']);
            assert.strictEqual(verdict.disclosure.provider_access, 'OWN_DEPLOYMENT');
            assert.strictEqual(verdict.cost_usd, 0.0042);
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

        await check('a refused exact id is that error, and the other dialect is not asked for it', async () => {
            const calls = [];
            const fetchImpl = async (url) => {
                calls.push(url);
                return { status: 404, ok: false, json: async () => ({ error: { message: 'no artifact acme/nope@rev0', code: 'ai.model_not_found' } }) };
            };
            await assert.rejects(() => reviewWithAi({ token: 't', model: 'acme/nope@rev0', patch: '+x', fetchImpl }), /ai\.model_not_found/);
            assert.strictEqual(calls.length, 1, 'no second request: the same refused model is not retried');
        });

        console.log('review: a model of another family, one call to OpenVibe.AI, and a verdict read from what it says');
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
    done();
})();
