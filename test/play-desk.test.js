'use strict';
/**
 * Agent Streams S6 — the chat plays desk (server/domain/play-desk.js).
 *
 * The desk runs with --shared: no profile, no keys, no person's files, public egress only (no private
 * address is reachable), and a fresh workspace that is wiped at the end. The owner's time box, the step
 * budget and the cap stop a run; Wipe now resets it; the first request waits for the owner's Go.
 *
 * The injection test: the desk has no environment worth printing and no route to post anywhere.
 */
const assert = require('assert');
const desk = require('../server/domain/play-desk');

const T = (label, fn) => {
    try {
        fn();
        process.stdout.write('  ✓ ' + label + '\n');
    } catch (err) {
        process.stdout.write('  ✗ ' + label + '\n' + (err && err.stack || err) + '\n');
        failed++;
    }
};
let failed = 0;

T('the desk has no profile, no keys and no personal files', () => {
    const d = desk.sharedDesk();
    assert.strictEqual(d.shared, true);
    assert.strictEqual(d.profile, false);
    assert.strictEqual(d.keys, false);
    assert.strictEqual(d.personal_files, false);
    assert.strictEqual(d.egress, 'public-only');
    assert.strictEqual(d.may_run_outside, false, 'nothing runs outside the sandbox');
    assert.strictEqual(d.may_email, false);
    assert.strictEqual(d.may_post, false);
    assert.strictEqual(d.may_sign_up, false);
});

T('no private address is reachable', () => {
    for (const host of ['10.0.0.5', '192.168.1.1', '172.16.0.1', '127.0.0.1', '169.254.169.254', '0.0.0.0',
        '[::1]', '[fd00::1]', '[fe80::1]']) {
        const r = desk.egressAllowed('http://' + host + '/x');
        assert.strictEqual(r.ok, false, host + ' is not reachable');
        assert.strictEqual(r.code, 'egress.private_address', host + ' is private');
    }
    for (const host of ['localhost', 'metadata.google.internal', 'box.local', 'service.internal']) {
        assert.strictEqual(desk.egressAllowed('https://' + host + '/x').ok, false, host + ' is not reachable');
    }
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)']) {
        assert.strictEqual(desk.egressAllowed(url).ok, false, url + ' is not allowed');
    }
    assert.strictEqual(desk.egressAllowed('https://example.com/page').ok, true, 'the public web is allowed');
});

T('a download is never run outside the sandbox', () => {
    const plan = desk.downloadPlan('https://example.com/tool.sh');
    assert.strictEqual(plan.ok, true);
    assert.strictEqual(plan.run, false, 'it is fetched into the workspace and never started');
    assert.strictEqual(plan.execute, false);
    assert.strictEqual(plan.keep, 'inside-the-sandbox');
    assert.strictEqual(desk.downloadPlan('http://127.0.0.1/tool.sh').ok, false, 'not even from a private address');
});

