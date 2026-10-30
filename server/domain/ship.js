'use strict';

/**
 * Ship tracking (Codes C9c): after CI and the merge, is the service that repository builds actually deployed?
 *
 * The signal is the host's own: `ovhost status <service>` compares the service's `GET /release.json` (the deployed
 * commit, set at boot) with the commit it expected, and Codes reads that same `/release.json` from the service's public
 * origin. A PR's merge commit counts as deployed when the service reports it, or a later main commit that contains it
 * (GitHub's compare says ahead/identical). Nothing is guessed from a timer: when neither answer is available the state
 * is "not read" with the release the service does report.
 *
 *   createShip({ config, fetchImpl, manifests, log })
 *     deployOf({ repo, mergeCommitSha, merged }) → { state, service, origin, release, booted_at, checked_at, detail? }
 *
 * state: 'deployed' | 'pending' (merged, not live yet) | 'waiting' (not merged) | 'unknown' (nothing to read).
 */

const REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const SHA = /^[0-9a-f]{7,40}$/i;

/** The service a repository builds, from the contracts' manifests (a manifest without an origin is not deployable). */
function serviceFor(manifests, repo) {
    const m = REPO.exec(String(repo || ''));
    if (!m) return null;
    const want = `${m[1]}/${m[2]}`.toLowerCase();
    return (manifests || []).find((s) => s && typeof s.repository === 'string'
        && s.repository.toLowerCase() === want && typeof s.publicOrigin === 'string' && /^https:\/\//.test(s.publicOrigin)) || null;
}

function createShip({ config = {}, fetchImpl = globalThis.fetch, manifests = null, log = console } = {}) {
    const list = manifests || require('openvibe-contracts').services.manifests;
    const token = String((config.github && config.github.token) || '').trim();
    const base = String(process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

    async function releaseOf(origin) {
        const res = await fetchImpl(`${String(origin).replace(/\/+$/, '')}/release.json`, {
            headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000),
        });
        const doc = await res.json().catch(() => null);
        return res.ok && doc && typeof doc === 'object' ? doc : null;
    }

    /** Does the deployed release contain the PR's merge commit? GitHub's compare answers when the shas differ. */
    async function contains(repo, sha, release) {
        if (!SHA.test(String(release || ''))) return null;
        try {
            const res = await fetchImpl(`${base}/repos/${repo}/compare/${sha}...${release}`, {
                headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'openvibe-codes', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                signal: AbortSignal.timeout(6000),
            });
            if (!res.ok) return null;
            const doc = await res.json().catch(() => null);
            return doc && typeof doc.status === 'string' ? ['ahead', 'identical'].includes(doc.status) : null;
        } catch { return null; }
    }

    /**
     * A pull request's deploy state.
     *
     * @param {object} what
     * @param {string} what.repo owner/name
     * @param {string|null} [what.mergeCommitSha] the merge commit GitHub reports
     * @param {boolean} [what.merged] whether the PR is merged
     * @returns {Promise<object>} { state, service, origin, release, booted_at, checked_at, detail? }
     */
    async function deployOf({ repo, mergeCommitSha = null, merged = false } = {}) {
        const checked_at = new Date().toISOString();
        const service = serviceFor(list, repo);
        if (!service) return { state: 'unknown', service: null, origin: null, release: null, booted_at: null, checked_at, detail: 'Codes knows no service for this repository' };
        let doc = null;
        try { doc = await releaseOf(service.publicOrigin); } catch (e) {
            log.warn(`[Codes] ${service.id}: /release.json could not be read: ${String(e && e.message).slice(0, 160)}`);
        }
        const release = doc && typeof doc.release === 'string' ? doc.release : null;
        const booted = doc && typeof doc.booted_at === 'string' ? doc.booted_at : null;
        const out = { service: service.id, origin: service.publicOrigin, release, booted_at: booted, checked_at };
        if (!merged || !mergeCommitSha) return { ...out, state: 'waiting', detail: 'the pull request is not merged yet' };
        if (!release) return { ...out, state: 'unknown', detail: 'the service did not answer /release.json, so Codes cannot tell whether it is live' };
        if (release === mergeCommitSha || release.startsWith(mergeCommitSha) || mergeCommitSha.startsWith(release)) {
            return { ...out, state: 'deployed', detail: null };
        }
        const ahead = await contains(repo, mergeCommitSha, release);
        if (ahead === true) return { ...out, state: 'deployed', detail: null };
        if (ahead === false) return { ...out, state: 'pending', detail: 'merged, not deployed yet' };
        return { ...out, state: 'unknown', detail: `the service reports release ${release}, which Codes could not compare with the merge` };
    }

    return { deployOf, releaseOf, contains, enabled: true };
}

module.exports = { createShip, serviceFor, REPO };
