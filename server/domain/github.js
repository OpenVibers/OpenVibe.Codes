'use strict';

/**
 * Codes' small GitHub reader (Codes C4b): which repositories a person may pick for a task, and what happened to the
 * pull request a task opened.
 *
 * Two rules shape it. The first is that Codes holds no GitHub account of a person: there is no per-person GitHub link
 * in OpenVibe.Network today, so a repository is searched on GitHub's public repository search, narrowed to the person's
 * own repositories when they have used them here before. The second is that a pull request's state is GitHub's, not
 * Codes': the link comes from the task's own result, and its CI and merge state are read from api.github.com and shown
 * as read, or said not to have been read — never guessed.
 *
 *   createGitHub({ config, store, fetchImpl, log })
 *     search(subject, q)        → { recent, found, problem }: repositories, the person's own first
 *     pullRequest(url)          → { url, state, ci, mergeable, checked_at } or { url, problem }
 *
 * The optional token (CODES_GITHUB_TOKEN) raises GitHub's limits; it is never logged, never in an answer and never sent
 * anywhere but api.github.com.
 */

const { createShip } = require('./ship');

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d{1,10})\/?$/;
const REPO_URL = /^(?:https:\/\/|git@)github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i;
const TTL_MS = 2 * 60_000;
const FAIL_MS = 20_000;
const SEARCH_TTL_MS = 60_000;
const MAX_FOUND = 8;

/** A repository URL as Codes stores it (https, no .git), or null when it is not a GitHub one. */
function githubRepo(url) {
    const m = REPO_URL.exec(String(url || '').trim());
    return m && OWNER.test(m[1]) && NAME.test(m[2]) ? { owner: m[1], name: m[2], url: `https://github.com/${m[1]}/${m[2]}` } : null;
}

/** A pull request URL's parts, or null when it is not one. */
function pullRequestParts(url) {
    const m = PR_URL.exec(String(url || '').trim());
    return m ? { owner: m[1], name: m[2], number: Number(m[3]) } : null;
}

/** The merge state in the words a person reads. */
function mergeWord(pr) {
    if (!pr) return null;
    if (pr.merged) return 'Merged';
    if (pr.state === 'closed') return 'Closed without merging';
    if (pr.draft) return 'Draft';
    if (pr.mergeable === false) return 'Has conflicts';
    if (pr.mergeable_state === 'blocked') return 'Waiting for checks or a review';
    if (pr.mergeable_state === 'behind') return 'Behind its base branch';
    if (pr.mergeable_state === 'clean' || pr.mergeable === true) return 'Ready to merge';
    return 'Open';
}

/** The CI state in the words a person reads, from GitHub's combined commit status. */
function ciWord(status) {
    const state = status && (status.state || status.status);
    return ({ success: 'Passed', failure: 'Failed', error: 'Errored', pending: 'Running' })[state] || null;
}

