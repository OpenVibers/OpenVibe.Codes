'use strict';

/**
 * Release 2 item 4: a fresh verifier per confirmed record, with a refute prompt.
 *
 * The reviewer raises findings; each confirmed one gets its own standalone verifier call — no history shared with
 * the review or with any other record's verification — told to refute it. A finding the verifier cannot knock down
 * stands; a refuted ledger record is dropped, a refuted finding@1 record is rejected. Verification never fails the
 * review: an unreachable verifier leaves the finding standing, out loud.
 */
const assert = require('assert');
const {
    MAX_VERIFY, verifierModels, isConfirmed, refutePrompt, readRefutal, verifyFinding, verifyConfirmed,
} = require('../engine/verifier');
const { validate } = require('../engine/finding');
const { check, done } = require('./helpers/boot');

const ledger = (file, text, severity) => ({ finding_id: `f:${file}:${text}`, file, text, severity, state: 'ACTIVE' });
const confirmed1 = (n) => ({
    verdict: 'confirmed', fingerprint: `a.js:claim ${n}`, title: `Claim ${n}`, description: `The code does wrong thing ${n}.`,
    trace: [{ file: 'a.js', line: n }], evidence: [{ kind: 'source', summary: `line ${n} shows it` }],
    severity: { likelihood: 'high', impact: 'high', overall_severity: 'high' },
    confidence: { level: 'high', reason: 'reproduced' },
});

const answer = (doc) => async () => ({ status: 200, ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(doc) } }] }) });

