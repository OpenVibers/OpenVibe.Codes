'use strict';
/**
 * Agent Streams S3: Codes sends the finished task's report, from its proof.
 *
 *   node test/session-report.test.js
 */
const assert = require('assert');
const { buildSessionReport } = require('../server/session-report');
const { createReportClient } = require('../server/report');

const OWNER = 'usr_01JAN2C3D4E5F6G7H8J9K0MNPS';

function task(over = {}) {
    return {
        id: 'tsk_01JAN2C3D4E5F6G7H8J9K0MNPS',
        subject: OWNER,
        prompt: 'Ship the checkout page',
        started_at: '2026-11-06T18:00:00.000Z',
        finished_at: '2026-11-06T18:42:00.000Z',
        outcome: 'done',
        outcome_note: 'Done with proof',
        ...over,
    };
}

const proofItems = [
    { kind: 'tests', passed: 12, failed: 0, title: 'Run the checkout tests', at: '2026-11-06T18:20:00.000Z' },
    { kind: 'screenshots', media_ids: ['med_01JAN2C3D4E5F6G7H8J9K0MNPS'], title: 'The pages it built' },
    { kind: 'diff', summary: 'Three files changed, 120 lines added', label: 'diff' },
    { kind: 'review', verdict: 'Looks good', notes: 'The mobile layout needs a wider gutter.' },
];

(async () => {
    // The report the task's end sends.
    const report = buildSessionReport({ row: task({ pull_request: true }), proofItems, ending: { cost_usd: 0.31, model: 'claude-sonnet-4' } });
    assert.ok(report, 'the task has a report');
    assert.strictEqual(report.owner, OWNER, "the report is the person's");
    assert.strictEqual(report.source, 'codes');
    assert.strictEqual(report.task.ref, 'tsk_01JAN2C3D4E5F6G7H8J9K0MNPS', 'the task is the task it is about');
    assert.strictEqual(report.task.url, 'https://openvibe.codes/t/tsk_01JAN2C3D4E5F6G7H8J9K0MNPS');
    assert.strictEqual(report.outcome, 'done');
    assert.strictEqual(report.worked_seconds, 2520, '42 minutes of work');
    assert.strictEqual(report.cost_usd, 0.31, 'what it cost');
    assert.deepStrictEqual(report.models, ['claude-sonnet-4'], 'which models ran');
    assert.deepStrictEqual(report.proof.tests, { passed: 12, failed: 0 }, 'the tests from the proof');
    assert.deepStrictEqual(report.proof.screenshots, ['med_01JAN2C3D4E5F6G7H8J9K0MNPS'], 'the screenshots from the proof');
    assert.strictEqual(report.proof.review.verdict, 'Looks good', 'the review from the proof');
    assert.strictEqual(report.outputs.length, 2, 'what came out');
    assert.strictEqual(report.outputs[0].kind, 'file', 'the diff is the change');
    assert.strictEqual(report.outputs[1].kind, 'pr', 'a task that opened a pull request has one to point at');
    assert.strictEqual(report.timeline.length, 4, 'the steps are the proof items');
    assert.strictEqual(report.timeline[0].tests.passed, 12, 'the tests step counts them');
    assert.strictEqual(report.visibility, 'private', 'a report is private until its owner says otherwise');

    // A task that did not finish says why, in plain words.
    const stopped = buildSessionReport({ row: task({ outcome: 'unfinished', outcome_note: "Didn't finish, with what is left" }), proofItems: [] });
    assert.strictEqual(stopped.outcome, 'failed');
    assert.strictEqual(stopped.stopped_because, "Didn't finish, with what is left");

    // A task of nobody's has no report.
    assert.strictEqual(buildSessionReport({ row: task({ subject: 'x' }), proofItems: [] }), null);

    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
        calls.push({ url: String(url), opts });
        if (String(url).includes('/oauth/token')) {
            return { ok: true, status: 200, json: async () => ({ access_token: 'the-service-token' }) };
        }
        return { ok: true, status: 201, json: async () => ({ id: 'rps_01JAN2C3D4E5F6G7H8J9K0MNPS', url: 'https://openvibe.report/s/rps_01JAN2C3D4E5F6G7H8J9K0MNPS', created: true }) };
    };
    const client = createReportClient({
        config: { networkInternalUrl: 'http://127.0.0.1:4000', reportInternalUrl: 'http://127.0.0.1:5080', oauth: { clientId: 'codes', clientSecret: 'the-secret' } },
        fetchImpl,
    });
    const out = await client.send(report);
    assert.strictEqual(out.id, 'rps_01JAN2C3D4E5F6G7H8J9K0MNPS');
    const token = calls.find((c) => c.url.includes('/oauth/token'));
    assert.ok(token, 'Codes asks Network for a token');
    assert.ok(String(token.opts.body).includes("audience=openvibe.report"), "for Report's audience");
    assert.ok(String(token.opts.body).includes('scope=report.session.write'), 'with the report capability');
    const post = calls.find((c) => c.url.includes('/internal/session-reports'));
    assert.ok(post, 'Codes posts the report to Report');
    assert.strictEqual(post.opts.method, 'POST');
    assert.strictEqual(post.opts.headers.Authorization, 'Bearer the-service-token');
    const sent = JSON.parse(post.opts.body);
    assert.strictEqual(sent.proof.tests.passed, 12, 'the proof goes with it');

    console.log('  ✓ Codes sends the finished task\'s report, from its proof');
})().catch((e) => { console.error(e); process.exit(1); });
