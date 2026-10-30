'use strict';
/**
 * Codes' GitHub reader (C4b), offline: a pull request's state and the repository search, with a stand-in for GitHub.
 * The page must never invent a state: what GitHub did not answer is a problem beside the link.
 */
const assert = require('assert');
const { check, done } = require('./helpers/boot');
const { createGitHub, githubRepo, pullRequestParts, mergeWord, ciWord } = require('../server/domain/github');

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

(async () => {
    await check('a repository URL and a pull request URL are read only when they are GitHub ones', async () => {
        assert.deepStrictEqual(githubRepo('https://github.com/OpenVibers/OpenVibe.Codes'), { owner: 'OpenVibers', name: 'OpenVibe.Codes', url: 'https://github.com/OpenVibers/OpenVibe.Codes' });
        assert.strictEqual(githubRepo('https://gitlab.com/a/b'), null);
        assert.strictEqual(githubRepo('javascript:alert(1)'), null);
        assert.deepStrictEqual(pullRequestParts('https://github.com/o/n/pull/12'), { owner: 'o', name: 'n', number: 12 });
        assert.strictEqual(pullRequestParts('https://evil.example/o/n/pull/12'), null);
        assert.strictEqual(ciWord({ state: 'success' }), 'Passed');
        assert.strictEqual(mergeWord({ merged: true }), 'Merged');
        assert.strictEqual(mergeWord({ state: 'open', mergeable: false }), 'Has conflicts');
    });

    await check('a pull request shows GitHub&rsquo;s own CI and merge state, and is cached', async () => {
        const calls = [];
        const fetchImpl = async (url) => {
            calls.push(url);
            if (url.endsWith('/pulls/12')) return json(200, { state: 'open', merged: false, mergeable: true, mergeable_state: 'clean', title: 'Make it read well', head: { sha: 'abcdef1234', ref: 'codes/x' }, base: { ref: 'main' } });
            if (url.includes('/commits/abcdef1234/status')) return json(200, { state: 'success', statuses: [] });
            return json(404, {});
        };
        const gh = createGitHub({ config: {}, fetchImpl, log: { warn() {} } });
        const pr = await gh.pullRequest('https://github.com/o/n/pull/12');
        assert.strictEqual(pr.state, 'open');
        assert.strictEqual(pr.ci, 'Passed');
        assert.strictEqual(pr.merge, 'Ready to merge');
        assert.strictEqual(pr.branch, 'codes/x');
        await gh.pullRequest('https://github.com/o/n/pull/12');
        assert.strictEqual(calls.length, 2, 'the second read comes from the cache');
    });

    await check('a pull request carries its merge commit and the deploy state of the service it builds', async () => {
        const fetchImpl = async (url) => {
            if (url.endsWith('/pulls/12')) return json(200, { state: 'closed', merged: true, merge_commit_sha: 'a1b2c3d4e5f6', title: 'Ship it', head: { sha: 'abcdef1234', ref: 'codes/x' }, base: { ref: 'main' } });
            if (url.includes('/status')) return json(200, { state: 'success' });
            return json(404, {});
        };
        const seen = [];
        const ship = { async deployOf(what) { seen.push(what); return { state: 'deployed', service: 'codes', release: 'a1b2c3d4e5f6' }; } };
        const gh = createGitHub({ config: {}, fetchImpl, ship, log: { warn() {} } });
        const pr = await gh.pullRequest('https://github.com/OpenVibers/OpenVibe.Codes/pull/12');
        assert.strictEqual(pr.merged, true);
        assert.strictEqual(pr.merge_commit_sha, 'a1b2c3d4e5f6');
        assert.strictEqual(pr.deploy.state, 'deployed');
        assert.deepStrictEqual(seen, [{ repo: 'OpenVibers/OpenVibe.Codes', mergeCommitSha: 'a1b2c3d4e5f6', merged: true }]);
    });

    await check('a pull request GitHub does not answer is a problem, never a guessed state', async () => {
        const gh = createGitHub({ config: {}, fetchImpl: async () => json(404, { message: 'Not Found' }), log: { warn() {} } });
        const pr = await gh.pullRequest('https://github.com/o/private/pull/3');
        assert.ok(pr.problem && /private|no such pull request/i.test(pr.problem.detail), 'the problem says why');
        const broken = createGitHub({ config: {}, fetchImpl: async () => { throw new Error('offline'); }, log: { warn() {} } });
        const down = await broken.pullRequest('https://github.com/o/n/pull/4');
        assert.ok(down.problem && down.state === undefined, 'an unreachable GitHub has no state');
    });

    await check('the search puts the person&rsquo;s own repositories first, then GitHub&rsquo;s public answer', async () => {
        const store = { db: { many: async () => [{ repo: 'https://github.com/OpenVibers/OpenVibe.Codes', at: 2 }, { repo: 'https://example.com/nope', at: 1 }] } };
        const fetchImpl = async (url) => url.includes('/search/repositories')
            ? json(200, { items: [{ full_name: 'OpenVibers/OpenVibe.Shared', html_url: 'https://github.com/OpenVibers/OpenVibe.Shared', private: false, stars: 3 },
                { full_name: 'someone/secret', html_url: 'https://github.com/someone/secret', private: true }, { full_name: 'OpenVibers/OpenVibe.Codes', html_url: 'https://github.com/OpenVibers/OpenVibe.Codes' }] })
            : json(404, {});
        const gh = createGitHub({ config: {}, store, fetchImpl, log: { warn() {} } });
        const out = await gh.search('usr_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'openvibe');
        assert.strictEqual(out.recent.length, 1, 'only GitHub repositories are kept from the history');
        assert.deepStrictEqual(out.found.map((r) => r.full_name), ['OpenVibers/OpenVibe.Codes', 'OpenVibers/OpenVibe.Shared'], 'own first, no duplicates, no private repositories');
        const failing = createGitHub({ config: {}, store, fetchImpl: async () => json(403, { message: 'rate limited' }), log: { warn() {} } });
        const limited = await failing.search('usr_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'openvibe');
        assert.ok(limited.problem && limited.problem.status === 429, 'a limited search says so');
        assert.deepStrictEqual(limited.found.map((r) => r.full_name), ['OpenVibers/OpenVibe.Codes'], 'and keeps what Codes already knows');
        const quiet = await gh.search('usr_01ARZ3NDEKTSV4RRFFQ69G5FAV', '');
        assert.ok(quiet.found.length >= 1 && !quiet.problem, 'an empty query spends no GitHub request');
    });
    done();
})().catch((e) => { console.error(e); process.exit(1); });
