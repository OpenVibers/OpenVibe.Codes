'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const contracts = require('openvibe-contracts');
const { createHarnesses } = require('../server/domain/harnesses');
const { check, done } = require('./helpers/boot');

const catalogPath = path.join(__dirname, '..', 'server', 'data', 'harness-offers.json');
const rows = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

(async () => {
    await check('every seed row matches the pinned harness and agent contracts', async () => {
        assert.strictEqual(rows.length, 10);
        for (const row of rows) {
            // The row is one contract instance: the offer and the agents (models) it runs.
            const harnessCheck = contracts.validate('platform.harness-offer@1', row);
            assert.strictEqual(harnessCheck.valid, true, JSON.stringify(harnessCheck.errors));
            const { agents, ...offer } = row;
            assert.ok(Array.isArray(agents));
            for (const agent of agents) {
                const agentCheck = contracts.validate('platform.agent-offer@1', agent);
                assert.strictEqual(agentCheck.valid, true, JSON.stringify(agentCheck.errors));
                assert.strictEqual(agent.harness, offer.id);
            }
        }
    });

    await check('the two engine adapters Codes gained are in the catalogue', async () => {
        // engine/adapters/minimax-code.js and engine/adapters/claude-code.js (the claude-other one).
        const minimax = rows.find((row) => row.id === 'minimax-code');
        assert.ok(minimax, 'the catalogue has minimax-code');
        assert.strictEqual(minimax.name, 'MiniMax Code');
        assert.strictEqual(minimax.address.kind, 'cli');
        assert.strictEqual(minimax.address.target, 'mcode');
        assert.ok(minimax.agents.length > 0, 'minimax-code runs at least one model');
        const other = rows.find((row) => row.id === 'claude-other');
        assert.ok(other, 'the catalogue has claude-other');
        assert.strictEqual(other.name, 'Claude Code (another provider)');
        assert.strictEqual(other.address.kind, 'cli');
        assert.strictEqual(other.address.target, 'claude');
        assert.ok(other.agents.length > 0, 'claude-other runs at least one model');
        for (const row of [minimax, other]) {
            assert.strictEqual(row.agents.every((agent) => agent.harness === row.id), true);
        }
    });

    await check('every engine adapter has a catalogue row, so the router can select it', async () => {
        const { ids: adapterIds } = require('../engine/adapters');
        for (const id of adapterIds()) {
            assert.ok(rows.some((row) => row.id === id), `the catalogue has ${id}`);
        }
    });

    await check('harness and agent ids are unique', async () => {
        const ids = rows.flatMap((row) => [row.id, ...row.agents.map((agent) => agent.id)]);
        assert.strictEqual(new Set(ids).size, ids.length);
    });

    await check('list, get and agents round-trip the catalog', async () => {
        const harnesses = createHarnesses({ catalogPath });
        assert.deepStrictEqual(harnesses.list(), rows);
        for (const row of rows) {
            assert.deepStrictEqual(harnesses.get(row.id), row);
            assert.deepStrictEqual(harnesses.agents(row.id), row.agents);
        }
        assert.strictEqual(harnesses.get('missing'), null);
        assert.deepStrictEqual(harnesses.agents('missing'), []);
    });

    await check('malformed offers, malformed agents and duplicate ids are rejected', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-harnesses-'));
        const badPath = path.join(dir, 'offers.json');
        const expectInvalid = (data) => {
            fs.writeFileSync(badPath, JSON.stringify(data));
            assert.throws(() => createHarnesses({ catalogPath: badPath }), (error) => error.code === 'harness.invalid');
        };
        try {
            expectInvalid([{ ...rows[0], unexpected: true }]);
            expectInvalid([{ ...rows[0], agents: [{ ...rows[0].agents[0], unexpected: true }] }]);
            expectInvalid([rows[0], rows[0]]);
            expectInvalid([{ ...rows[0], agents: [rows[0].agents[0], rows[0].agents[0]] }]);
            expectInvalid([{ ...rows[0], agents: [{ ...rows[0].agents[0], harness: 'other' }] }]);
        } finally {
            fs.unlinkSync(badPath);
            fs.rmdirSync(dir);
        }
    });

    done();
})();