function createGitHub({ config = {}, store = null, fetchImpl = globalThis.fetch, log = console, ship = null } = {}) {
    const token = String((config.github && config.github.token) || '').trim();
    const cache = new Map();
    const searches = new Map();
    // The host's own deploy signal: the service's /release.json, which `ovhost status` reads too (Codes C9c).
    const deployments = ship || createShip({ config, fetchImpl, log });

    const headers = () => ({
        Accept: 'application/vnd.github+json',
        'User-Agent': 'openvibe-codes',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    });

    async function getJson(path) {
        const res = await fetchImpl(`https://api.github.com${path}`, { headers: headers(), signal: AbortSignal.timeout(6000) });
        const doc = await res.json().catch(() => null);
        return { status: res.status, ok: res.ok, doc };
    }

    /** The person's own repositories used here, newest first (a URL is enough: Codes stored them already). */
    async function recent(subject, limit = MAX_FOUND) {
        if (!store || !subject) return [];
        const rows = await store.db.many(
            `SELECT repo, max(created_at) AS at FROM run_tasks WHERE subject = $1 AND repo LIKE 'https://github.com/%' GROUP BY repo ORDER BY at DESC LIMIT $2`,
            [subject, limit],
        );
        return rows.map((r) => githubRepo(r.repo)).filter(Boolean)
            .map((r) => ({ full_name: `${r.owner}/${r.name}`, url: r.url, recent: true }));
    }

    /**
     * Search: the person's own repositories first (the ones they used here, then GitHub's search for what they typed).
     * A GitHub that does not answer leaves the answers Codes already knows, and says it could not search.
     *
     * The answer is cached for a minute: a person typing the same letters again should not spend GitHub's budget twice.
     */
    async function search(subject, q, { limit = MAX_FOUND } = {}) {
        const query = String(q || '').trim().slice(0, 100);
        const key = `${subject || ''}|${query.toLowerCase()}|${limit}`;
        const hit = searches.get(key);
        if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.value;
        const value = await searchNow(subject, query, limit);
        searches.set(key, { at: Date.now(), value });
        if (searches.size > 200) searches.delete(searches.keys().next().value);
        return value;
    }

    async function searchNow(subject, query, limit) {
        const mine = await recent(subject, limit);
        const found = [];
        let problem = null;
        const qq = query.replace(/[^A-Za-z0-9._/-]+/g, ' ').trim();
        if (qq) {
            const path = `/search/repositories?q=${encodeURIComponent(`${qq} in:name`)}&sort=stars&order=desc&per_page=${limit}`;
            try {
                const out = await getJson(path);
                if (out.ok && out.doc && Array.isArray(out.doc.items)) {
                    for (const item of out.doc.items.slice(0, limit)) {
                        if (!item || !item.full_name || item.private) continue;
                        found.push({
                            full_name: String(item.full_name).slice(0, 140),
                            url: String(item.html_url || `https://github.com/${item.full_name}`).slice(0, 300),
                            description: item.description ? String(item.description).slice(0, 160) : null,
                            updated_at: item.updated_at || null,
                            stars: Number(item.stargazers_count) || 0,
                        });
                    }
                } else {
                    problem = {
                        status: out.status === 403 || out.status === 429 ? 429 : 502,
                        detail: out.status === 403 || out.status === 429
                            ? 'GitHub limits how many searches one address may make; the repositories you used here still work'
                            : `GitHub answered ${out.status} for the search`,
                    };
                }
            } catch (e) {
                problem = { status: 503, detail: `GitHub did not answer: ${String(e && e.message).slice(0, 120)}` };
            }
        }
        // The person's own repositories that match what they typed come first, then GitHub's public answer.
        const asked = query.toLowerCase();
        const own = mine.filter((r) => !asked || r.full_name.toLowerCase().includes(asked));
        const seen = new Set(own.map((r) => r.full_name.toLowerCase()));
        const rest = found.filter((r) => !seen.has(r.full_name.toLowerCase()));
        return { q: query, recent: mine, found: [...own, ...rest].slice(0, limit), problem };
    }

    /**
     * A pull request's state, as GitHub has it now. Cached for two minutes (a failure for twenty seconds), so a page a
     * person reloads does not spend GitHub's budget. Never throws: a read that failed is a problem, and the page shows
     * the link without the state.
     */
    async function pullRequest(url) {
        const parts = pullRequestParts(url);
        if (!parts) return { url: String(url || ''), problem: { status: 422, detail: 'that is not a GitHub pull request' } };
        const key = `${parts.owner}/${parts.name}#${parts.number}`;
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < (hit.problem ? FAIL_MS : TTL_MS)) return hit.value;
        let value;
        try {
            const pr = await getJson(`/repos/${parts.owner}/${parts.name}/pulls/${parts.number}`);
            if (!pr.ok || !pr.doc || typeof pr.doc !== 'object') {
                value = { url, problem: { status: pr.status === 404 ? 404 : 502, detail: pr.status === 404 ? 'GitHub has no such pull request (a private repository needs its own access)' : `GitHub answered ${pr.status}` } };
            } else {
                const doc = pr.doc;
                let ci = null;
                const sha = doc.head && doc.head.sha ? String(doc.head.sha) : null;
                if (sha && /^[0-9a-f]{7,40}$/i.test(sha)) {
                    const status = await getJson(`/repos/${parts.owner}/${parts.name}/commits/${sha}/status`);
                    if (status.ok && status.doc) ci = ciWord(status.doc);
                }
                value = {
                    url, number: parts.number, owner: parts.owner, name: parts.name,
                    state: doc.merged ? 'merged' : (doc.state === 'closed' ? 'closed' : 'open'),
                    merge: mergeWord(doc),
                    merged: !!doc.merged,
                    merge_commit_sha: doc.merge_commit_sha ? String(doc.merge_commit_sha).slice(0, 40) : null,
                    ci,
                    title: doc.title ? String(doc.title).slice(0, 200) : null,
                    branch: doc.head && doc.head.ref ? String(doc.head.ref).slice(0, 120) : null,
                    base: doc.base && doc.base.ref ? String(doc.base.ref).slice(0, 120) : null,
                    // CI, merge, then the deploy the host reports for the service this repository builds.
                    deploy: await deployments.deployOf({ repo: `${parts.owner}/${parts.name}`, mergeCommitSha: doc.merge_commit_sha || null, merged: !!doc.merged }),
                    checked_at: new Date().toISOString(),
                };
            }
        } catch (e) {
            log.warn(`[Codes] pull request ${key} could not be read: ${String(e && e.message).slice(0, 160)}`);
            value = { url, problem: { status: 503, detail: 'GitHub did not answer, so its state is not shown' } };
        }
        cache.set(key, { at: Date.now(), value, problem: !!value.problem });
        if (cache.size > 500) cache.delete(cache.keys().next().value);
        return value;
    }

    return { search, pullRequest, recent, githubRepo, pullRequestParts };
}

module.exports = { createGitHub, githubRepo, pullRequestParts, mergeWord, ciWord, MAX_FOUND };
