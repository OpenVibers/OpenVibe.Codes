'use strict';
/**
 * The released contracts (the pinned openvibe-contracts tag) describe what the code does: the codes
 * service manifest's events are exactly what the outbox can produce, its capabilities are the ones
 * the API and the resource index guard with requireCapability, and the release API answers with the
 * contracts' problems.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { EVENT_TYPES } = require('../server/events/outbox');
const { MANAGE, READ } = require('../server/http/api');
const { RESOURCE_READ } = require('../server/registry/resource-index');
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
        // codes.resource.read (ADR-048, the resource index) is released too. It stays 'planned' until the
        // contracts follow-up flips it after this ships, so only the two release capabilities are active.
        assert.deepStrictEqual([...manifest.capabilities].sort(), [MANAGE, READ, RESOURCE_READ].sort());
        for (const id of [MANAGE, READ]) {
            const c = contracts.capabilities.get(id);
            assert.ok(c, id);
            assert.strictEqual(c.owner, 'codes');
            assert.strictEqual(c.status, 'active');
        }
        const resource = contracts.capabilities.get(RESOURCE_READ);
        assert.ok(resource, RESOURCE_READ);
        assert.strictEqual(resource.owner, 'codes');
        const api = fs.readFileSync(path.join(__dirname, '..', 'server', 'http', 'api.js'), 'utf8');
        // The guards are serviceAuth.requireCapability built per request with the key the token names; api.js's
        // createCapabilityAccess is the one factory the release routes and the resource index both guard with.
        assert.match(api, /serviceAuth\.requireCapability\(cap,/);
        assert.match(api, /checked\('codes\.release\.manage'/);
        assert.match(api, /guardFor\('codes\.release\.read'\)/);
        const index = fs.readFileSync(path.join(__dirname, '..', 'server', 'registry', 'resource-index.js'), 'utf8');
        assert.match(index, /RESOURCE_READ = 'codes\.resource\.read'/, 'the resource index guards codes.resource.read');
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
