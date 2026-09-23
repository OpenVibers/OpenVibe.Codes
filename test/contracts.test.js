'use strict';
/**
 * The proposals Codes ships validate against the released contract schemas, and they describe what
 * the code actually does: the events the outbox can produce and the capability the API checks.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { EVENT_TYPES } = require('../server/events/outbox');
const { MANAGE } = require('../server/http/api');
const { check, done } = require('./helpers/boot');

const DOCS = path.join(__dirname, '..', 'docs');

(async () => {
    const caps = fs.readdirSync(path.join(DOCS, 'capabilities-proposal')).map((f) => JSON.parse(fs.readFileSync(path.join(DOCS, 'capabilities-proposal', f), 'utf8')));
    const service = JSON.parse(fs.readFileSync(path.join(DOCS, 'service-manifest-proposal.json'), 'utf8'));

    await check('capability proposals validate as capabilities.capability@1 and are owned by codes', async () => {
        assert.ok(caps.length >= 2);
        for (const c of caps) {
            const v = contracts.validate('capabilities.capability@1', c);
            assert.ok(v.valid, `${c.id}: ${JSON.stringify(v.errors)}`);
            assert.strictEqual(c.owner, 'codes');
            assert.ok(c.id.startsWith('codes.'));
            assert.ok(!contracts.capabilities.get(c.id), `${c.id} is already released; drop the proposal`);
        }
    });

    await check('the service manifest proposal validates and matches the code', async () => {
        const v = contracts.validate('registry.service-manifest@1', service);
        assert.ok(v.valid, JSON.stringify(v.errors));
        assert.strictEqual(service.id, 'codes');
        assert.deepStrictEqual([...service.eventsProduced].sort(), [...EVENT_TYPES].sort());
        assert.deepStrictEqual([...service.capabilities].sort(), caps.map((c) => c.id).sort());
        assert.ok(service.capabilities.includes(MANAGE));
        for (const e of service.eventsProduced) assert.strictEqual(e.split('.').length, 3, `${e} has three segments`);
        const range = service.contractRanges['openvibe-contracts'];
        assert.ok(require('openvibe-sdk/core').satisfiesRange(require('openvibe-contracts/package.json').version, range));
    });

    await check('the app manifest proposal is a valid JSON Schema the contracts validator compiles', async () => {
        const schema = JSON.parse(fs.readFileSync(path.join(DOCS, 'contracts-proposal', 'codes', 'app-manifest.v1.json'), 'utf8'));
        assert.strictEqual(schema.$id, 'https://openvibe.network/contracts/codes/app-manifest.v1.json');
        const info = require('../server/domain/manifests').appSchemaInfo();
        assert.strictEqual(info.id, 'codes.app-manifest');
    });

    done();
})();
