'use strict';
// The persisted review ledger: stable ids, ACTIVE/RESOLVED, and the addressed/reappeared/still open/new line.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { check, done } = require('./helpers/boot');
const F = require('../engine/findings');
const { findingId } = require('../engine/finding');

const json = (findings, verdict = 'changes_requested') => JSON.stringify({ verdict, summary: 'read it', findings });

(async () => {
    await check('a JSON review yields records with the stable id, and the cap is three', () => {
        const recs = F.parse(json([
            { file: 'server/x.js', line: 31, text: 'The  cache NEVER expires', severity: 'high' },
            { file: 'server/y.js', line: 5, text: 'The retry debits twice' },
            { file: 'server/z.js', text: 'No test reaches this' },
            { file: 'server/ignored.js', text: 'Over the quiet cap' },
        ]));
        assert.equal(recs.length, 3);
        assert.equal(recs[0].finding_id, findingId('server/x.js', 'The cache never expires'));
        assert.deepEqual([recs[0].state, recs[0].severity], ['ACTIVE', 'high']);
        assert.equal(recs[2].line, null);
    });

    await check('the legacy VERDICT bullets are read too, so an older reviewer keeps its ids', () => {
        const recs = F.parse('VERDICT: FIX\n1. server/x.js:31 it races with the writer\n2. a design note\n');
        assert.equal(recs.length, 1);
        assert.equal(recs[0].file, 'server/x.js');
        assert.equal(recs[0].line, 31);
        assert.match(recs[0].text, /races/);
    });

    await check('a second review reconciles: addressed, reappeared, still open and new', () => {
        const first = F.fromReview(json([
            { file: 'a.js', line: 1, text: 'the cache never expires' },
            { file: 'b.js', line: 2, text: 'the retry debits twice' },
        ]));
        assert.deepEqual(first.lifecycle, { addressed: 0, reappeared: 0, still_open: 0, new: 2 });
        assert.equal(first.line, 'Findings: 0 addressed, 0 reappeared, 0 still open, 2 new');
        const second = F.fromReview(json([
            { file: 'a.js', line: 1, text: 'The cache never expires' },
            { file: 'c.js', line: 3, text: 'a new leak' },
        ], 'changes_requested'), first.findings);
        assert.deepEqual(second.lifecycle, { addressed: 1, reappeared: 0, still_open: 1, new: 1 });
        assert.equal(second.line, 'Findings: 1 addressed, 0 reappeared, 1 still open, 1 new');
        const cache = second.findings.find((f) => f.file === 'a.js'), retry = second.findings.find((f) => f.file === 'b.js');
        assert.equal(cache.state, 'ACTIVE');
        assert.equal(retry.state, 'RESOLVED');
    });

    await check('a resolved finding that comes back has reappeared, and an approval resolves what it no longer raises', () => {
        const one = F.fromReview(json([{ file: 'a.js', line: 1, text: 'the cache never expires' }]));
        const fixed = F.fromReview(json([], 'approved'), one.findings);
        assert.deepEqual(fixed.lifecycle, { addressed: 1, reappeared: 0, still_open: 0, new: 0 });
        assert.equal(fixed.findings[0].state, 'RESOLVED');
        const back = F.fromReview(json([{ file: 'a.js', line: 1, text: 'the cache never expires' }]), fixed.findings);
        assert.deepEqual(back.lifecycle, { addressed: 0, reappeared: 1, still_open: 0, new: 0 });
        assert.equal(back.findings[0].state, 'ACTIVE');
    });

    await check('no prior and no current findings says nothing, and the prior brief is compact', () => {
        assert.equal(F.fromReview('{"verdict":"approved","findings":[]}').line, null);
        assert.equal(F.priorBrief([]), '');
        const recs = F.fromReview(json([{ file: 'a.js', line: 1, text: 'the cache never expires' }])).findings;
        assert.match(F.priorBrief(recs), /\[ACTIVE\] a\.js:1 — the cache never expires \(id a\.js:the cache never expires\)/);
    });

    await check('the transcript schema publishes the persisted review shape', () => {
        const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'engine', 'transcript.schema.json'), 'utf8'));
        assert.deepEqual(schema.properties.review.required, ['verdict', 'findings', 'lifecycle']);
        assert.deepEqual(schema.$defs.reviewFinding.properties.state.enum, ['ACTIVE', 'RESOLVED']);
        assert.deepEqual(schema.$defs.reviewLifecycle.required, ['addressed', 'reappeared', 'still_open', 'new']);
    });
    done();
})();
