'use strict';
/**
 * The released contracts (the pinned openvibe-contracts tag) describe what the code does. Since 0.113.0 the codes
 * service manifest declares the coding-task capabilities (codes.task.*, Contracts 0.162): the developer console moved to
 * OpenVibe.Services, which owns services.release.* and services.app.*, and the codes.* forms are retired. Since 0.232.0
 * it produces codes.task.queued|running|succeeded|failed|cancelled and consumes run.job.*. The harness catalog's rows are the
 * contracts' platform.harness-offer@1 and platform.agent-offer@1 (checked at boot by server/domain/harnesses.js).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { check, done } = require('./helpers/boot');

(async () => {
    const manifest = contracts.services.get('codes');

    await check('the codes service manifest is released as alpha, live, with the coding-task capabilities', async () => {
        assert.ok(manifest);
        assert.strictEqual(manifest.status, 'alpha');
        assert.deepStrictEqual(manifest.domains, ['openvibe.codes']);
        assert.strictEqual(manifest.exposure.state, 'live');
        // Contracts 0.229.0: a first-party service starts, reads and cancels a person's coding task (http/tasks-api.js)
        // and reads their Action Center items (http/actions-api.js).
        assert.deepStrictEqual(manifest.capabilities, ['codes.task.start', 'codes.task.read', 'codes.task.cancel', 'codes.actions.read']);
        for (const id of manifest.capabilities) assert.strictEqual(contracts.capabilities.get(id).status, 'active', id);
        const range = manifest.contractRanges['openvibe-contracts'];
        assert.ok(require('openvibe-sdk/core').satisfiesRange(require('openvibe-contracts/package.json').version, range));
    });

    await check('the console\'s codes.* names are retired, each with its services.* replacement', async () => {
        for (const id of ['codes.release.read', 'codes.release.manage', 'codes.resource.read']) {
            assert.strictEqual(contracts.capabilities.get(id).status, 'retired', id);
        }
        for (const id of ['services.release.read', 'services.release.manage']) {
            const c = contracts.capabilities.get(id);
            assert.ok(c && c.status === 'active' && c.owner === 'services', id);
        }
    });

    await check('nothing here guards or emits a console name any more', async () => {
        const files = [];
        const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith('.js')) files.push(f); } };
        walk(path.join(__dirname, '..', 'server'));
        for (const f of files) {
            const text = fs.readFileSync(f, 'utf8');
            assert.ok(!/codes\.(release|resource|app)\.|codes\.moderation\.action|requireCapability/.test(text), `${path.relative(path.join(__dirname, '..'), f)} still names the console`);
        }
    });

    await check('every codes.task.* payload validates against the pinned contracts, and the manifest names the topics', async () => {
        const contracts = require('openvibe-contracts');
        const { TOPICS, payloadOf } = require('../server/events/outbox');
        const row = { id: 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3', agent: 'claude', repo: 'https://github.com/OpenVibers/OpenVibe.Codes.git',
            started_at: '2026-10-28T16:00:00.000Z', finished_at: null, error: null, result: null };
        const rows = [
            { ...row, state: 'queued', started_at: null },
            { ...row, state: 'placed' },
            { ...row, state: 'succeeded', finished_at: new Date('2026-10-28T16:04:00Z'), result: { cost_usd: 0.42, files: ['a.js', 'b.js'] } },
            { ...row, state: 'expired', finished_at: '2026-10-28T17:00:00.000Z', error: 'run.job_expired: no machine took the job' },
            { ...row, state: 'cancelled', repo: 'not a url', agent: null },
        ];
        for (const r of rows) {
            const payload = payloadOf(r);
            const topic = `codes.task.${payload.state}`;
            assert.ok(TOPICS.includes(topic), topic);
            const v = contracts.validate(topic, payload);
            assert.ok(v.valid, `${topic}: ${JSON.stringify(v.errors)}`);
        }
        assert.strictEqual(payloadOf(rows[2]).repo, 'OpenVibers/OpenVibe.Codes');
        assert.strictEqual(payloadOf(rows[2]).files_changed, 2);
        const manifest = require('openvibe-contracts/manifests/services/codes.json');
        assert.deepStrictEqual(manifest.eventsProduced, TOPICS);
        assert.ok(manifest.eventsConsumed.includes('run.job.succeeded') && manifest.eventsConsumed.includes('network.account.deleted'));
        assert.ok(!fs.existsSync(path.join(__dirname, '..', 'docs', 'contracts-proposal')), 'the proposal moved to Contracts 0.232.0');
    });

    done();
})();
