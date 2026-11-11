'use strict';

/**
 * Release 2 item 9 (Codes slice): the per-turn usage ledger and the pre-call cap gate.
 *
 * Every turn records engine, model, effort, tokens with cached called out, cost and its source, trigger, parent and
 * outcome. The root's totals sum delegated turns too. Before the next call the gate refuses at the cap (409, never
 * run) and warns once at 80% of it. The runner appends each attempt and enforces the gate.
 */
const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ledger = require('../engine/ledger');
const { runAttempt } = require('../engine/jobrunner');
const { check, done } = require('./helpers/boot');

const turn = (over = {}) => ({
    engine: 'command-code', model: 'm-1', effort: 'max',
    inputTokens: 100, outputTokens: 50, cachedTokens: 30,
    costUsd: 0.01, costSource: 'receipt', trigger: 'attempt', parent: null, outcome: 'ok', ...over,
});

/** A stand-in for a CLI: it prints what the real one prints. */
function fake(dir, lines) {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const script = ['#!/usr/bin/env node', ...lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`)].join('\n');
    fs.writeFileSync(path.join(bin, 'cmd'), script);
    fs.chmodSync(path.join(bin, 'cmd'), 0o755);
    return bin;
}

(async () => {
    try {
        await check('a turn is recorded with its tokens, cost and lineage', () => {
            const list = [];
            const e = ledger.add(list, turn({ parent: 't-0' }));
            assert.strictEqual(e.n, 1);
            assert.strictEqual(list.length, 1);
            assert.strictEqual(e.parent, 't-0');
            assert.throws(() => ledger.add(list, { ...turn(), costSource: null }), /source/, 'a cost names its source');
            assert.throws(() => ledger.add(null, turn()), /list/);
        });

        await check('the root sums delegated turns without double counting', () => {
            const list = [];
            ledger.add(list, turn({ costUsd: 0.02 }));
            ledger.add(list, turn({ costUsd: 0.03, parent: 't-1', engine: 'codex' }));
            ledger.add(list, { engine: 'codex', outcome: 'error' });
            const s = ledger.summarize(list);
            assert.strictEqual(s.turns, 3);
            assert.strictEqual(s.inputTokens, 200);
            assert.strictEqual(s.cachedTokens, 60);
            assert.strictEqual(s.costUsd, 0.05);
            assert.strictEqual(s.delegatedTurns, 1);
            assert.strictEqual(s.delegatedCostUsd, 0.03);
            assert.strictEqual(s.byEngine['command-code'].turns, 1);
            assert.strictEqual(s.byEngine['codex'].turns, 2);
            assert.strictEqual(ledger.summarize([]).costUsd, null, 'no priced turn is no USD total, never zero');
        });

        await check('the gate refuses at the cap and warns once at 80% of it', () => {
            const turns = [];
            assert.strictEqual(ledger.preCall(turns, {}).allowed, true, 'no limits, no gate');
            assert.strictEqual(ledger.preCall(turns, { turns: null, usd: null }).allowed, true);
            const list = [];
            for (let i = 0; i < 8; i++) ledger.add(list, turn());
            const warn = ledger.preCall(list, { turns: 10 });
            assert.strictEqual(warn.allowed, true);
            assert.strictEqual(warn.warned, true, '8 of 10 trips the one warning');
            assert.ok(warn.warning.includes('8 of 10'));
            assert.strictEqual(ledger.preCall(list, { turns: 10 }, { warned: true }).warned, true, 'already warned stays warned, no second warning');
            assert.strictEqual(ledger.preCall(list, { turns: 10 }, { warned: true }).warning, undefined);
            for (let i = 0; i < 2; i++) ledger.add(list, turn());
            const stop = ledger.preCall(list, { turns: 10 });
            assert.strictEqual(stop.allowed, false);
            assert.strictEqual(stop.status, 409);
            assert.strictEqual(stop.hit, 'turns');
            const rich = [];
            ledger.add(rich, turn({ costUsd: 8.5 }));
            assert.strictEqual(ledger.preCall(rich, { usd: 10 }).warned, true, '$8.50 of $10 warns');
            ledger.add(rich, turn({ costUsd: 2 }));
            const broke = ledger.preCall(rich, { usd: 10 });
            assert.strictEqual(broke.allowed, false);
            assert.strictEqual(broke.status, 409);
            assert.strictEqual(ledger.preCall([{ ...turn(), costUsd: null }], { usd: 10 }).allowed, true, 'an unpriced turn never trips the dollar cap');
        });

        await check('an attempt appends its spending to the caller ledger', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-'));
            const bin = fake(dir, [
                { type: 'event', event: { type: 'run_start', sessionId: 's-9' } },
                { type: 'result', subtype: 'success', finalText: 'done', sessionId: 's-9' },
            ]);
            const turns = [];
            const res = await runAttempt({
                agent: 'command-code', prompt: 'do it', cwd: dir, log: path.join(dir, 'f.jsonl'),
                env: { PATH: `${bin}:${process.env.PATH}` }, ledger: turns, trigger: 'retry', effort: 'max',
            });
            assert.strictEqual(res.ok, true);
            assert.strictEqual(turns.length, 1);
            assert.strictEqual(turns[0].engine, 'command-code');
            assert.strictEqual(turns[0].trigger, 'retry');
            assert.strictEqual(turns[0].outcome, 'ok');
            assert.strictEqual(res.ledgerSummary.turns, 1);
            assert.strictEqual(res.ledgerWarned, false);
            fs.rmSync(dir, { recursive: true, force: true });
        });

        await check('a capped ledger refuses the call with a 409 and runs nothing', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-cap-'));
            const turns = [];
            for (let i = 0; i < 3; i++) ledger.add(turns, turn());
            const res = await runAttempt({
                agent: 'command-code', prompt: 'do it', cwd: dir, log: path.join(dir, 'f.jsonl'),
                env: { PATH: dir }, ledger: turns, budget: { steps: 3 },
            });
            assert.strictEqual(res.ok, false);
            assert.strictEqual(res.refused.status, 409);
            assert.strictEqual(res.refused.code, 'budget.capped');
            assert.strictEqual(turns.length, 3, 'the refused call appends nothing');
            fs.rmSync(dir, { recursive: true, force: true });
        });

        console.log('ledger: every turn recorded, the root sums delegated work, the cap refuses before the call');
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
    done();
})();
