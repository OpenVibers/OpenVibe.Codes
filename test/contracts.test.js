'use strict';
/**
 * The released contracts (openvibe-contracts tag v0.28.0) describe what the code does: the codes
 * service manifest's events are exactly what the outbox can produce, its capabilities are the ones
 * the API guards with requireCapability, and the release API answers with the contracts' problems.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { EVENT_TYPES } = require('../server/events/outbox');
const { MANAGE, READ } = require('../server/http/api');
const { check, done } = require('./helpers/boot');

(async () => {
    const manifest = contracts.services.get('codes');

    await check('the codes service manifest is released as alpha, with this code\'s events', async () => {
        assert.ok(manifest);
        assert.strictEqual(manifest.status, 'alpha');
        assert.deepStrictEqual(manifest.domains, ['openvibe.codes']);
        assert.deepStrictEqual([...manifest.eventsProduced].sort(), [...EVENT_TYPES].sort());
        for (const e of manifest.eventsProduced) assert.strictEqual(e.split('.').length, 3, `${e} has three segments`);
        const range = manifest.contractRanges['openvibe-contracts'];
        assert.ok(require('openvibe-sdk/core').satisfiesRange(require('openvibe-contracts/package.json').version, range));
    });

    await check('its capabilities exist, are owned by codes, and are the ones the API guards', async () => {
        assert.deepStrictEqual([...manifest.capabilities].sort(), [MANAGE, READ].sort());
        for (const id of manifest.capabilities) {
            const c = contracts.capabilities.get(id);
            assert.ok(c, id);
            assert.strictEqual(c.owner, 'codes');
            assert.strictEqual(c.status, 'active');
        }
        const api = fs.readFileSync(path.join(__dirname, '..', 'server', 'http', 'api.js'), 'utf8');
        assert.match(api, /requireCapability\('codes\.release\.manage'/);
        assert.match(api, /requireCapability\('codes\.release\.read'/);
    });

    await check('no proposal left behind: everything proposed is released', async () => {
        const docs = path.join(__dirname, '..', 'docs');
        assert.ok(!fs.existsSync(path.join(docs, 'capabilities-proposal')));
        assert.ok(!fs.existsSync(path.join(docs, 'service-manifest-proposal.json')));
        assert.ok(!fs.existsSync(path.join(docs, 'contracts-proposal')));
        assert.ok(contracts.resolve('codes.app-manifest@1'));
    });

    done();
})();
