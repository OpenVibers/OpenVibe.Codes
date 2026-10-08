'use strict';
/**
 * The released contracts (the pinned openvibe-contracts tag) describe what the code does. Since 0.113.0 the codes
 * service manifest declares no capability and no event: the developer console moved to OpenVibe.Services, which owns
 * services.release.* and services.app.*, and the codes.* forms are retired. The harness catalog's rows are the
 * contracts' platform.harness-offer@1 and platform.agent-offer@1 (checked at boot by server/domain/harnesses.js).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { check, done } = require('./helpers/boot');

(async () => {
    const manifest = contracts.services.get('codes');

    await check('the codes service manifest is released as alpha, live, with no capability and no event', async () => {
        assert.ok(manifest);
        assert.strictEqual(manifest.status, 'alpha');
        assert.deepStrictEqual(manifest.domains, ['openvibe.codes']);
        assert.strictEqual(manifest.exposure.state, 'live');
        assert.deepStrictEqual(manifest.capabilities, []);
        assert.deepStrictEqual(manifest.eventsProduced, []);
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

    await check('no proposal left behind: everything proposed is released', async () => {
        const docs = path.join(__dirname, '..', 'docs');
        assert.ok(!fs.existsSync(path.join(docs, 'capabilities-proposal')));
        assert.ok(!fs.existsSync(path.join(docs, 'service-manifest-proposal.json')));
        assert.ok(!fs.existsSync(path.join(docs, 'contracts-proposal')));
    });

    done();
})();
