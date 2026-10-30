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
        assert.ok(fragment('git-rule.md').includes('Git rules'));
        assert.ok(fragment('house-rules.md').includes('House rules'));
        assert.equal(fragment('nope.md'), '');
    });

    await check('the lessons are the ones that fit, at most five', () => {
        const file = path.join(os.tmpdir(), `lessons-${process.pid}.jsonl`);
        const rows = [];
        for (let i = 0; i < 8; i++) rows.push(JSON.stringify({ text: `lesson ${i} about the database`, repo: 'demo', tags: ['database'] }));
        rows.push(JSON.stringify({ text: 'unrelated note' }));
        fs.writeFileSync(file, rows.join('\n') + '\n');
        const got = lessons({ file, repo: 'demo', brief: 'fix the database test' });
        assert.ok(got.includes('What earlier jobs learned here'));
        assert.ok(!got.includes('unrelated note'), 'a lesson that does not fit is left out');
        assert.ok((got.match(/^- /gm) || []).length <= 5);
        fs.rmSync(file, { force: true });
    });

    await check('a store that cannot be reached gives no lessons, not an error', () => {
        assert.equal(lessons({ file: '/nope/lessons.jsonl', brief: 'x' }), '');
        assert.equal(lessons({ brief: 'x' }), '');
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
