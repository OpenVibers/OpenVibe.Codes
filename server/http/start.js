'use strict';
/**
 * What a new conversation starts from. The owner, 2026-11-01: "it should be built in to select the repositories that
 * have to do with OpenVibe… without having to put a repository URL… consider supporting any Git… a person who doesn't
 * know shit should be able to go on there and somewhat easily start vibe coding a website or a game… openvibe.space,
 * openvibe.website integrated directly into codes… instead of these buttons, a scrolling thing that has different
 * ideas, and you can click that… tailor it."
 *
 * Three ways to start, and each says where the work runs:
 *   new       a website, a game or an app, described in words. OpenVibe AI builds it on openvibe.space (OpenVibe's
 *             servers: nothing to install) and the person gets a live link. Codes hands the words over, and nothing
 *             is built until they press Build there.
 *   openvibe  one of OpenVibe's own projects, picked from a list (the pinned contracts' live services, plus the shared
 *             libraries): an agent works on it on the person's computer and opens a pull request.
 *   code      the person's own repository: a recent one, one found by name, or any https Git URL. An ssh address or an
 *             owner/name is read as its https twin; a private repository clones with the computer's own git sign-in.
 */
const contracts = require('openvibe-contracts');

const MODES = ['new', 'openvibe', 'code'];

// What "Something new" can be, and the words Space's builder is handed so it knows which.
const KINDS = {
    website: { label: 'Website', lead: 'A website: ', words: /\b(site|website|page|portfolio|landing|blog)\b/i },
    game: { label: 'Game', lead: 'A browser game: ', words: /\b(game|play|puzzle|quiz|arcade|platformer)\b/i },
    app: { label: 'App or tool', lead: '', words: null },
};

// The ideas on the rail: each one fills the box, ready to be changed. Plain, specific, and nothing that copies a
// named game or product.
const IDEAS = {
    website: [
        'A bakery site with today’s hours, the menu and how to order',
        'A portfolio for my photos, with a contact form',
        'A wedding page with the date, the place and an RSVP',
        'A one-page site for my band with our next shows',
        'A landing page for my app with a waitlist',
        'A links page for my socials, in my colours',
    ],
    game: [
        'A snake game with a leaderboard',
        'A trivia quiz about 90s cartoons',
        'A memory card game with emoji',
        'A typing race against the clock',
        'A tiny platformer with three levels',
        'A space shooter that gets faster every wave',
    ],
    app: [
        'A habit tracker with streaks',
        'A poll my stream chat can vote in',
        'A shared shopping list for my house',
        'A tip calculator that splits the bill',
        'A countdown to my next stream',
        'Flashcards for learning Japanese',
    ],
    code: [
        'Fix the failing tests',
        'Explain how this project is laid out',
        'Make the home page faster on phones',
        'Find and fix one bug',
        'Make every page work at 320 px',
        'Write tests for the part that has none',
        'Add a dark mode that follows the system',
        'Find a security hole and close it',
    ],
    openvibe: [
        'Add the feature you wish it had',
        'Make the home page faster on phones',
        'Fix the thing that annoyed you last time',
        'Make every page work at 320 px',
        'Explain how this project is laid out',
        'Find and fix one bug',
    ],
};

/** The rail for a mode: "new" mixes the three kinds, one of each in turn. → [{ text, mode, kind }] */
function ideasFor(mode) {
    if (mode === 'new') {
        const out = [];
        for (let i = 0; i < 6; i++) for (const kind of ['website', 'game', 'app']) if (IDEAS[kind][i]) out.push({ text: IDEAS[kind][i], mode: 'new', kind });
        return out;
    }
    return (IDEAS[mode] || IDEAS.code).map((text) => ({ text, mode, kind: null }));
}

