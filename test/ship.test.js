'use strict';

/**
 * Ship tracking (Codes C9c): after CI and the merge, is the service deployed? The signal is the host's own —
 * `GET <publicOrigin>/release.json`, which `ovhost status` reads — compared with the pull request's merge commit. Nothing
 * is guessed from a timer.
 */
const assert = require('assert');
const { check, done } = require('./helpers/boot');
const { createShip, serviceFor } = require('../server/domain/ship');

const MANIFESTS = [
    { id: 'codes', repository: 'OpenVibers/OpenVibe.Codes', publicOrigin: 'https://openvibe.codes' },
    { id: 'run', repository: 'OpenVibers/OpenVibe.Run', publicOrigin: 'https://run.openvibe.network' },
    { id: 'internal', repository: 'OpenVibers/OpenVibe.Bot' },
];
const MERGE = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const AFTER = 'ffffffffffffffffffffffffffffffffffffffff';

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** A release.json per origin, and GitHub's compare, stood in for. */
function world({ release = null, originOk = true, compare = null } = {}) {
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        if (url === 'https://openvibe.codes/release.json') return originOk ? json(200, { service: 'codes', release }) : json(503, {});
        if (url.includes('/compare/')) return compare == null ? json(502, {}) : json(200, { status: compare });
        return json(404, {});
    };
    return { fetchImpl, calls };
}

(async () => {
    try {
        await check('a repository is tied to the service its manifest names, and only when it has a public origin', () => {
            assert.equal(serviceFor(MANIFESTS, 'openvibers/openvibe.codes').id, 'codes', 'the match is case-insensitive');
            assert.equal(serviceFor(MANIFESTS, 'OpenVibers/OpenVibe.Bot'), null, 'a manifest without an origin is not deployable');
            assert.equal(serviceFor(MANIFESTS, 'nobody/else'), null);
            assert.equal(serviceFor(MANIFESTS, null), null);
        });

        await check('the merge commit the service reports is deployed', async () => {
            const { fetchImpl } = world({ release: MERGE });
            const ship = createShip({ config: {}, fetchImpl, manifests: MANIFESTS, log: { warn() {} } });
            const out = await ship.deployOf({ repo: 'OpenVibers/OpenVibe.Codes', mergeCommitSha: MERGE, merged: true });
            assert.equal(out.state, 'deployed');
            assert.equal(out.service, 'codes');
            assert.equal(out.release, MERGE);
            assert.equal(out.origin, 'https://openvibe.codes');
        });

        await check('a release that contains the merge commit (GitHub says ahead or identical) is deployed', async () => {
            const { fetchImpl } = world({ release: AFTER, compare: 'ahead' });
            const ship = createShip({ config: {}, fetchImpl, manifests: MANIFESTS, log: { warn() {} } });
            const out = await ship.deployOf({ repo: 'OpenVibers/OpenVibe.Codes', mergeCommitSha: MERGE, merged: true });
            assert.equal(out.state, 'deployed');
        });

        await check('merged but behind the service\'s release is not live yet', async () => {
            const { fetchImpl } = world({ release: AFTER, compare: 'behind' });
            const ship = createShip({ config: {}, fetchImpl, manifests: MANIFESTS, log: { warn() {} } });
            const out = await ship.deployOf({ repo: 'OpenVibers/OpenVibe.Codes', mergeCommitSha: MERGE, merged: true });
            assert.equal(out.state, 'pending');
            assert.match(out.detail, /not deployed yet/);
        });

        await check('an unmerged pull request waits, and a service that does not answer is not read', async () => {
            const { fetchImpl } = world({ release: MERGE });
            const ship = createShip({ config: {}, fetchImpl, manifests: MANIFESTS, log: { warn() {} } });
            assert.equal((await ship.deployOf({ repo: 'OpenVibers/OpenVibe.Codes', mergeCommitSha: null, merged: false })).state, 'waiting');
            const down = createShip({ config: {}, fetchImpl: world({ originOk: false }).fetchImpl, manifests: MANIFESTS, log: { warn() {} } });
            const out = await down.deployOf({ repo: 'OpenVibers/OpenVibe.Codes', mergeCommitSha: MERGE, merged: true });
            assert.equal(out.state, 'unknown');
            assert.match(out.detail, /release\.json/);
        });

        await check('a repository Codes knows no service for has no deploy state, not a wrong one', async () => {
            const { fetchImpl, calls } = world({ release: MERGE });
            const ship = createShip({ config: {}, fetchImpl, manifests: MANIFESTS, log: { warn() {} } });
            const out = await ship.deployOf({ repo: 'octocat/Hello-World', mergeCommitSha: MERGE, merged: true });
            assert.equal(out.state, 'unknown');
            assert.equal(out.service, null);
            assert.equal(calls.length, 0, 'no origin was asked');
        });
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    }
    done();
})();
