'use strict';
/**
 * The home page's sections beyond the kit's generic ones: OpenVibe Git (the forge at git.openvibe.codes, read from its
 * public API: how many repositories, which changed last), quick-start commands for the harness and the public router,
 * and the questions people ask, which the FAQPage JSON-LD repeats. The repository list is read in the background at most
 * every ten minutes and never awaited by a page; a forge that does not answer leaves the list out.
 */
const contracts = require('openvibe-contracts');
const showcase = require('openvibe-shared/showcase');

const esc = showcase.esc;

// Forgejo listens on 127.0.0.1:5060, a port the Fetch standard blocks (SIP), so Node's fetch refuses it ("bad port"):
// the read goes through node:http instead, which has no such list.
function getJson(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const lib = u.protocol === 'https:' ? require('https') : require('http');
        const req = lib.get(u, { headers: { Accept: 'application/json' }, timeout: timeoutMs }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; if (body.length > 2_000_000) req.destroy(new Error('too large')); });
            res.on('end', () => { try { resolve({ status: res.statusCode, total: Number(res.headers['x-total-count']) || null, body: JSON.parse(body) }); } catch (e) { reject(e); } });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

function createGitReader({ internalUrl, publicUrl, enabled = true, ttlMs = 10 * 60_000, retryMs = 60_000, timeoutMs = 3000, limit = 8 } = {}) {
    let value = null;
    let at = 0;
    let inflight = null;
    const pub = String(publicUrl || 'https://git.openvibe.codes').replace(/\/+$/, '');
    async function refresh() {
        if (inflight) return inflight;
        inflight = (async () => {
            try {
                const res = await getJson(`${String(internalUrl).replace(/\/+$/, '')}/api/v1/repos/search?limit=${limit}&sort=updated&order=desc`, timeoutMs);
                if (res.status === 200) {
                    const { body, total } = res;
                    const repos = (Array.isArray(body.data) ? body.data : [])
                        .filter((r) => r && !r.private && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(String(r.full_name || '')))
                        .map((r) => ({ name: r.full_name, url: `${pub}/${r.full_name}`, updated: r.updated_at || null, language: r.language || '' }));
                    if (repos.length) value = { total: total && total >= repos.length ? total : null, repos, publicUrl: pub };
                }
            } catch { /* keep the last answer */ }
            // A failed read is tried again after a minute, not after the full ten.
            at = value ? Date.now() : Date.now() - ttlMs + retryMs;
            return value;
        })().finally(() => { inflight = null; });
        return inflight;
    }
    return {
        peek() { if (enabled && Date.now() - at > ttlMs && !inflight) refresh().catch(() => {}); return value; },   // floating-ok: refresh catches its own errors
        refresh,
        /** Tests. */
        _set(v) { value = v; at = Date.now(); },
    };
}

// A repository's line: the tagline of the service it builds, from the pinned contracts, when one names it.
const taglines = new Map(contracts.services.manifests.filter((m) => m && m.repository && m.site && m.site.tagline).map((m) => [m.repository, m.site.tagline]));
function ago(iso, now = Date.now()) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    const m = Math.max(0, Math.round((now - t) / 60000));
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} h ago`;
    return `${Math.round(h / 24)} days ago`;
}

function gitSection(git, now = Date.now()) {
    const pub = (git && git.publicUrl) || 'https://git.openvibe.codes';
    const list = git && git.repos && git.repos.length ? `<ul class="codes-repos">${git.repos.map((r) => {
        const line = taglines.get(r.name) || '';
        return `<li><a href="${esc(r.url)}"><b>${esc(r.name.replace(/^OpenVibers\//, ''))}</b>${line ? `<small>${esc(line)}</small>` : ''}<span>${[r.language, r.updated ? `updated ${ago(r.updated, now)}` : ''].filter(Boolean).map(esc).join(' · ')}</span></a></li>`;
    }).join('')}</ul>` : '';
    const count = git && git.total ? `${git.total} repositories` : 'Every OpenVibe repository';
    return `<section class="sc-sec" id="git" aria-labelledby="h-git"><h2 id="h-git">OpenVibe Git</h2>
<p class="sc-lede">${esc(count)} on OpenVibe's own code forge at <a href="${esc(pub)}/">git.openvibe.codes</a>: browse, clone over HTTPS and sign in with your OpenVibe account, in the network's theme. The repositories are mirrored from GitHub every hour; GitHub stays the home of each one until it moves here.</p>
${list}<pre tabindex="0" class="codes-clone"><code>git clone ${esc(pub)}/OpenVibers/OpenVibe.Codes.git</code></pre>
<p class="sc-note"><a href="${esc(pub)}/OpenVibers">All OpenVibers repositories</a> · <a href="${esc(pub)}/user/login">Sign in with OpenVibe</a></p></section>`;
}

/** The harness from a terminal, and the public router any program can ask. */
function quickStart({ install }) {
    return showcase.code({
        id: 'quick-start', title: 'Start in a minute',
        lede: 'The harness runs on your machine with the agent CLIs and keys you already have. The router is public: ask it which agent fits a task, no key needed.',
        samples: [
            { label: 'Install and run', lang: 'bash', code: `${install}
openvibe-codes agents                 # which agents this machine can run
cd my-project
openvibe-codes run "add a test for the date parser"
openvibe-codes run --permission read "where is the session cookie set?"
openvibe-codes runs                   # every run, kept to show or resume` },
            { label: 'Ask the router (public API)', lang: 'bash', code: `curl -s https://openvibe.codes/api/v1/harnesses/route \\
  -H 'Content-Type: application/json' -d '{ "task": "review" }'
# → { "selected": "claude-code:claude-code-sonnet",
#     "reasons": [ "no marginal cost (already-paid capacity or a free allowance)", … ],
#     "candidates": [ … every agent, with why it was or was not picked ] }` },
        ],
    });
}

// The questions people ask. The first three are Codes' own in the contracts (the answers OpenVibe.Help shows).
const EXTRA_FAQ = [
    { q: 'Does it cost anything?', a: 'The harness is free and open source. Each agent runs with your own CLI and keys, so you pay its provider as you already do; the router prefers capacity you have already paid for and free allowances.' },
    { q: 'What happens when an agent gets stuck?', a: 'A failed, rate-limited or silent agent is stopped and the task goes to the next one with a note: the task, why the last agent stopped, the files it changed and the state of the tree.' },
    { q: 'What is OpenVibe Git?', a: 'OpenVibe\'s own code forge at git.openvibe.codes, where you sign in with your OpenVibe account. It holds every public OpenVibe repository, mirrored from GitHub every hour.' },
];
function faqPairs() {
    const m = contracts.services.get('codes');
    const own = ((m && m.site && m.site.faq) || []).filter((f) => f && f.question && f.answer).map((f) => ({ q: f.question, a: f.answer }));
    const seen = new Set();
    return [...own, ...EXTRA_FAQ].filter((p) => !seen.has(p.q) && seen.add(p.q));
}
const faq = () => `<section class="sc-sec" id="faq" aria-labelledby="h-faq"><h2 id="h-faq">Questions people ask</h2><div class="codes-faq">${faqPairs().map((p, i) => `<details${i === 0 ? ' open' : ''}><summary><h3>${esc(p.q)}</h3></summary><p>${esc(p.a)}</p></details>`).join('')}</div></section>`;

module.exports = { createGitReader, gitSection, quickStart, faq, faqPairs, ago };