(async () => {
    try {
        await check('a confirmed record is a validated finding@1 confirmed or a ledger record with a severity', () => {
            assert.strictEqual(isConfirmed(confirmed1(1)), true);
            assert.strictEqual(isConfirmed(ledger('a.js', 'leak', 'high')), true);
            assert.strictEqual(isConfirmed(ledger('a.js', 'note', null)), false);
            assert.strictEqual(isConfirmed({ verdict: 'needs_validation' }), false);
            assert.strictEqual(isConfirmed({ verdict: 'rejected' }), false);
            assert.strictEqual(isConfirmed({ ...confirmed1(2), verdict: 'confirmed', severity: undefined }), false, 'an unvalidated confirmed shape is not confirmed');
            assert.strictEqual(isConfirmed(null), false);
        });

        await check('the verifier pool prefers another family than the reviewer, and never the reviewer alone', () => {
            assert.deepStrictEqual(
                verifierModels({ models: ['claude-sonnet-4', 'deepseek-chat', 'gpt-5'], reviewer: 'deepseek-chat', reviewerFamily: 'deepseek' })[0],
                'claude-sonnet-4',
            );
            assert.deepStrictEqual(
                verifierModels({ models: ['deepseek-a', 'deepseek-b'], reviewerFamily: 'deepseek' }),
                ['deepseek-a', 'deepseek-b'],
                'no other family: the pool stays whole rather than empty',
            );
            assert.deepStrictEqual(verifierModels({ models: [] }), []);
        });

        await check('the refute prompt names the finding and the diff and asks for a refutal', () => {
            const prompt = refutePrompt({ finding: ledger('a.js', 'the cache never expires', 'high'), patch: '+const cache = {};' });
            assert.ok(prompt.includes('a.js'), 'the file is in the prompt');
            assert.ok(prompt.includes('the cache never expires'), 'the claim is in the prompt');
            assert.ok(prompt.includes('+const cache = {};'), 'the diff is in the prompt');
            assert.ok(/refute/i.test(prompt), 'refuting is the instruction');
            assert.ok(prompt.includes('"stands"'), 'the answer shape is asked for');
        });

        await check('a refutal is read from JSON, and anything unclear leaves the finding standing', () => {
            assert.strictEqual(readRefutal('{"stands":false,"reason":"line 3 resets it","counter":"a.js:3"}').stands, false);
            assert.strictEqual(readRefutal('{"stands":true,"reason":"reproduced"}').stands, true);
            assert.strictEqual(readRefutal('').stands, true);
            assert.strictEqual(readRefutal('some words without a verdict').stands, true);
            assert.strictEqual(readRefutal('The claim is refuted: line 3 resets the cache.').stands, false);
        });

        await check('one verification is one fresh call: no history, one message, the task token', async () => {
            const calls = [];
            const fetchImpl = async (url, options) => {
                calls.push({ url, options });
                return answer({ stands: true, reason: 'reproduced against the diff' })();
            };
            const v = await verifyFinding({
                baseUrl: 'https://ai.example/v1', token: 'task-token', model: 'deepseek-chat',
                finding: ledger('a.js', 'the cache never expires', 'high'), patch: '+x', fetchImpl,
            });
            assert.strictEqual(calls.length, 1);
            const body = JSON.parse(calls[0].options.body);
            assert.strictEqual(body.messages.length, 1, 'fresh: no conversation history');
            assert.strictEqual(calls[0].options.headers.authorization, 'Bearer task-token');
            assert.strictEqual(v.stands, true);
            assert.strictEqual(v.model, 'deepseek-chat');
            assert.strictEqual(v.family, 'deepseek');
        });

        await check('verified findings stand with their verification; a refuted ledger record is dropped', async () => {
            const findings = [ledger('a.js', 'first claim', 'high'), ledger('b.js', 'second claim', 'medium'), ledger('c.js', 'a note', null)];
            const fetchImpl = async (_url, options) => {
                const prompt = JSON.parse(options.body).messages[0].content;
                const down = prompt.includes('second claim');
                return answer(down ? { stands: false, reason: 'b.js:9 guards it', counter: 'b.js:9' } : { stands: true, reason: 'reproduced' })();
            };
            const prompts = [];
            const watching = async (url, options) => { prompts.push(JSON.parse(options.body).model); return fetchImpl(url, options); };
            const out = await verifyConfirmed({
                token: 't', models: ['claude-sonnet-4', 'deepseek-chat'], reviewer: 'deepseek-chat', reviewerFamily: 'deepseek',
                findings, patch: '+x', fetchImpl: watching,
            });
            assert.deepStrictEqual(prompts, ['claude-sonnet-4', 'claude-sonnet-4'], 'the reviewer family is not the verifier');
            assert.strictEqual(out.findings.length, 2, 'the refuted record is gone, the note stays');
            assert.ok(out.findings[0].verification && out.findings[0].verification.model === 'claude-sonnet-4');
            assert.strictEqual(out.verifications.length, 2);
            assert.strictEqual(out.verifications.filter((v) => !v.stands).length, 1);
            assert.strictEqual(out.line, 'Verified: 1 stand, 1 refuted');
        });

        await check('each record gets its own verifier while the pool lasts', async () => {
            const seen = [];
            const fetchImpl = async (_url, options) => {
                seen.push(JSON.parse(options.body).model);
                return answer({ stands: true, reason: 'holds' })();
            };
            const findings = [ledger('a.js', 'one', 'high'), ledger('b.js', 'two', 'high')];
            await verifyConfirmed({
                token: 't', models: ['claude-sonnet-4', 'gpt-5'], reviewerFamily: 'deepseek',
                findings, patch: '+x', fetchImpl,
            });
            assert.deepStrictEqual(seen, ['claude-sonnet-4', 'gpt-5'], 'rotation: one fresh verifier per record');
        });

        await check('a refuted finding@1 record is rejected and still validates', async () => {
            const out = await verifyConfirmed({
                token: 't', models: ['deepseek-chat'], reviewerFamily: 'anthropic',
                findings: [confirmed1(7)], patch: '+x',
                fetchImpl: answer({ stands: false, reason: 'the guard was added', counter: 'a.js:7' }),
            });
            assert.strictEqual(out.findings.length, 1);
            assert.strictEqual(out.findings[0].verdict, 'rejected');
            assert.strictEqual(validate(out.findings[0]).valid, true, 'the rejected record holds the finding@1 shape');
            assert.strictEqual(out.line, 'Verified: 0 stand, 1 refuted');
        });

        await check('verification is bounded, honest about the cap, and never fails the review', async () => {
            let calls = 0;
            const fetchImpl = async () => { calls++; return answer({ stands: true, reason: 'holds' })(); };
            const many = [1, 2, 3, 4].map((n) => ledger('a.js', `claim ${n}`, 'high'));
            const out = await verifyConfirmed({ token: 't', models: ['deepseek-chat'], findings: many, patch: '+x', fetchImpl });
            assert.strictEqual(calls, MAX_VERIFY, `at most ${MAX_VERIFY} verifier calls`);
            assert.ok(out.line.includes('1 not verified'), 'the cap is said out loud: ' + out.line);
            assert.strictEqual(out.findings.length, 4, 'nothing past the cap is dropped');
            const unreachable = await verifyConfirmed({
                token: 't', models: ['deepseek-chat'], findings: [ledger('a.js', 'claim', 'high')], patch: '+x',
                fetchImpl: async () => { throw new Error('no route'); },
            });
            assert.strictEqual(unreachable.findings.length, 1, 'an unreachable verifier leaves the finding standing');
            assert.ok(unreachable.verifications[0].reason.includes('could not be reached'));
            const empty = await verifyConfirmed({ token: 't', models: [], findings: [ledger('a.js', 'claim', 'high')], patch: '+x', fetchImpl });
            assert.strictEqual(empty.verifications.length, 0, 'no verifier, no calls');
            assert.strictEqual(empty.line, null);
            assert.strictEqual(empty.findings.length, 1);
        });

        console.log('verifier: a fresh refute-first check per confirmed record, bounded and never failing the review');
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
    done();
})();
