'use strict';
/**
 * The runtime capability manifest (engine/runtime.js): every catalog harness declares what it can do, every offer
 * carries it as `harness:<field>-<value>` capabilities, and both routers (placement and the tier router) exclude a
 * harness that does not declare what the task needs — no provider-name conditional in either.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHarnesses } = require('../server/domain/harnesses');
const { toOffer, route } = require('../server/domain/harness-placement');
const runtime = require('../engine/runtime');
const { pick } = require('../engine/router');
const { check, done } = require('./helpers/boot');

const catalogPath = path.join(__dirname, '..', 'server', 'data', 'harness-offers.json');
const rows = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

(async () => {
    await check('every catalog harness declares every field, with a known value', () => {
        for (const row of rows) {
            const manifest = runtime.forHarness(row.id);
            assert.ok(manifest, `${row.id} has no runtime manifest`);
            assert.deepStrictEqual(Object.keys(manifest).sort(), Object.keys(runtime.FIELDS).sort(), row.id);
            for (const [field, values] of Object.entries(runtime.FIELDS)) {
                assert.ok(values.includes(manifest[field]), `${row.id}.${field}: ${manifest[field]} is not one of ${values.join('|')}`);
            }
        }
        assert.deepStrictEqual(Object.keys(runtime.MANIFEST).sort(), rows.map((row) => row.id).sort(), 'no manifest without a catalog row');
    });

    await check('a manifest becomes one capability per field, and fits() reads it', () => {
        assert.deepStrictEqual(runtime.capabilities(runtime.forHarness('claude-code')), [
            'harness:terminal-status-structured', 'harness:steering-resume', 'harness:checkpointing-none',
            'harness:subagents-native', 'harness:context-handoff-session', 'harness:enforcement-native',
        ]);
        assert.deepStrictEqual(runtime.requirements({ steering: 'resume', subagents: 'native' }), ['harness:steering-resume', 'harness:subagents-native']);
        assert.strictEqual(runtime.fits('claude-code', { subagents: 'native' }), true);
        assert.strictEqual(runtime.fits('codex', { subagents: 'native' }), false);
        assert.strictEqual(runtime.fits('cx', ['harness:steering-resume']), true, 'the portal runner id names the same harness');
        assert.strictEqual(runtime.fits('pg', ['harness:steering-resume']), false, 'an unknown runner declares nothing');
        assert.strictEqual(runtime.fits('pg', []), true, 'nothing required, nothing to exclude');
    });

    await check('every offer carries the manifest as capabilities the placement router can require', () => {
        const harnesses = createHarnesses({ catalogPath });
        for (const harness of harnesses.list()) {
            const offer = toOffer(harness, harnesses.agents(harness.id)[0]);
            for (const cap of runtime.capabilities(runtime.forHarness(harness.id))) {
                assert.ok(offer.capabilities.includes(cap), `${offer.offer_id} lacks ${cap}`);
            }
        }
        const r = route({ task: 'edit', extra: { capabilities: ['harness:subagents-native'] }, harnesses, now: Date.now() });
        assert.strictEqual(r.selected.split(':')[0], 'claude-code');
        for (const id of ['codex:codex-default', 'opencode:opencode-default', 'aider:aider-default', 'deepseek:deepseek-chat']) {
            assert.deepStrictEqual(r.candidates.find((c) => c.id === id), { id, included: false, reason: 'lacks harness:subagents-native' });
        }
        const none = route({ task: 'edit', extra: { capabilities: ['harness:checkpointing-git'] }, harnesses, now: Date.now() });
        assert.strictEqual(none.selected, null, 'no harness declares checkpointing yet');
        assert.ok(none.candidates.every((c) => c.reason === 'lacks harness:checkpointing-git'));
    });

    await check('the tier router skips a ladder rung its manifest cannot meet', () => {
        const ctx = {
            cfg: { subagents: { mm: { enabled: true, max: 2 }, cm: { enabled: true, max: 2 } } },
            health: { mm: { state: 'ok' }, cm: { state: 'ok' } },
            counts: {}, models: {}, runs: [],
            ladder: { basic: [['mm', null, 'high'], ['cm', null, 'high']] },
        };
        assert.strictEqual(pick('Fix the parser', ctx).runner, 'mm', 'no requirement: the first rung stays');
        assert.strictEqual(pick('Fix the parser', { ...ctx, needs: ['harness:subagents-native'] }).runner, 'cm');
        assert.strictEqual(pick('Fix the parser', { ...ctx, needs: { steering: 'resume' } }).runner, 'mm');
        assert.strictEqual(pick('Fix the parser', { ...ctx, needs: ['harness:subagents-native'], ladder: { basic: [['mm', null, 'high']] } }), null);
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
