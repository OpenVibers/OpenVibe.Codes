'use strict';
// The map of OpenVibe in a coding job (2026-11-16; the owner: Codes, Actor and Computer should know "all the different
// repositories and how they're interconnected … which repositories it needs"): a task on an OpenVibe repository gets
// .openvibe/OPENVIBE.md from openvibe-contracts' system map (kept out of git) and one paragraph in its prompt pointing at
// it; another repository's task, or a machine that turned it off, gets nothing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { systemBrief, briefPrompt } = require('../harness/job');

const stub = {
    markdown: (task) => `# OpenVibe: the map for this task\n\n${task}\n`,
    reposFor: () => ({ picks: [{ name: 'OpenVibe.Shared' }, { name: 'OpenVibe.Search' }] }),
};
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-brief-'));
const work = path.join(box, 'repo');
fs.mkdirSync(work);
execFileSync('git', ['init', '-q', work]);

const job = { repo: 'https://github.com/OpenVibers/OpenVibe.Live.git', prompt: 'the menu shows a label twice' };
const brief = systemBrief(job, work, {}, stub);
assert.deepStrictEqual(brief, { rel: '.openvibe/OPENVIBE.md', picks: ['OpenVibe.Shared', 'OpenVibe.Search'] });
assert.strictEqual(fs.readFileSync(path.join(work, '.openvibe', 'OPENVIBE.md'), 'utf8'), '# OpenVibe: the map for this task\n\nthe menu shows a label twice\n');
assert.match(fs.readFileSync(path.join(work, '.git', 'info', 'exclude'), 'utf8'), /^\.openvibe\/$/m, 'kept out of git');
const said = briefPrompt(brief);
assert.match(said, /read `\.openvibe\/OPENVIBE\.md`/);
assert.match(said, /\(OpenVibe\.Shared, OpenVibe\.Search\)/);
assert.match(said, /shared library/);
assert.strictEqual(briefPrompt(null), '');

assert.ok(systemBrief({ ...job, repo: 'https://git.openvibe.codes/ada/notes.git' }, work, {}, stub), 'OpenVibe Git counts as ours');
assert.strictEqual(systemBrief({ ...job, repo: 'https://github.com/someone/else.git' }, work, {}, stub), null, 'another repository: nothing');
assert.ok(systemBrief({ ...job, repo: 'https://github.com/someone/else.git' }, work, { OPENVIBE_CODES_SYSTEM_MAP: '1' }, stub), 'unless the machine asks for it');
assert.strictEqual(systemBrief(job, work, { OPENVIBE_CODES_SYSTEM_MAP: '0' }, stub), null, 'a machine can turn it off');
assert.strictEqual(systemBrief(job, work, {}, null), null, 'an older openvibe-contracts: nothing');

// With the real map when the pinned openvibe-contracts has it (0.443.0 on).
let real = null;
try { real = require('openvibe-contracts/lib/system-map'); } catch { real = null; }
if (real) {
    const b = systemBrief(job, work, {}, real);
    assert.ok(b.picks.includes('OpenVibe.Shared'), b.picks.join(', '));
    assert.match(fs.readFileSync(path.join(work, '.openvibe', 'OPENVIBE.md'), 'utf8'), /## How it fits together/);
}
fs.rmSync(box, { recursive: true, force: true });
console.log(`system-brief: an OpenVibe task reads the map first${real ? ' (the real map)' : ' (the pinned openvibe-contracts has no map yet: the stub)'}`);
