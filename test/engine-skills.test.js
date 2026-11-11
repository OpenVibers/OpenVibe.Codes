'use strict';
// The skill loader: metadata always, the body only when the task matches, references and scripts on demand.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, done } = require('./helpers/boot');
const skills = require('../engine/skills');
const { agentPrompt, parseArgs } = require('../harness/job');

const tmp = [];
function checkout() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-skills-'));
    tmp.push(dir);
    return dir;
}

/** Write one skill folder under a root, with optional extra files. */
function put(root, name, body, meta = {}, files = {}, at = '.openvibe/skills') {
    const dir = path.join(root, at, name);
    fs.mkdirSync(dir, { recursive: true });
    const head = [`name: ${name}`, ...Object.entries(meta).map(([k, v]) => `${k}: ${v}`)];
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${head.join('\n')}\n---\n\n${body}\n`);
    for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), text);
    }
    return dir;
}

(async () => {
    await check('frontmatter names the skill and its body stays out of the metadata', () => {
        const parsed = skills.parse('---\nname: ship-it\ndescription: Merge and deploy\ninvocation: model\n---\n\n# Ship\nRun the tests.');
        assert.equal(parsed.meta.name, 'ship-it');
        assert.equal(parsed.meta.description, 'Merge and deploy');
        assert.equal(parsed.meta.invocation, 'model');
        assert.match(parsed.body, /Run the tests/);
        assert.deepEqual(parsed.errors, []);
        const broken = skills.parse('name: no-fence\n');
        assert.match(broken.errors.join('; '), /must start with a --- frontmatter/);
        assert.match(skills.parse('---\nname: x\n').errors.join('; '), /no closing ---/);
    });

    await check('index finds every conventional root and leaves a broken skill out', () => {
        const dir = checkout();
        put(dir, 'ship-it', '# Ship\nRun the tests, then merge.', { description: 'Merge a green PR' });
        put(dir, 'review-it', '# Review\nRead the diff.', { description: 'Review a change', invocation: 'user' }, {}, '.claude/skills');
        put(dir, 'broken', '# Broken', { description: 'Has a missing pointer', references: 'references/gone.md' });
        const idx = skills.index(dir);
        assert.deepEqual(idx.skills.map((s) => s.name).sort(), ['review-it', 'ship-it']);
        assert.equal(idx.errors.length, 1);
        assert.match(idx.errors[0].errors.join('; '), /references\/gone\.md is missing/);
        assert.equal(skills.index(checkout()).skills.length, 0, 'a repository without skills is normal');
    });

    await check('validate holds the 500-line body, the folder name and the pointer inside it', () => {
        const dir = checkout();
        put(dir, 'long-one', Array.from({ length: 501 }, (_, i) => `line ${i}`).join('\n'), { description: 'Too long' });
        put(dir, 'escaping', '# Escape', { description: 'A pointer out', references: '../outside.md' }, { '../outside.md': 'x' });
        const idx = skills.index(dir);
        const byName = Object.fromEntries(idx.errors.map((e) => [e.name, e.errors.join('; ')]));
        assert.match(byName['long-one'], /body is \d+ lines; the limit is 500/);
        assert.match(byName.escaping, /leaves the skill folder/);
        const good = put(dir, 'small', '# Small\nSee references/traps.md.', { description: 'Small', references: 'references/traps.md' }, { 'references/traps.md': 'the traps' });
        const got = skills.read(good).skill;
        assert.equal(got.valid, true);
        assert.equal(got.files.find((f) => f.name === 'references/traps.md').exists, true);
    });

    await check('brief always lists metadata and loads a body only when the task matches', () => {
        const dir = checkout();
        put(dir, 'ship-it', '# Ship\nRun the tests then merge.', { description: 'Merge a green PR', when_to_use: 'ship, deploy' });
        put(dir, 'notes', '# Notes\nThe owner prefers small PRs.', { description: 'Owner notes' });
        const idx = skills.index(dir, { roots: [] });
        const quiet = skills.brief(idx.skills, { prompt: 'Add a parser and its tests', root: dir });
        assert.match(quiet.block, /ship-it \(model\): Merge a green PR/);
        assert.match(quiet.block, /body: \.openvibe\/skills\/ship-it\/SKILL.md/);
        assert.ok(!quiet.block.includes('Run the tests then merge'), 'an unrelated task does not get the procedure');
        assert.deepEqual(quiet.loaded, []);
        const hitting = skills.brief(idx.skills, { prompt: 'ship this change', root: dir });
        assert.deepEqual(hitting.loaded, ['ship-it']);
        assert.match(hitting.block, /### ship-it[\s\S]*Run the tests then merge/);
        assert.match(hitting.block, /Skills in this repository/);
    });

    await check('a user-invoked skill waits for its name; a model one matches its when-to-use words', () => {
        const dir = checkout();
        put(dir, 'review-it', '# Review\nRead the diff before approving.', { description: 'Review a change', invocation: 'user', when_to_use: 'review, check my work' });
        put(dir, 'deploy-it', '# Deploy\nRun the deploy script.', { description: 'Deploy', when_to_use: 'deploy' });
        const idx = skills.index(dir);
        const phrase = skills.brief(idx.skills, { prompt: 'review my work please', root: dir });
        assert.deepEqual(phrase.loaded, []);
        assert.ok(!phrase.block.includes('Read the diff before approving'));
        const named = skills.brief(idx.skills, { prompt: 'use review-it on this branch', root: dir });
        assert.deepEqual(named.loaded, ['review-it']);
        assert.match(named.block, /Read the diff before approving/);
        const model = skills.brief(idx.skills, { prompt: 'deploy the service', root: dir });
        assert.deepEqual(model.loaded, ['deploy-it']);
    });

    await check('at most three bodies are loaded and references are named, never pasted', () => {
        const dir = checkout();
        for (let i = 0; i < 5; i++) {
            put(dir, `skill-${i}`, `# Skill ${i}\nThe procedure ${i}.`, { description: `Skill ${i}`, when_to_use: 'do the thing' });
        }
        put(dir, 'with-files', '# Files\nRead references/traps.md.', { description: 'Files', when_to_use: 'do the thing' }, { 'references/traps.md': 'SECRET TRAP TEXT' });
        const idx = skills.index(dir);
        const got = skills.brief(idx.skills, { prompt: 'do the thing', root: dir });
        assert.equal(got.loaded.length, 3);
        assert.equal(got.skipped.length, 3);
        const withFiles = skills.brief(idx.skills, { prompt: 'with-files', root: dir });
        assert.deepEqual(withFiles.loaded, ['with-files']);
        assert.match(withFiles.block, /references\/traps\.md/);
        assert.ok(!withFiles.block.includes('SECRET TRAP TEXT'), 'a reference is a file the agent opens itself');
    });

    await check('the body and one reference are readable on demand, and only from a valid skill', () => {
        const dir = checkout();
        const at = put(dir, 'ship-it', '# Ship\nRead references/traps.md first.', { description: 'Ship', references: 'references/traps.md' }, { 'references/traps.md': 'always gitleaks first' });
        const skill = skills.read(at).skill;
        assert.match(skills.load(skill), /Read references\/traps\.md first/);
        assert.match(skills.readReference(skill, 'references/traps.md'), /gitleaks/);
        assert.equal(skills.readReference(skill, 'references/nope.md'), null);
        assert.equal(skills.load({ ...skill, valid: false }), null);
    });

    await check('the harness prompt carries the skills block only when the job asks for it', () => {
        const dir = checkout();
        put(dir, 'ship-it', '# Ship\nRun the tests then merge.', { description: 'Merge a green PR', when_to_use: 'ship' });
        const on = agentPrompt({ kind: 'code', prompt: 'ship this change', skills: true }, dir);
        assert.match(on, /## Skills in this repository/);
        assert.match(on, /### ship-it[\s\S]*Run the tests then merge/);
        const off = agentPrompt({ kind: 'code', prompt: 'ship this change' }, dir);
        assert.ok(!off.includes('## Skills in this repository'), 'the prompt is unchanged unless a job asks');
        const repo = 'https://github.com/Owner/Repo';
        assert.equal(parseArgs(JSON.stringify({ repo, prompt: 'x', skills: true }), {}).skills, true);
        assert.equal(parseArgs(JSON.stringify({ repo, prompt: 'x' }), {}).skills, undefined);
        assert.equal(parseArgs(JSON.stringify({ repo, prompt: 'x' }), { CODES_SKILLS_LOADER: '1' }).skills, true);
    });

    for (const dir of tmp) fs.rmSync(dir, { recursive: true, force: true });
    await done();
})().catch((err) => { for (const dir of tmp) fs.rmSync(dir, { recursive: true, force: true }); done(err); });
