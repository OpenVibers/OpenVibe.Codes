'use strict';
/** The prompt every job gets (engine/prompt.js). */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, done } = require('./helpers/boot');
const { assemble, lessons, fragment } = require('../engine/prompt');

(async () => {
    await check('the rules and the house rules are Codes\' own fragments', () => {
        const git = fragment('git-rule.md');
        assert.ok(git.includes('Git rules'));
        // 10-30: a job pushes its own branch when its brief asks for a PR. Never main, never force.
        assert.match(git, /Push only your own job branch, and only when your brief asks for a PR/);
        assert.match(git, /Never push to main, never force-push, never push someone else's branch/);
        assert.doesNotMatch(git, /git config\. Never push\./, 'the old no-push-at-all rule is gone');
        assert.ok(fragment('house-rules.md').includes('House rules'));
        assert.equal(fragment('nope.md'), '');
    });

    await check('the lessons come from the Know store, through its own recall()', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'know-'));
        const file = path.join(dir, 'lessons.js');
        fs.writeFileSync(file, `module.exports = { recall(brief, repo, k) {
            require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'seen.json'))}, JSON.stringify({ brief, repo, k }));
            return '## What earlier jobs learned here (dated)\\n- 2026-10-30 · demo — the tests need the database\\n';
        } };\n`);
        const got = lessons({ file, repo: 'demo', brief: 'fix the database test' });
        assert.ok(got.startsWith('## What earlier jobs learned here'), 'the store formats its own block');
        assert.ok(got.trimEnd().endsWith('the database'), 'and its lesson is kept');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'seen.json'), 'utf8')),
            { brief: 'fix the database test', repo: 'demo', k: 5 }, 'the store gets the brief, the repo and the cap');
        // The environment is how a Node passes the config path when the caller does not.
        assert.equal(lessons({ brief: 'x', env: { CODES_KNOW_LESSONS: file } }), got);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await check('a store that cannot be reached gives no lessons, not an error', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'know-bad-'));
        const noRecall = path.join(dir, 'no-recall.js');
        fs.writeFileSync(noRecall, 'module.exports = { search: () => "x" };\n');
        const throws = path.join(dir, 'throws.js');
        fs.writeFileSync(throws, 'module.exports = { recall: () => { throw new Error("no store"); } };\n');
        assert.equal(lessons({ file: '/nope/lessons.js', brief: 'x' }), '');
        assert.equal(lessons({ file: noRecall, brief: 'x' }), '');
        assert.equal(lessons({ file: throws, brief: 'x' }), '');
        assert.equal(lessons({ brief: 'x' }), '');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await check('the prompt is the rules, the house rules, the lessons, the digest, the brief', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-'));
        require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: dir });
        fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\n\nA demo repository.\n');
        const built = assemble({ brief: 'the brief', dir });
        assert.deepStrictEqual(built.parts.map((p) => p.name), ['git-rule', 'house-rules', 'repo-digest', 'brief']);
        assert.ok(built.text.trimEnd().endsWith('the brief'), 'the brief is last');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await check('a folder that holds many repositories gets no digest', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'many-'));
        for (const name of ['one', 'two']) {
            const sub = path.join(dir, name);
            fs.mkdirSync(sub);
            require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: sub });
        }
        const built = assemble({ brief: 'x', dir });
        assert.ok(!built.parts.some((p) => p.name === 'repo-digest'), 'no digest for a workspace');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