T('the workspace starts empty and is wiped at the end', () => {
    const s = desk.createSession({ task: { id: 'tsk_1', title: 'Chat plays' }, owner: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' });
    assert.deepStrictEqual(s.workspace.files, [], 'the workspace is empty at the start');
    assert.strictEqual(s.egress_public_only, true);
    s.workspace.files.push('/workspace/snake.js');
    desk.end(s);
    assert.deepStrictEqual(s.workspace.files, [], 'the workspace is empty at the end');
    assert.strictEqual(s.workspace.wiped, true);
});

T('the first request waits for the owner\'s Go', () => {
    const s = desk.createSession({ task: { id: 'tsk_1' }, owner: 'usr_1' });
    assert.strictEqual(s.armed, false);
    const before = desk.mayRun(s);
    assert.strictEqual(before.ok, false);
    assert.strictEqual(before.code, 'desk.not_armed');
    desk.arm(s);
    assert.strictEqual(s.armed, true);
    assert.strictEqual(desk.mayRun(s).ok, true, 'after Go the request may run');
});

T('the time box stops the run', () => {
    const s = desk.createSession({ task: { id: 'tsk_1' }, owner: 'usr_1', time_box_minutes: 5 });
    assert.strictEqual(s.time_box_minutes, 5);
    desk.arm(s);
    const start = Date.now();
    desk.begin(s, { now: start });
    const over = desk.spend(s, { seconds: 5 * 60 + 1, now: start + 5 * 60 * 1000 + 1000 });
    assert.strictEqual(over.ok, false);
    assert.strictEqual(over.code, 'desk.time_box');
    assert.strictEqual(s.state, 'ended');
});

T('the cap stops the run', () => {
    const s = desk.createSession({ task: { id: 'tsk_1' }, owner: 'usr_1', cap: { money_cents: 100, minutes: 10 } });
    desk.arm(s);
    desk.begin(s);
    const over = desk.spend(s, { money_cents: 120 });
    assert.strictEqual(over.ok, false);
    assert.strictEqual(over.code, 'desk.budget_spent');
    assert.ok(/budget/i.test(over.line), 'the stream says the budget is spent');
    assert.strictEqual(s.state, 'ended');
});

T('the step budget stops the run', () => {
    const s = desk.createSession({ task: { id: 'tsk_1' }, owner: 'usr_1', step_budget: 2 });
    desk.arm(s);
    desk.begin(s);
    assert.strictEqual(desk.spend(s, { steps: 1 }).ok, true);
    const over = desk.spend(s, { steps: 2 });
    assert.strictEqual(over.ok, false);
    assert.strictEqual(over.code, 'desk.step_budget');
});

T('Wipe now resets the sandbox', () => {
    const s = desk.createSession({ task: { id: 'tsk_1' }, owner: 'usr_1' });
    desk.arm(s);
    desk.begin(s);
    s.workspace.files.push('/workspace/secret.txt');
    desk.scratchSite(s, { url: 'https://scratch.openvibe.space/x' });
    const out = desk.wipe(s);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(s.state, 'wiped');
    assert.deepStrictEqual(s.workspace.files, [], 'the sandbox is empty again');
    assert.strictEqual(s.scratch_site, null, 'the scratch site is gone');
    assert.strictEqual(desk.mayRun(s).ok, false, 'the session is over');
});

T('the scratch site lives 24 hours unless it is kept', () => {
    const s = desk.createSession({ task: { id: 'tsk_1' }, owner: 'usr_1' });
    const now = Date.now();
    const site = desk.scratchSite(s, { url: 'https://scratch.openvibe.space/x', now });
    assert.strictEqual(site.ok, true);
    assert.strictEqual(site.scratch_site.no_login, true, 'no login');
    assert.strictEqual(site.scratch_site.no_forms, true, 'no form that collects anything');
    assert.strictEqual(Date.parse(site.scratch_site.expires_at) - now, 24 * 60 * 60 * 1000);
    assert.strictEqual(desk.scratchExpired(site.scratch_site, { now: now + 1000 }), false);
    assert.strictEqual(desk.scratchExpired(site.scratch_site, { now: now + 24 * 60 * 60 * 1000 + 1 }), true);
    const kept = desk.scratchSite(s, { url: 'https://scratch.openvibe.space/x', kept: true, now });
    assert.strictEqual(desk.scratchExpired(kept.scratch_site, { now: now + 48 * 60 * 60 * 1000 }), false, 'a kept site stays');
});

T('the injection test: no environment worth printing, no route to post', () => {
    const s = desk.createSession({ task: { id: 'tsk_1' }, owner: 'usr_1' });
    const d = s.desk;
    assert.strictEqual(d.keys, false, 'there is no key to print');
    assert.strictEqual(d.profile, false, 'there is no profile to print');
    // There is no route to post: the desk may not post, and the paste sites are not the public web it may post to.
    assert.strictEqual(d.may_post, false);
    assert.strictEqual(desk.egressAllowed('https://pastebin.com/api/api_post.php').ok, true,
        'the guard is about addresses, not about a list of sites');
    assert.strictEqual(d.may_post, false, 'and the desk may never post anyway');
    // The environment a step sees is the sandbox's own: no keys, no profile, no home directory.
    assert.deepStrictEqual(Object.keys(s.workspace).sort(), ['files', 'path', 'wiped']);
});

process.stdout.write(failed ? 'play-desk: FAILED\n' : 'play-desk: all checks passed\n');
process.exit(failed ? 1 : 0);
