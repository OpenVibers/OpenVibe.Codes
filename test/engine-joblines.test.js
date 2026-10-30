'use strict';
/** The job lines (1.1): what a task's page shows while it runs (engine/joblines.js). */

const assert = require('node:assert/strict');
const { check, done } = require('./helpers/boot');
const { lines, usageLine, clip } = require('../engine/joblines');
const fake = require('./helpers/fakesecrets');

(async () => {
    await check('the transcript\'s events become the lines a reader sees', () => {
        const st = {
            events: [
                { t: 'meta', kind: 'start', backend: 'codex', model: 'gpt', session: 'th-1' },
                { t: 'text', text: 'hello' },
                { t: 'thinking', text: 'hmm' },
                { t: 'tool', id: 'u1', name: 'Bash', summary: 'ls', output: { text: 'a.js' } },
                { t: 'error', text: 'it broke' },
                { t: 'final', text: 'done' },
            ],
            usage: { input: 10, output: 5, cached: 2 },
            cost: 0.02,
        };
        const out = lines(st);
        assert.deepStrictEqual(out.lines.map((l) => l.t), ['agent', 'text', 'tool', 'tool_result', 'note', 'done']);
        assert.equal(out.lines[0].agent, 'codex');
        assert.equal(out.lines[0].session, 'th-1');
        assert.equal(out.lines[2].name, 'Bash');
        assert.equal(out.lines[3].text, 'a.js');
        assert.equal(out.lines[5].ok, true);
        assert.ok(!out.lines.some((l) => l.t === 'note' && l.level !== 'error'));
    });

    await check('the lines come once, from where the last read stopped', () => {
        const st = { events: [{ t: 'text', text: 'a' }, { t: 'text', text: 'b' }] };
        assert.equal(lines(st, 0).lines.length, 2);
        assert.equal(lines(st, 1).lines.length, 1);
        assert.equal(lines(st, 2).lines.length, 0);
    });

    await check('a secret in an event never reaches a line', () => {
        const out = lines({ events: [{ t: 'text', text: `token ${fake.githubToken()}` }] });
        assert.ok(!JSON.stringify(out).includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'));
    });

    await check('the usage line says what the run spent, or nothing at all', () => {
        assert.deepStrictEqual(usageLine({ usage: { input: 1, output: 2, cached: 3 }, cost: 0.5 }), { t: 'usage', input: 1, output: 2, cached: 3, cost_usd: 0.5 });
        assert.equal(usageLine({ usage: {} }), null);
    });

    await check('a long text is clipped', () => {
        assert.equal(clip('x'.repeat(3000)).length, 2001);
        assert.equal(clip('short'), 'short');
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
