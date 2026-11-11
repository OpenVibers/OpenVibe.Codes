'use strict';

/**
 * Release 2 item 5: the ask as a resumable event (agent.attention@1).
 *
 * A worker that needs a person raises one structured question instead of failing. The chain answers `attention`
 * with the session the answer resumes; the answered or dismissed record falls back to the ordinary flow. The record
 * projects to the attention.v1 contract shape with nothing Codes-only in it.
 */
const assert = require('assert');
const attention = require('../engine/attention');
const chain = require('../engine/chain');
const { check, done } = require('./helpers/boot');

const now = Date.now();
const job = (runner, name, status, at, extra = {}) => ({
    key: `${runner}:${name}`, runner, name, runnerName: runner.toUpperCase(),
    status, updated: at, error: status === 'done' ? '' : 'it broke', ...extra,
});

(async () => {
    try {
        await check('an attention is raised open, with its evidence, options and session', () => {
            const rec = attention.raise({
                ticket_id: 't-1', question: 'Ship it or fix the test first?',
                evidence: [{ kind: 'command', summary: 'the red test', command: 'ov test red.test.js' }],
                options: ['ship it', 'fix first'], session: 'sess-9',
            });
            assert.ok(rec.id.startsWith('att_'));
            assert.strictEqual(rec.state, 'open');
            assert.strictEqual(rec.session, 'sess-9');
            assert.deepStrictEqual(rec.options, ['ship it', 'fix first']);
            assert.strictEqual(rec.evidence.length, 1);
            assert.ok(!Number.isNaN(Date.parse(rec.created_at)));
            assert.strictEqual(attention.isOpen(rec), true);
            assert.strictEqual(attention.resumeSession(rec), 'sess-9');
        });

        await check('raising needs the ticket and the question', () => {
            assert.throws(() => attention.raise({ question: 'q?' }), /ticket/);
            assert.throws(() => attention.raise({ ticket_id: 't' }), /question/);
            assert.throws(() => attention.raise({ ticket_id: 't', question: '   ' }), /question/);
        });

        await check('the answer and the dismissal close the record, and only an open one moves', () => {
            const rec = attention.raise({ ticket_id: 't', question: 'Which region?' });
            const answered = attention.answer(rec, { answer: 'eu', by: 'owner' });
            assert.strictEqual(answered.state, 'answered');
            assert.strictEqual(answered.answer, 'eu');
            assert.strictEqual(attention.isOpen(answered), false);
            assert.throws(() => attention.answer(answered, { answer: 'us' }), /only an open attention/);
            const dismissed = attention.dismiss(attention.raise({ ticket_id: 't', question: 'Still want this?' }), { note: 'asked twice' });
            assert.strictEqual(dismissed.state, 'dismissed');
            assert.throws(() => attention.dismiss(dismissed), /only an open attention/);
            assert.throws(() => attention.answer(rec, { answer: '  ' }), /non-empty/);
        });

        await check('the record projects to the attention.v1 contract shape', () => {
            const rec = attention.raise({ id: 'att_1', ticket_id: 't', question: 'Go?', session: 's' });
            const doc = attention.toContract(rec);
            assert.deepStrictEqual(Object.keys(doc).sort(), ['created_at', 'id', 'question', 'state', 'ticket_id']);
            assert.deepStrictEqual(attention.isValidContract(doc), { valid: true, errors: [] });
            assert.deepStrictEqual(attention.isValidContract(attention.toContract(attention.answer(rec, { answer: 'yes' }))).valid, true);
            assert.strictEqual(attention.isValidContract({ ...doc, state: 'waiting' }).valid, false);
            assert.strictEqual(attention.isValidContract({ ...doc, question: '' }).valid, false);
            assert.strictEqual(attention.isValidContract({ ...doc, session: 's' }).valid, false, 'nothing Codes-only crosses into the contract');
        });

        await check('an open question is attention with its session, never a failure', () => {
            const rec = attention.raise({ id: 'att_7', ticket_id: 't', question: 'Ship it?', session: 'sess-9' });
            const attempts = [job('cx', 'ask', 'failed', now - 1000, { attention: rec, facts: { session: 'sess-9' } })];
            const s = chain.nextStep(attempts);
            assert.strictEqual(s.action, 'attention');
            assert.strictEqual(s.session, 'sess-9');
            assert.strictEqual(s.attention, 'att_7');
            assert.ok(s.question.includes('Ship it'));
        });

        await check('the answer resumes the same session: answered and dismissed fall back to the ordinary flow', () => {
            const cfg = { subagents: { cx: { enabled: true, max: 2 } }, fallback: { order: ['cx'] } };
            const ctx = { cfg, health: { cx: { state: 'ok' } }, counts: {}, models: {}, runners: ['cx'] };
            const rec = attention.raise({ id: 'att_8', ticket_id: 't', question: 'Ship it?' });
            const answered = [job('cx', 'ask', 'failed', now - 1000, { attention: attention.answer(rec, { answer: 'yes' }) })];
            assert.notStrictEqual(chain.nextStep(answered, ctx).action, 'attention', 'an answered question is not waited on');
            const dismissed = [job('cx', 'ask', 'failed', now - 1000, { attention: attention.dismiss(attention.raise({ ticket_id: 't', question: 'q?' })) })];
            assert.notStrictEqual(chain.nextStep(dismissed, ctx).action, 'attention', 'a dismissed question is not waited on');
        });

        await check('the open question wins over the failure handling, and carries the run session when its own is missing', () => {
            const rec = attention.raise({ ticket_id: 't', question: 'Which model?' });
            const s = chain.nextStep([job('cx', 'ask', 'failed', now - 1000, { attention: rec, facts: { session: 'sess-3' } })]);
            assert.strictEqual(s.action, 'attention');
            assert.strictEqual(s.session, 'sess-3', 'the run session carries the resume when the record names none');
        });

        console.log('attention: one structured question, answered in the same session, contracted');
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
    done();
})();
