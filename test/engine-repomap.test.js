'use strict';
/** The repo digest a job gets instead of a directory tree (engine/repomap.js). */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { check, done } = require('./helpers/boot');
const { repomap, digest, repoKey, isRepo } = require('../engine/repomap');

(async () => {
    await check('a repository gets its digest: what it is, how it is laid out, its commands', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
        execFileSync('git', ['init', '-q'], { cwd: dir });
        fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\n\nA demo repository.\n');
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', description: 'a demo', scripts: { test: 'node test/run.js' } }));
        fs.mkdirSync(path.join(dir, 'src'));
        const text = digest(dir);
        assert.ok(text.includes(`# ${path.basename(dir)}`));
        assert.ok(text.includes('a demo'));
        assert.ok(text.includes('src/'));
        assert.ok(text.includes('test: node test/run.js'));
        assert.ok(isRepo(dir));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await check('a job in a repository gets that digest', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo2-'));
        execFileSync('git', ['init', '-q'], { cwd: dir });
        fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\n');
        const map = repomap(dir);
        assert.equal(map.kind, 'digest');
        assert.ok(map.text.includes('Demo'));
        assert.ok(map.repo, 'the repository has a key');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await check('a folder that holds many repositories gets nothing', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'many-'));
        for (const name of ['one', 'two']) {
            const sub = path.join(dir, name);
            fs.mkdirSync(sub);
            execFileSync('git', ['init', '-q'], { cwd: sub });
        }
        const map = repomap(dir);
        assert.equal(map.kind, 'workspace');
        assert.equal(map.text, '');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await check('a folder that is not there gets nothing', () => {
        const map = repomap('/nope/not/here');
        assert.equal(map.kind, 'none');
        assert.equal(map.text, '');
    });

    await check('a repository without a remote still has a key', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo3-'));
        execFileSync('git', ['init', '-q'], { cwd: dir });
        assert.ok(repoKey(dir).length > 0);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
