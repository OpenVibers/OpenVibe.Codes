'use strict';
/**
 * A ticket follows its pull request (AL5): a binding is stored when a task's result pushes a PR; a failed
 * check, a conflict or a review comment on that PR wakes the same worker with the failing evidence (at most
 * 3 automatic fixes per PR); a person's "stop" ends it; a bot's comment on an ended ticket does nothing.
 *
 * The github.* envelopes below are the shape OpenVibe.Events stores for the recorded GitHub payloads in its
 * own test/fixtures/github (same fake repo and PR: OpenVibers/OpenVibe.Codes#999), delivered to /internal/events
 * signed the way Events signs (openvibe-sdk/events, the CODES_EVENTS_SECRET fixture).
 */
const assert = require('assert');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { ids } = require('openvibe-contracts');
const { parseArgs } = require('../harness/job');
const { parsePrUrl, MAX_FIXES_PER_PR, RED_CONCLUSIONS } = require('../server/domain/pr-bindings');
const { boot, check, done } = require('./helpers/boot');

const SECRET = `fixture_${'pr-follow'.repeat(4)}`;
const NOW = Date.now();
const REPO = 'https://github.com/OpenVibers/OpenVibe.Codes';
const PR_URL = 'https://github.com/OpenVibers/OpenVibe.Codes/pull/999';
const BRANCH = 'al5-scratch';
const PROJECT = 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1';

const terminalJob = () => ({
    state: 'succeeded',
    result: { ok: true, summary: 'did the thing', push: { pushed: true, branch: BRANCH, pull_request: PR_URL } },
    timings: { started_at: new Date(NOW).toISOString(), finished_at: new Date(NOW).toISOString() },
    error: null,
});

const ghEvent = (eventType, subjectId, payload) => ({
    event_id: ids.newId('event'), event_type: eventType, version: 1, source: 'github',
    actor: { type: 'service', id: 'github' }, timestamp: new Date(NOW).toISOString(),
    subject: { type: 'pr', id: subjectId }, payload,
});
const SUBJECT = 'openvibers/openvibe.codes#999';
const redCheck = () => ghEvent('github.check.completed', SUBJECT, {
    repo: 'openvibers/openvibe.codes', pr_number: 999, kind: 'check_run', conclusion: 'failure',
    check_name: 'codes-ci / tests', head_sha: 'abc123',
    html_url: 'https://github.com/OpenVibers/OpenVibe.Codes/actions/runs/111/job/222',
    details_url: 'https://github.com/OpenVibers/OpenVibe.Codes/actions/runs/111',
    output: {
        title: '1 failing test', summary: 'test/pr-bindings.test.js failed on the branch',
        text: 'not ok 3 - a red check wakes the worker once\n  AssertionError: expected 0 to equal 1\n# fail 1\n',
    },
});
const greenCheck = () => ghEvent('github.check.completed', SUBJECT, { repo: 'openvibers/openvibe.codes', pr_number: 999, kind: 'check_run', conclusion: 'success', check_name: 'codes-ci / tests', head_sha: 'abc123', html_url: 'https://github.com/OpenVibers/OpenVibe.Codes/actions/runs/112' });
const conflict = () => ghEvent('github.pr.updated', SUBJECT, { repo: 'openvibers/openvibe.codes', pr_number: 999, action: 'synchronize', merged: false, mergeable_state: 'dirty', head_sha: 'abc123', base: 'main', html_url: PR_URL });
const personComment = (body) => ghEvent('github.pr.commented', SUBJECT, { repo: 'openvibers/openvibe.codes', pr_number: 999, author: 'owner-person', author_type: 'User', state: 'commented', body, html_url: `${PR_URL}#issuecomment-1` });
const botComment = () => ghEvent('github.pr.commented', SUBJECT, { repo: 'openvibers/openvibe.codes', pr_number: 999, author: 'github-actions[bot]', author_type: 'Bot', state: 'commented', body: 'All checks have passed.', html_url: `${PR_URL}#issuecomment-2` });
const merged = () => ghEvent('github.pr.updated', SUBJECT, { repo: 'openvibers/openvibe.codes', pr_number: 999, action: 'closed', merged: true, mergeable_state: 'clean', head_sha: 'abc123', base: 'main', html_url: PR_URL });

