'use strict';
// The chain of one task, ported from the portal's test-chain-end.js: a failed job's line followed one hop, and a
// step-limit stop with nothing after it was never attention. The chain is followed to the run that ended it: through
// retry links, through a session that carried a run on (its parent), and through what resolved the next hop.
//
// The portal read those links from marker files in its log folder; the engine is pure, so the links come in with the
// attempts.

const assert = require('node:assert/strict');
const { check, done } = require('./helpers/boot');
const chain = require('../engine/chain');

const now = Date.now();
const job = (runner, name, status, at, extra = {}) => ({
    key: `${runner}:${name}`, runner, name, runnerName: runner.toUpperCase(),
    status, updated: at, error: status === 'done' ? '' : 'it broke', ...extra,
});
const carried = (parent, name, at) => ({
    key: `cd:${name}`, runner: 'mm', harness: 'mm', parent, runnerName: 'MiniMax Code',
    name: `↻ ${name}`, status: 'done', updated: at, error: '', session: true,
});

(async () => {
    await check('a chain is followed through its retries and the sessions that carried it on', () => {
        const attempts = [
            // a: crashed, its retry stopped at the step limit, and a session carried that retry on to the end.
            job('cc', 'a', 'failed', now - 9000, { next: 'mm:a-r2' }),
            job('mm', 'a-r2', 'budget-stopped', now - 5000),
            carried('mm:a-r2', 'a-r2', now - 1000),
            // b: crashed, its retry stopped at the step limit, and nothing carried it on.
            job('cx', 'b', 'failed', now - 9000, { next: 'mm:b-r2' }),
            job('mm', 'b-r2', 'budget-stopped', now - 5000),
            // c: the same as b, but the owner marked the stop handled.
            job('cc', 'c', 'failed', now - 9000, { next: 'mm:c-r2' }),
            job('mm', 'c-r2', 'budget-stopped', now - 5000, { resolvedNote: 'finished by hand in PR 12' }),
            // d: crashed, its retry crashed too, and the second retry finished.
            job('cc', 'd', 'failed', now - 9000, { next: 'mm:d-r2' }),
            job('mm', 'd-r2', 'failed', now - 5000, { next: 'cm:d-r3' }),
            job('cm', 'd-r3', 'done', now - 1000),
        ];
        const runs = chain.annotate(attempts);
        const by = Object.fromEntries(runs.map((r) => [r.key, r]));

        assert.equal(by['cc:a'].resolved.how, 'done', 'a session that carried the retry on finished the chain');
        assert.equal(by['cc:a'].resolved.byName, '↻ a-r2');
        assert.equal(by['mm:a-r2'].resolved.how, 'done', 'the step-limit stop it carried on is resolved too');

        assert.equal(by['cx:b'].resolved.how, 'budget', 'the chain ended in a step-limit stop');
        assert.match(by['cx:b'].resolved.note, /b-r2, which stopped at its step limit before it finished/);
        assert.doesNotMatch(by['cx:b'].resolved.note, /failed again/, 'a step-limit stop is not called a failure');
        assert.equal(by['mm:b-r2'].resolved, undefined, 'the unfinished stop needs attention');
        assert.equal(by['mm:b-r2'].reason, 'budget');

        assert.equal(by['mm:c-r2'].resolved.how, 'note', 'a stop the owner marked handled is handled');
        assert.equal(by['cc:c'].resolved.how, 'note', 'and so is the job it carried on');
        assert.match(by['cc:c'].resolved.note, /finished by hand in PR 12/);

        assert.equal(by['cc:d'].resolved.how, 'done', 'two hops down, the chain finished');
        assert.equal(by['cc:d'].resolved.byName, 'd-r3');
        assert.equal(by['mm:d-r2'].resolved.how, 'done');
    });

    await check('a handled note that names where the work went is followed to how that job ended', () => {
        const attempts = [
            job('cc', 'e', 'failed', now - 9000, { next: 'mm:e-r2' }),
            job('mm', 'e-r2', 'budget-stopped', now - 5000, { resolvedNote: 'Superseded: the commits are being integrated by mm:integrate-x.' }),
            job('mm', 'integrate-x', 'budget-stopped', now - 3000),
            carried('mm:integrate-x', 'integrate-x', now - 1000),
        ];
        const m = Object.fromEntries(chain.annotate(attempts).map((r) => [r.key, r]));
        assert.equal(m['mm:e-r2'].resolved.how, 'done', 'the note named the job that finished the work');
        assert.equal(m['mm:e-r2'].resolved.byName, '↻ integrate-x');
        assert.match(m['mm:e-r2'].resolved.said, /being integrated by mm:integrate-x/, 'the note is kept');
        assert.equal(m['cc:e'].resolved.how, 'done');
    });

    await check('the attempts are not changed by annotating them', () => {
        const attempts = [job('cc', 'a', 'failed', now - 9000, { next: 'mm:a-r2' }), job('mm', 'a-r2', 'budget-stopped', now - 5000)];
        const before = JSON.stringify(attempts);
        chain.annotate(attempts);
        assert.equal(JSON.stringify(attempts), before, 'the input is never changed');
    });

    await check('the outcome of a task is its state, its reason and its next step', () => {
        const attempts = [
            job('cc', 'a', 'failed', now - 9000, { error: 'usage limit reached' }),
            job('mm', 'a-r2', 'done', now - 5000),
        ];
        const out = chain.outcome(attempts);
        assert.equal(out.state, 'done');
        assert.equal(out.end.key, 'mm:a-r2');
        assert.equal(out.step.action, 'done');
        assert.equal(out.attempts.length, 2);
    });

    await check('a limit hands the task to another runner', () => {
        const cfg = { subagents: { cc: { enabled: true, max: 2 }, mm: { enabled: true, max: 2 } }, fallback: { order: ['cc', 'mm'] } };
        const ctx = { cfg, health: { cc: { state: 'ok' }, mm: { state: 'ok' } }, counts: {}, models: {}, runners: ['cc', 'mm'] };
        const attempts = [job('cc', 'a', 'failed', now, { error: 'usage limit reached' })];
        const step = chain.nextStep(attempts, ctx);
        assert.equal(step.action, 'switch');
        assert.equal(step.runner, 'mm');
        assert.match(step.why, /hit its usage limit/);
    });

    await check('a real error is retried on another runner, one reasoning level up', () => {
        const cfg = { subagents: { cc: { enabled: true, max: 2 }, mm: { enabled: true, max: 2 } }, fallback: { order: ['cc', 'mm'] } };
        const ctx = { cfg, health: { cc: { state: 'ok' }, mm: { state: 'ok' } }, counts: {}, models: {}, runners: ['cc', 'mm'] };
        const attempts = [job('cc', 'a', 'failed', now, { error: 'the tests did not pass', effort: 'medium' })];
        const step = chain.nextStep(attempts, ctx);
        assert.equal(step.action, 'switch');
        assert.equal(step.runner, 'mm');
        assert.equal(step.effort, 'high', 'one level up: the same attempt again rarely helps');
    });

    await check('a crash is continued in the same session', () => {
        const attempts = [{ ...job('cc', 'a', 'interrupted', now), facts: { session: 'sess-1', exit: 137 } }];
        const step = chain.nextStep(attempts);
        assert.equal(step.action, 'continue');
        assert.equal(step.session, 'sess-1');
        assert.match(step.why, /crash/);
    });

    await check('a harness turn cap is continued in its own session, on the same harness, never switched', () => {
        const cfg = { subagents: { cc: { enabled: true, max: 2 }, mm: { enabled: true, max: 2 } }, fallback: { order: ['cc', 'mm'] } };
        const ctx = { cfg, health: { cc: { state: 'ok' }, mm: { state: 'ok' } }, counts: {}, models: {}, runners: ['cc', 'mm'] };
        for (const error of ['max_turns in 2483s', 'error_max_turns', 'turn limit_exceeded', 'maximum number of turns reached']) {
            const attempts = [{ ...job('cc', 'a', 'failed', now, { error }), facts: { session: 'sess-9' } }];
            const step = chain.nextStep(attempts, ctx);
            assert.equal(step.action, 'continue', error);
            assert.equal(step.session, 'sess-9', error);
            assert.match(step.why, /turn cap/, error);
        }
        // Without a session there is nothing to continue: then, and only then, another runner may take it.
        const noSession = chain.nextStep([job('cc', 'a', 'failed', now, { error: 'max_turns' })], ctx);
        assert.equal(noSession.action, 'switch');
        assert.equal(noSession.runner, 'mm');
    });

    await check('a continuation of an attempt the owner marked handled is never switched', () => {
        const cfg = { subagents: { cc: { enabled: true, max: 2 }, mm: { enabled: true, max: 2 } }, fallback: { order: ['cc', 'mm'] } };
        const ctx = { cfg, health: { cc: { state: 'ok' }, mm: { state: 'ok' } }, counts: {}, models: {}, runners: ['cc', 'mm'] };
        const parent = job('cc', 'a', 'failed', now - 5000, { resolvedNote: 'Fine: the work landed in PR 12' });
        for (const error of ['usage limit reached', 'max_turns']) {
            const child = job('mm', 'a-r2', 'failed', now, { parent: 'cc:a', error });
            const step = chain.nextStep([parent, child], ctx);
            assert.notEqual(step.action, 'switch', error);
            assert.equal(step.action, 'failed', error);
            assert.match(step.why, /marked handled by the owner/, error);
        }
        // On a fresh parent that was not settled, the switch still happens.
        const open = job('cc', 'b', 'failed', now - 5000);
        const failed = job('mm', 'b-r2', 'failed', now, { parent: 'cc:b', error: 'usage limit reached' });
        assert.equal(chain.nextStep([open, failed], ctx).action, 'switch');
    });

    await check('a context that grew too big starts fresh instead of continuing', () => {
        const attempts = [{ ...job('cc', 'a', 'failed', now), facts: { apiError: 'prompt is too long: 250000 tokens' } }];
        const step = chain.nextStep(attempts);
        assert.equal(step.action, 'restart');
        assert.match(step.why, /context grew too big/);
    });

    await check('a stop is not a failure and is never handed to another runner', () => {
        const attempts = [job('cc', 'a', 'stopped', now)];
        const step = chain.nextStep(attempts, { cfg: { subagents: {}, fallback: { order: [] } } });
        assert.equal(step.action, 'stop');
    });

    await check('a step limit buys one wrap-up turn, a dollar limit does not', () => {
        const steps = [job('cc', 'a', 'budget-stopped', now, { budget: { hit: 'steps' } })];
        assert.equal(chain.nextStep(steps).action, 'wrap-up');
        assert.match(chain.nextStep(steps).prompt, /one short last turn/);
        const dollars = [job('cc', 'a', 'budget-stopped', now, { budget: { hit: 'usd' } })];
        assert.equal(chain.nextStep(dollars).action, 'stop');
        const done = [job('cc', 'a', 'budget-stopped', now, { budget: { hit: 'steps' }, wrapUp: true })];
        assert.equal(chain.nextStep(done).action, 'stop', 'only one wrap-up turn');
    });

    await check('a running task is waited for, not decided', () => {
        assert.equal(chain.nextStep([job('cc', 'a', 'running', now)]).action, 'wait');
        assert.equal(chain.nextStep([job('cc', 'a', 'done', now)]).action, 'done');
    });

    await check('the names of one job, its chain and its base are told apart', () => {
        assert.equal(chain.base('bench-7-finish'), 'bench7');
        assert.equal(chain.base('bench7-r2'), 'bench7');
        assert.equal(chain.chainRoot('x-r2'), 'x');
        assert.equal(chain.chainRoot('x-c1'), 'x');
        assert.equal(chain.sameChain('x', 'x-b'), true);
        assert.equal(chain.sameChain('seo-batch-a', 'seo-batch-b'), false);
    });

    done();
})();
