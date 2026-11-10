'use strict';
/**
 * The child return contract (server/domain/child-report.js): the parent names the report path, the child's
 * brief carries the instruction, and what the parent reads is always the path, at most 5 bullets and the
 * BLOCKED/CONCERNS lines — bounded even when the child ignored the shape.
 */
const assert = require('node:assert/strict');
const { check, done } = require('./helpers/boot');
const childReport = require('../server/domain/child-report');

(async () => {
    await check('the path defaults, and a climbing or absolute one is 422', () => {
        assert.equal(childReport.checkPath(undefined), 'report.md');
        assert.equal(childReport.checkPath(''), 'report.md');
        assert.equal(childReport.checkPath('notes/work.md'), 'notes/work.md');
        for (const bad of ['/etc/report.md', '../evil.md', 'a/../../evil.md', '..', 'a/..', 'has space.md', 'x'.repeat(201)]) {
            assert.throws(() => childReport.checkPath(bad), (e) => e.code === 'codes.report_path_invalid' && e.status === 422, bad);
        }
    });

    await check('the instruction names the path and the shape', () => {
        const text = childReport.instruction('notes/work.md');
        assert.match(text, /notes\/work\.md/);
        assert.match(text, /at most 5 lines starting with "- "/);
        assert.match(text, /BLOCKED: … or CONCERNS: …/);
    });

    await check('a shaped return: 5 bullets, the flags, the rest cut', () => {
        const r = childReport.parseReport('- one\n- two\n* three\n• four\n- five\n- six\nBLOCKED: the token\nconcerns: the flake\n', { path: 'r.md' });
        assert.equal(r.path, 'r.md');
        assert.deepEqual(r.bullets, ['one', 'two', 'three', 'four', 'five']);
        assert.equal(r.truncated, true);
        assert.deepEqual(r.blocked, ['the token']);
        assert.deepEqual(r.concerns, ['the flake']);
    });

    await check('an unshaped child still comes back bounded: its first lines are the bullets', () => {
        const r = childReport.parseReport('Did the parser.\n\nAlso the test.\nThird.\nFourth.\nFifth.\nSixth.\n', { path: 'r.md' });
        assert.deepEqual(r.bullets, ['Did the parser.', 'Also the test.', 'Third.', 'Fourth.', 'Fifth.']);
        assert.equal(r.truncated, true);
        assert.deepEqual(r.blocked, []);
        const empty = childReport.parseReport('   \n', { path: 'r.md' });
        assert.deepEqual(empty.bullets, []);
        assert.equal(empty.truncated, false);
    });

    await check('lines are cut short, and empty flags are left out', () => {
        const r = childReport.parseReport(`- ${'x'.repeat(600)}\nBLOCKED:   \nCONCERNS: ${'y'.repeat(600)}\n`, { path: 'r.md' });
        assert.equal(r.bullets[0].length, 500);
        assert.deepEqual(r.blocked, []);
        assert.equal(r.concerns[0].length, 500);
    });

    await check('of(): a conductor child with a last word, else null', () => {
        const child = { actor_ref: JSON.stringify({ conductor: { task_id: 'tsk_x', report_path: 'n.md' } }), result: { summary: '- done\nBLOCKED: none needed' } };
        const r = childReport.of(child);
        assert.equal(r.path, 'n.md');
        assert.deepEqual(r.bullets, ['done']);
        assert.deepEqual(r.blocked, ['none needed']);
        assert.equal(childReport.of({ actor_ref: null, result: { summary: '- done' } }), null, 'no parent, no report');
        assert.equal(childReport.of({ actor_ref: JSON.stringify({ conductor: { task_id: 'tsk_x' } }), result: null }), null, 'no last word yet');
        assert.equal(childReport.of({ actor_ref: JSON.stringify({ conductor: { task_id: 'tsk_x' } }), result: { summary: '  ' } }), null, 'an empty word is none');
        const plain = childReport.of({ actor_ref: { conductor: { task_id: 'tsk_x' } }, result: JSON.stringify({ summary: 'plain prose' }) });
        assert.equal(plain.path, 'report.md', 'objects and strings both read, the default path when unnamed');
        assert.deepEqual(plain.bullets, ['plain prose']);
    });

    done();
})();