// OpenVibe's own projects: every live service with a public site, and the shared libraries under them. GitHub is
// where the pull requests open today; OpenVibe Git (git.openvibe.codes) mirrors every one of them.
const LIBRARIES = [
    { repository: 'OpenVibers/OpenVibe.Shared', name: 'Shared', line: 'The navbar, themes and pieces every site uses' },
    { repository: 'OpenVibers/OpenVibe.SDK', name: 'SDK', line: 'The toolkit every service is built on' },
    { repository: 'OpenVibers/OpenVibe.Contracts', name: 'Contracts', line: 'How the services talk to each other' },
];
const PROJECTS = (() => {
    const seen = new Set();
    const sites = contracts.services.manifests
        .filter((m) => m && m.repository && /^OpenVibers\/[A-Za-z0-9._-]+$/.test(m.repository) && m.site && m.site.name && m.exposure && m.exposure.state === 'live')
        .map((m) => ({ repository: m.repository, name: m.site.name, line: m.site.tagline || '', domain: String(m.publicOrigin || '').replace(/^https?:\/\//, ''), group: 'Sites' }))
        .sort((a, b) => a.name.localeCompare(b.name));
    return [...sites, ...LIBRARIES.map((l) => ({ ...l, domain: '', group: 'Libraries' }))]
        .filter((p) => !seen.has(p.repository) && seen.add(p.repository))
        .map((p) => ({ ...p, url: `https://github.com/${p.repository}` }));
})();
const project = (repository) => PROJECTS.find((p) => p.repository === String(repository || '')) || null;

/**
 * Any Git address the person types, as the https URL a task clones. "owner/name" is a GitHub repository; an ssh address
 * (git@host:owner/name.git or ssh://git@host/owner/name) becomes its https twin; a bare host/path gains https://.
 * → string, or '' when it cannot be a repository address (credentials in it, another scheme, no path).
 */
function normalizeRepo(raw) {
    let s = String(raw || '').trim();
    if (!s || s.length > 500 || /\s/.test(s)) return '';
    let m;
    if ((m = /^[A-Za-z0-9_.-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,}):(.+)$/.exec(s))) s = `https://${m[1]}/${m[2]}`;
    else if ((m = /^ssh:\/\/[A-Za-z0-9_.-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?::\d+)?\/(.+)$/.exec(s))) s = `https://${m[1]}/${m[2]}`;
    else if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s) && !/^[A-Za-z0-9-]+\.[A-Za-z]{2,}\//.test(s)) s = `https://github.com/${s}`;
    else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/.+/.test(s)) s = `https://${s}`;
    let u;
    try { u = new URL(s); } catch { return ''; }
    if (u.protocol !== 'https:' || u.username || u.password || u.pathname.split('/').filter(Boolean).length < 1) return '';
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
}

const SPACE = String((contracts.services.get('space') || {}).publicOrigin || 'https://openvibe.space').replace(/\/+$/, '');
const MAX_HANDOVER_URL = 6000;   // a request line nginx and every browser take whole
/**
 * Where "Something new" goes: Space's new-space page with the words in the box, through Space's sign-in (which brings
 * the person back with the query; Space's own sign-in page would drop it). Long words are cut until the address fits,
 * and the person sees exactly what arrived before anything is built.
 */
function spaceHref({ kind, text, origin = SPACE }) {
    const k = KINDS[kind] ? kind : 'website';
    let words = String(text || '').trim();
    const lead = KINDS[k].lead && !(KINDS[k].words && KINDS[k].words.test(words)) ? KINDS[k].lead : '';
    const build = (w) => `${origin}/auth/login?next=${encodeURIComponent(`/spaces/new?prompt=${encodeURIComponent(`${lead}${w}`.slice(0, 4000))}&from=codes`)}`;
    let href = build(words);
    while (href.length > MAX_HANDOVER_URL && words.length > 40) { words = words.slice(0, Math.floor(words.length * 0.85)).trimEnd(); href = build(words); }
    return href;
}

module.exports = { MODES, KINDS, IDEAS, ideasFor, PROJECTS, project, normalizeRepo, spaceHref, SPACE };