(async () => {
    const submissions = [];
    let nextJob = 1;
    const run = {
        enabled: true,
        async submit({ subject, project, args }) {
            submissions.push({ subject, project, args });
            return { id: `job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J${nextJob++}`, state: 'queued' };
        },
        async read() { throw new Error('not used'); },
        async cancel() { return { state: 'cancelled' }; },
        async streamUrl() { throw new Error('not used'); },
    };
    const t = await boot({ run, env: { CODES_EVENTS_SECRET: SECRET, CODES_PR_FOLLOW_ENABLED: '1' } });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    const args = parseArgs(JSON.stringify({ repo: REPO, prompt: 'Fix the typo on the page', permission: 'edit', push: { pull_request: true } }));

    const deliver = async (event) => {
        const body = JSON.stringify({ event, seq: 1 });
        return await t.get('/internal/events', { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, SECRET) } });
    };
    const bindingOf = (taskId) => db.maybe('SELECT * FROM pr_bindings WHERE task_id = $1', [taskId]);
    const outbox = () => db.many('SELECT topic, subject, payload FROM codes_outbox ORDER BY created_at ASC');

    try {
        await check('a finished task that pushed a PR binds it (role fix, found on create)', async () => {
            const task = await t.ctx.tasks.start({ subject: ada.subject, project: PROJECT, args });
            const ended = await t.ctx.tasks.applyEvent(await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [task.id]), { state: 'succeeded', job: terminalJob(), timings: terminalJob().timings });
            assert.strictEqual(ended.state, 'succeeded');
            const b = await bindingOf(task.id);
            assert.ok(b, 'no binding stored');
            assert.strictEqual(b.repo, 'openvibers/openvibe.codes');
            assert.strictEqual(b.pr_number, 999);
            assert.strictEqual(b.role, 'fix');
            assert.strictEqual(b.how_found, 'created');
            assert.strictEqual(b.branch, BRANCH);
            assert.strictEqual(b.state, 'active');
            assert.strictEqual(b.fix_count, 0);
            const topics = (await outbox()).map((r) => r.topic);
            assert.ok(topics.includes('codes.pr.bound'), `no codes.pr.bound in ${topics.join(',')}`);
        });

        let parent;
        await check('a red check wakes the worker once, with the log tail and the same session, and no merge', async () => {
            parent = await db.maybe('SELECT * FROM run_tasks ORDER BY created_at DESC LIMIT 1');
            // The worker's last attempt recorded its harness session; the follow-up continues that conversation.
            await db.exec("UPDATE codes_attempts SET session = 'sess_pr_follow_1', agent = 'claude-code' WHERE task_id = $1", [parent.id]);
            const before = submissions.length;
            const r = await deliver(redCheck());
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().outcome, 'woke', r.text);
            assert.strictEqual(submissions.length, before + 1, 'the red check must start exactly one follow-up');
            const job = submissions[submissions.length - 1];
            assert.strictEqual(job.args.repo, REPO);
            assert.strictEqual(job.args.ref, BRANCH);
            assert.strictEqual(job.args.push.branch, BRANCH);
            assert.strictEqual(job.args.push.pull_request, false);
            assert.strictEqual(job.args.push.update, true);
            assert.strictEqual(job.args.agent, 'claude-code');
            assert.strictEqual(job.args.resume, 'sess_pr_follow_1');
            assert.match(job.args.prompt, /Automatic follow-up 1 of 3/);
            assert.match(job.args.prompt, /concluded "failure"/);
            assert.match(job.args.prompt, /not ok 3 - a red check wakes the worker once/);
            assert.match(job.args.prompt, /\/actions\/runs\/111/);
            assert.match(job.args.prompt, /never merge/);
            assert.ok(!/merge( |ing|d) /.test(job.args.prompt.replace('never merge', '')), 'the follow-up must not be told to merge');
            const b = await db.maybe('SELECT * FROM pr_bindings WHERE repo = $1 AND pr_number = $2 ORDER BY created_at ASC', ['openvibers/openvibe.codes', 999]);
            assert.strictEqual(b.fix_count, 1);
            assert.notStrictEqual(b.task_id, parent.id, 'the binding follows the newest task');
            const child = await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [b.task_id]);
            assert.ok(child && child.state === 'queued');
            const topics = (await outbox()).map((r) => r.topic);
            assert.ok(topics.includes('codes.pr.followup'), `no codes.pr.followup in ${topics.join(',')}`);
        });

        await check('the fourth red check does not wake (at most 3 automatic fixes per PR)', async () => {
            // Fixes 2 and 3: end each follow-up first so the fix_running guard lets the next one through.
            for (const n of [2, 3]) {
                const b = await db.maybe('SELECT * FROM pr_bindings WHERE repo = $1 AND pr_number = $2 ORDER BY created_at ASC', ['openvibers/openvibe.codes', 999]);
                await t.ctx.tasks.applyEvent(await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [b.task_id]), { state: 'succeeded', job: terminalJob(), timings: terminalJob().timings });
                const before = submissions.length;
                const r = await deliver(redCheck());
                assert.strictEqual(r.json().outcome, 'woke', r.text);
                assert.strictEqual(submissions.length, before + 1);
                const last = submissions[submissions.length - 1];
                assert.match(last.args.prompt, new RegExp(`Automatic follow-up ${n} of 3`));
            }
            const b = await db.maybe('SELECT * FROM pr_bindings WHERE repo = $1 AND pr_number = $2 ORDER BY created_at ASC', ['openvibers/openvibe.codes', 999]);
            await t.ctx.tasks.applyEvent(await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [b.task_id]), { state: 'succeeded', job: terminalJob(), timings: terminalJob().timings });
            const before = submissions.length;
            const r = await deliver(redCheck());
            assert.strictEqual(r.json().outcome, 'ignored:max_fixes', r.text);
            assert.strictEqual(submissions.length, before, 'the fourth red must not start a follow-up');

            // But a person's comment is a new instruction: it may start a manual fix past the automatic cap.
            const manual = await deliver(personComment('please fix the last failure by hand'));
            assert.strictEqual(manual.json().outcome, 'woke', manual.text);
            assert.strictEqual(submissions.length, before + 1);
            assert.match(submissions[submissions.length - 1].args.prompt, /Follow-up requested by a person/);
            const after = await db.maybe('SELECT fix_count, task_id FROM pr_bindings WHERE repo = $1 AND pr_number = $2 ORDER BY created_at ASC', ['openvibers/openvibe.codes', 999]);
            assert.strictEqual(after.fix_count, 3, 'a manual fix does not count against the automatic cap');
        });

        await check('a green check changes nothing', async () => {
            const before = submissions.length;
            const r = await deliver(greenCheck());
            assert.strictEqual(r.json().outcome, 'ignored:green', r.text);
            assert.strictEqual(submissions.length, before);
        });

        await check('a conflict wakes the fix binding with the evidence', async () => {
            // A fresh ticket on another PR, so the fix cap of #999 does not apply.
            const other = await t.ctx.tasks.start({ subject: ada.subject, project: PROJECT, args: parseArgs(JSON.stringify({ repo: REPO, prompt: 'Another typo', permission: 'edit', push: { pull_request: true } })) });
            await t.ctx.tasks.applyEvent(await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [other.id]), {
                state: 'succeeded',
                job: { ...terminalJob(), result: { ...terminalJob().result, push: { pushed: true, branch: 'al5-other', pull_request: 'https://github.com/OpenVibers/OpenVibe.Codes/pull/1000' } } },
                timings: terminalJob().timings,
            });
            const dirty = ghEvent('github.pr.updated', 'openvibers/openvibe.codes#1000', { repo: 'openvibers/openvibe.codes', pr_number: 1000, action: 'synchronize', merged: false, mergeable_state: 'dirty', head_sha: 'def456', base: 'main', html_url: 'https://github.com/OpenVibers/OpenVibe.Codes/pull/1000' });
            const before = submissions.length;
            const r = await deliver(dirty);
            assert.strictEqual(r.json().outcome, 'woke', r.text);
            assert.strictEqual(submissions.length, before + 1);
            assert.match(submissions[submissions.length - 1].args.prompt, /mergeable_state "dirty"/);
        });

        await check('a merged PR ends the binding', async () => {
            const r = await deliver(merged());
            assert.strictEqual(r.json().outcome, 'ended:merged', r.text);
            const b = await db.maybe('SELECT * FROM pr_bindings WHERE repo = $1 AND pr_number = $2 ORDER BY created_at ASC', ['openvibers/openvibe.codes', 999]);
            assert.strictEqual(b.state, 'ended');
            assert.strictEqual(b.ended_reason, 'merged');
            const topics = (await outbox()).map((r) => r.topic);
            assert.ok(topics.includes('codes.pr.ended'), `no codes.pr.ended in ${topics.join(',')}`);
        });

        await check('a bot comment on an ended ticket does nothing', async () => {
            const before = submissions.length;
            const r = await deliver(botComment());
            assert.strictEqual(r.json().outcome, 'ignored:ended', r.text);
            assert.strictEqual(submissions.length, before);
        });

        await check('a person\'s "stop" ends the binding; a person\'s comment re-opens and wakes it', async () => {
            // Re-openable ticket on PR #1000 (one fix used, cap not reached).
            const stop1000 = personComment('stop — for now, I will finish this myself');
            stop1000.subject = { type: 'pr', id: 'openvibers/openvibe.codes#1000' };
            stop1000.payload = { ...stop1000.payload, pr_number: 1000 };
            const wake1000 = personComment('actually the test still fails, please fix it');
            wake1000.subject = { type: 'pr', id: 'openvibers/openvibe.codes#1000' };
            wake1000.payload = { ...wake1000.payload, pr_number: 1000 };
            // End #1000's follow-up with a plain result (no PR: it binds nothing new) so the next wake may start.
            {
                const b = await db.maybe("SELECT * FROM pr_bindings WHERE repo = $1 AND pr_number = $2 AND state = 'active'", ['openvibers/openvibe.codes', 1000]);
                await t.ctx.tasks.applyEvent(await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [b.task_id]), {
                    state: 'succeeded',
                    job: { state: 'succeeded', result: { ok: true, summary: 'fixed the conflict' }, timings: terminalJob().timings, error: null },
                    timings: terminalJob().timings,
                });
            }
            let r = await deliver(stop1000);
            assert.strictEqual(r.json().outcome, 'stopped', r.text);
            let b = await db.maybe("SELECT * FROM pr_bindings WHERE repo = $1 AND pr_number = $2 AND state = 'active'", ['openvibers/openvibe.codes', 1000]);
            assert.strictEqual(b, null, 'stop must end the active binding');
            const before = submissions.length;
            r = await deliver(wake1000);
            assert.strictEqual(r.json().outcome, 'reopened', r.text);
            assert.strictEqual(submissions.length, before + 1, 'a person can wake an ended ticket');
            b = await db.maybe("SELECT * FROM pr_bindings WHERE repo = $1 AND pr_number = $2 AND state = 'active'", ['openvibers/openvibe.codes', 1000]);
            assert.ok(b, 'the comment re-opens the binding');
            assert.match(submissions[submissions.length - 1].args.prompt, /actually the test still fails/);
        });

        await check('with the switch off, a red check is recorded and no follow-up starts', async () => {
            const t2 = await boot({ run, env: { CODES_EVENTS_SECRET: SECRET } });
            try {
                const db2 = t2.ctx.store.db;
                const ada2 = t2.network.addUser('bob');
                const task = await t2.ctx.tasks.start({ subject: ada2.subject, project: PROJECT, args });
                await t2.ctx.tasks.applyEvent(await db2.maybe('SELECT * FROM run_tasks WHERE id = $1', [task.id]), { state: 'succeeded', job: terminalJob(), timings: terminalJob().timings });
                assert.ok(await db2.maybe('SELECT id FROM pr_bindings WHERE task_id = $1', [task.id]), 'binding is stored even with the switch off');
                const before = submissions.length;
                const body = JSON.stringify({ event: redCheck(), seq: 1 });
                const res = await t2.get('/internal/events', { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, SECRET) } });
                assert.strictEqual(res.json().outcome, 'ignored:follow_disabled', res.text);
                assert.strictEqual(submissions.length, before);
            } finally { await t2.close(); }
        });

        await check('parsePrUrl and the update guards', async () => {
            assert.deepStrictEqual(parsePrUrl(PR_URL), { repo: 'openvibers/openvibe.codes', number: 999 });
            assert.strictEqual(parsePrUrl('https://github.com/o/n/issues/1'), null);
            assert.strictEqual(parsePrUrl('not a url'), null);
            assert.deepStrictEqual([...RED_CONCLUSIONS].sort(), ['action_required', 'failure', 'timed_out']);
            assert.strictEqual(MAX_FIXES_PER_PR, 3);
            const { STOP_RE } = require('../server/domain/pr-bindings');
            assert.ok(STOP_RE.test('stop'));
            assert.ok(STOP_RE.test('Stop.'));
            assert.ok(STOP_RE.test('stop — I will take this one from here'));
            assert.ok(!STOP_RE.test('stop the flaky retry loop, it is noisy'));
            assert.throws(() => parseArgs(JSON.stringify({ repo: REPO, prompt: 'x', push: { branch: 'b', ref: undefined, pull_request: true, update: true } })), /never opens a new pull request/);
            assert.throws(() => parseArgs(JSON.stringify({ repo: REPO, ref: 'main', prompt: 'x', push: { branch: 'other', update: true } })), /branch === ref/);
            const ok = parseArgs(JSON.stringify({ repo: REPO, ref: 'b', prompt: 'x', push: { branch: 'b', update: true } }));
            assert.strictEqual(ok.push.update, true);
            assert.strictEqual(ok.push.pull_request, false);
        });

        await check('the worker never merges its own PR', async () => {
            const { pushTarget } = require('../harness/job');
            // An update push goes only to the branch it cloned; anything else is refused.
            assert.deepStrictEqual(pushTarget('b', 'b', { update: true, exists: true }), { branch: 'b' });
            assert.ok(pushTarget('b', 'b', { update: true, exists: false }).refused, 'a follow-up refuses a vanished branch');
            assert.deepStrictEqual(pushTarget('b', 'main', { exists: false }), { branch: 'b' }, 'a new branch still pushes as before');
            assert.ok(pushTarget('b', 'b', { exists: false }).refused, 'without update the old refusal stands');
            // The harness has no merge step: no git merge, no merge API call anywhere in the job path.
            const fs = require('fs');
            const jobSrc = fs.readFileSync(require('path').join(__dirname, '..', 'harness', 'job.js'), 'utf8');
            assert.ok(!/git\(\s*\['merge'/.test(jobSrc), 'no git merge in harness/job.js');
            assert.ok(!/\/merges?\b/.test(jobSrc.replace(/mergeable_state/g, '')), 'no merge API in harness/job.js');
        });

    } finally {
        await t.close();
    }
    done();
})();
