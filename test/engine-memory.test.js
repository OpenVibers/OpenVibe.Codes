'use strict';

/**
 * Release 2 item 8 (Codes slice): the small memory index.
 *
 * MEMORY.md is always loaded; memory/<topic>.md files are loaded by search — the brief's words pick them, most
 * overlap first, at most MAX_TOPICS. Everything is capped, and a folder with no memory gives nothing, never an
 * error. The assembled prompt carries the block as its memory part.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const memory = require('../engine/memory');
const { assemble } = require('../engine/prompt');
const { check, done } = require('./helpers/boot');

const mem = (dir) => {
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Index\nAlways remember the deploy freeze on Fridays.\n');
    fs.mkdirSync(path.join(dir, 'memory'));
    fs.writeFileSync(path.join(dir, 'memory', 'deploy.md'), '# Deploy\nThe deploy freeze runs Friday UTC. Release trains ship Thursdays.\n');
    fs.writeFileSync(path.join(dir, 'memory', 'tipping.md'), '# Tipping\nTips settle in Billing on Mondays.\n');
    fs.writeFileSync(path.join(dir, 'memory', 'unrelated.md'), '# Gardening\nRoses need pruning in March.\n');
};

(async () => {
    try {
        await check('the index is always loaded and capped', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-idx-'));
            mem(dir);
            const b = memory.block({ dir, brief: 'something else entirely' });
            assert.ok(b.text.includes('deploy freeze'), 'the index rides along whatever the brief');
            assert.strictEqual(b.topics.length, 0, 'no topic matches, none is loaded');
            fs.writeFileSync(path.join(dir, 'MEMORY.md'), 'x'.repeat(9000));
            assert.ok(memory.indexOf(dir).length <= memory.INDEX_CHARS, 'the index is capped');
            fs.rmSync(dir, { recursive: true, force: true });
        });

        await check('topics load by search, most overlap first, at most two', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-top-'));
            mem(dir);
            const found = memory.search(dir, 'when is the deploy freeze and do release trains ship?');
            assert.deepStrictEqual(found.map((t) => t.topic), ['deploy'], 'only the matching topic loads');
            const both = memory.search(dir, 'deploy freeze tips settle billing monday');
            assert.deepStrictEqual(both.map((t) => t.topic), ['tipping', 'deploy'], 'most overlap first');
            assert.deepStrictEqual(memory.search(dir, 'roses pruning')[0].topic, 'unrelated');
            assert.deepStrictEqual(memory.search(dir, 'quantum entanglement'), [], 'nothing matching, nothing loaded');
            fs.rmSync(dir, { recursive: true, force: true });
        });

        await check('no memory is nothing, never an error', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-none-'));
            assert.strictEqual(memory.indexOf(dir), '');
            assert.deepStrictEqual(memory.topics(dir), []);
            assert.deepStrictEqual(memory.search(dir, 'deploy'), []);
            assert.strictEqual(memory.block({ dir, brief: 'deploy' }).text, '');
            assert.strictEqual(memory.block({}).text, '');
            fs.rmSync(dir, { recursive: true, force: true });
        });

        await check('the assembled prompt carries the memory between the lessons and the digest', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-asm-'));
            require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: dir });
            fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\n');
            mem(dir);
            const built = assemble({ brief: 'when is the deploy freeze?', dir });
            const names = built.parts.map((p) => p.name);
            assert.deepStrictEqual(names, ['git-rule', 'house-rules', 'memory', 'repo-digest', 'brief']);
            const part = built.parts.find((p) => p.name === 'memory');
            assert.ok(part.text.includes('deploy freeze'), 'the index is in the prompt');
            assert.ok(part.text.includes('Release trains ship Thursdays'), 'the matching topic is in the prompt');
            assert.ok(!part.text.includes('Roses need pruning'), 'the unmatching topic stays out');
            assert.strictEqual(part.layer, 'role');
            const bare = assemble({ brief: 'x', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'mem-bare-')) });
            assert.ok(!bare.parts.some((p) => p.name === 'memory'), 'no memory files, no part');
            fs.rmSync(dir, { recursive: true, force: true });
        });

        console.log('memory: the index always, the topics the brief points at, capped');
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
    done();
})();
