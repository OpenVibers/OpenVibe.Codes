'use strict';
// The tier router, ported from the portal's test-router-brief.js and test-router-outcomes.js.
//
// Bug 3: the router judges a job by its launch prompt. A prompt that only says "read /…/x.brief.md and follow it" was
// routed as "a short question" to a free model, so a hard job ran on a cheap one. The router now classifies on the
// brief the prompt names (and on the job's own brief), and honours the tier line of that brief.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, done } = require('./helpers/boot');
const router = require('../engine/router');

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-router-'));
const JOBS = path.join(folder, 'jobs');
fs.mkdirSync(JOBS);

(async () => {
    try {
        const hard = 'Root cause of the race condition in the payment webhook.\n\n'.repeat(40) + '\ntier: hard\n';
        fs.writeFileSync(path.join(JOBS, 'pin-round.brief.md'), hard);
        const pointer = `Read ${path.join(JOBS, 'pin-round.brief.md')} first and follow it exactly.`;

        await check('the prompt alone is judged as it reads', () => {
            assert.equal(router.classify(pointer).tier, 'basic');
            assert.equal(router.classify(pointer).why, 'a short question');
        });

        await check('the brief a prompt names decides the tier', () => {
            const judged = router.classify(pointer, { JOBS, name: 'pin-round' });
            assert.equal(judged.tier, 'hard', 'the brief decides the tier');
            assert.equal(judged.brief, path.join(JOBS, 'pin-round.brief.md'));
        });

        await check('the tier line of the brief is honoured wherever it stands in it', () => {
            fs.writeFileSync(path.join(JOBS, 'chore.brief.md'), 'Rename a variable in one file.\n\ntier: basic\n');
            assert.equal(router.classify(`Follow ${path.join(JOBS, 'chore.brief.md')}`, { JOBS, name: 'chore' }).tier, 'basic');
        });

        await check("the job's own brief counts too, when the prompt does not name a file", () => {
            assert.equal(router.classify('Do it.', { JOBS, name: 'pin-round' }).tier, 'hard');
            assert.equal(router.classify('Do it.', { JOBS, name: 'unknown-job' }).tier, 'basic', 'a job without a brief is judged by its prompt');
        });

        await check('a prompt that names a file that is not there falls back to the prompt', () => {
            assert.equal(router.classify('Read /nowhere/jobs/missing.brief.md and follow it.', { JOBS, name: 'nothing' }).tier, 'basic');
        });

        await check('the pick follows the brief: a hard job does not go to the free runner', () => {
            const cfg = { subagents: { mm: { enabled: true, max: 2 }, cc: { enabled: false, max: 0 } } };
            const ctx = { cfg, health: { mm: { state: 'ok' } }, counts: {}, models: {}, runs: [] };
            assert.equal(router.pick(pointer, { ...ctx, JOBS, name: 'pin-round' }).runner, 'mm');
            assert.equal(router.pick(pointer, { ...ctx, JOBS, name: 'pin-round' }).tier, 'hard');
            assert.ok(router.pick(pointer, { ...ctx, JOBS, name: 'pin-round' }).why.includes('the brief it names'));
        });

        await check('the tiers are the five the product knows', () => {
            assert.deepEqual(router.TIERS, ['basic', 'research', 'standard', 'hard', 'design']);
            for (const tier of router.TIERS) assert.ok(router.LADDER[tier].length, `${tier} has a ladder`);
        });

        await check('a rescued failure does not turn into a success', () => {
            const now = Date.now();
            const run = (runner, status, extra = {}) => ({ runner, status, updated: now, ...extra });
            const runs = [
                run('mm', 'failed', { reason: 'error', resolved: { how: 'done', by: 'dsh:rescue' } }),
                run('mm', 'failed', { reason: 'error', resolved: { how: 'running', by: 'mm:retry' } }),
                run('mm', 'interrupted', { resolved: { how: 'note', note: 'Superseded' } }),
                run('mm', 'done'),
                run('dsh', 'done'),
            ];
            assert.deepEqual(router.track(runs), { mm: { done: 1, failed: 3 }, dsh: { done: 1, failed: 0 } });
            for (const reason of ['limit', 'auth', 'capacity', 'refused']) {
                assert.deepEqual(router.track([run('mm', 'failed', { reason })]), {}, reason);
            }
            assert.deepEqual(router.track([
                run('mm', 'running'), run('mm', 'queued'), run('mm', 'stopped'),
                run('mm', 'done', { updated: now - 8 * 86400e3 }),
                run('mm', 'done', { session: true }), run('ship', 'done'),
            ]), {});
        });

        await check('a runner that mostly fails is skipped, until it does better', () => {
            const now = Date.now();
            const run = (runner, status, extra = {}) => ({ runner, status, updated: now, ...extra });
            const runs = [
                run('mm', 'failed', { reason: 'error' }), run('mm', 'failed', { reason: 'error' }),
                run('mm', 'failed', { reason: 'error' }), run('mm', 'done'),
                run('dsh', 'done'),
            ];
            const context = {
                cfg: { subagents: { mm: { enabled: true, max: 2 }, dsh: { enabled: true, max: 2 } } },
                health: { mm: { state: 'ok' }, dsh: { state: 'ok' } }, counts: {}, models: {}, runs,
            };
            assert.equal(router.pick('tier: standard\nFix the parser', context).runner, 'dsh', 'rescued failures must not bypass reliability gate');
            assert.equal(router.pick('tier: standard\nFix the parser', { ...context, runs: runs.slice(0, 3) }).runner, 'mm', 'fewer than four attempts retain the existing sampling rule');
            assert.equal(router.pick('tier: standard\nFix the parser', { ...context, runs: [...runs, run('mm', 'done')] }).runner, 'mm', 'two successes in five attempts meet the existing threshold');
        });

        await check('a runner that is off, unhealthy or full is not chosen', () => {
            const cfg = { subagents: { mm: { enabled: true, max: 2 }, cx: { enabled: true, max: 2 } } };
            const off = { cfg, health: { mm: { state: 'ok' }, cx: { state: 'ok' } }, counts: {}, models: {}, runs: [] };
            assert.equal(router.pick('tier: standard\nFix the parser', { ...off, cfg: { subagents: { mm: { enabled: false, max: 2 }, cx: { enabled: true, max: 2 } } } }).runner, 'cx');
            assert.equal(router.pick('tier: standard\nFix the parser', { ...off, health: { mm: { state: 'login' }, cx: { state: 'ok' } } }).runner, 'cx');
            assert.equal(router.pick('tier: standard\nFix the parser', { ...off, counts: { cx: 2 } }).runner, 'mm');
            assert.equal(router.pick('tier: standard\nFix the parser', { ...off, cfg: { subagents: { mm: { enabled: true, max: 2 }, cx: { enabled: true, max: 2 } } }, health: { mm: { state: 'login' }, cx: { state: 'login' } } }), null);
        });
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }
    done();
})();
