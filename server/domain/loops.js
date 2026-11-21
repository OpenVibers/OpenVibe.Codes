'use strict';
/**
 * Loops (plan §AD.37, OpenVibe Loop v0; the owner, 2026-11-21: "Research stitch and stitch loop which checks for security
 * and accessibility and etc … a way better system more modular shared universal … interconnected with codes actor"):
 * evergreen work that keeps a product right after it ships, run on the person's own coding agents with the plan time
 * they would otherwise lose (spare usage), each run ending in a pull request they review.
 *
 * Stitch Loop (Google Labs, 2026-11-18) runs Suggestions → Solutions → Build (a sandbox, a PR) → Reflect for security,
 * latency and accessibility. Here a loop is a repeating spare-usage task with a precise brief: measure with real tools,
 * fix the few findings that matter most, prove each fix by measuring again, and open a PR that carries the evidence.
 * Any harness takes it (Claude Code, Codex, Command Code …), on the person's machine, at the moment a plan is about to
 * reset with time left; it comes back after each run, so it keeps watching.
 *
 *   LOOPS                  the templates: { id, name, what, prompt({ repo, site }) }
 *   taskFor(id, { repo, site }) → the spare task body ({ title, prompt, repo, priority, repeat: true })
 */
const COMMON = [
    'Work in this repository on a new branch. Change only what a finding needs: the smallest correct fix, in the project\'s own style.',
    'Prove every fix: run the same check again and show its output before and after.',
    'Open one pull request. Its description lists each finding: what the tool said, where (file and line, or page and selector), why it matters, what you changed, and the check\'s result after. Add screenshots for anything visible, at 390 px and 1280 px.',
    'If the checks find nothing worth fixing, change nothing and say so: an empty run is a good result.',
    'Never commit a secret, a password or a key; never weaken a check, a test or a security setting to make a finding go away.',
];

const LOOPS = [
    {
        id: 'accessibility', name: 'Accessibility', what: 'WCAG 2.2 AA: axe on the main pages at phone and desktop widths, labels, focus, contrast, targets',
        steps: (site) => [
            `Measure: ${site ? `the live site ${site}` : 'the app, started locally the way its README says'}: run axe-core through Playwright (@axe-core/playwright) on its main pages at 390 px and 1280 px wide, light and dark where it has both. Also check: every control has an accessible name, images have alt text, focus is visible and in a sensible order, colour contrast is at least 4.5:1 for text, touch targets are at least 44 px, no text under 12 px, nothing scrolls sideways at 390 px.`,
            'Fix the ten findings with the most impact (serious and critical first, then the ones on the most pages).',
        ],
    },
    {
        id: 'security', name: 'Security', what: 'secrets, vulnerable dependencies, risky code patterns, headers and CSP',
        steps: (site) => [
            'Measure: gitleaks on the repository (secrets: describe where, never print one; recommend rotating it), npm audit or osv-scanner for dependencies, semgrep --config auto for code patterns (injection, unsafe deserialisation, open redirects, missing authorisation checks).',
            site ? `Read the live site's response headers (${site}): Content-Security-Policy, Strict-Transport-Security, X-Content-Type-Options, Referrer-Policy, frame-ancestors; and cookies' Secure, HttpOnly and SameSite.` : 'Read the server code that sets response headers and cookies: Content-Security-Policy, HSTS, nosniff, Referrer-Policy, frame-ancestors, Secure/HttpOnly/SameSite.',
            'Fix the true positives with the most risk first (at most eight): upgrade a dependency within its major version, parameterise a query, escape output, add the missing check. Add a test for each code fix. Leave a false positive alone and say why it is one.',
        ],
    },
    {
        id: 'latency', name: 'Speed', what: 'Lighthouse at phone size, the biggest wins: blocking resources, images, caching, slow routes',
        steps: (site) => [
            `Measure: Lighthouse (npx lighthouse, mobile) on ${site ? `${site} and its two busiest pages` : 'the app\'s main pages, built and served the way production serves them'}: LCP, CLS, INP/TBT, and the opportunities it lists; the size of the JavaScript and CSS each page loads; any route that takes over 300 ms on the server.`,
            'Make the three changes with the biggest measured gain (render-blocking CSS or scripts, oversized images, missing caching headers, a slow query or loop). Show the numbers before and after.',
        ],
    },
    {
        id: 'tests', name: 'Tests', what: 'the important code with the fewest tests: meaningful tests, and the bugs they find',
        steps: () => [
            'Measure: run the test suite (and coverage if the project has it). Find the module that matters most (used widely, handles money, data or permissions) with the least testing.',
            'Write meaningful tests for its behaviour (not its internals), including the edge cases. Fix any bug they find, in the same pull request, with the failing test first.',
        ],
    },
    {
        id: 'docs', name: 'Docs', what: 'docs that no longer match the code: README, API docs, examples',
        steps: () => [
            'Measure: compare the README and the docs with the code: commands, environment variables, API routes and their fields, examples that no longer run.',
            'Correct what is wrong or missing, in the docs\' own voice. Run every example you change.',
        ],
    },
    {
        id: 'dependencies', name: 'Dependencies', what: 'safe updates within each major version, tests green',
        steps: () => [
            'Measure: list outdated dependencies (npm outdated or the project\'s own tool).',
            'Update those that can move within their major version, a few at a time; run the tests after each group and keep only the groups that stay green. Note in the PR anything a major version would need.',
        ],
    },
];
for (const l of LOOPS) {
    l.prompt = ({ repo, site = null }) => [
        `${l.name} loop for ${repo}${site ? ` (live at ${site})` : ''}: ${l.what}.`,
        ...l.steps(site).map((s, i) => `${i + 1}. ${s}`),
        ...COMMON,
    ].join('\n');
}

const SITE = /^https:\/\/[^\s/]+(\/[^\s]*)?$/;

/** The spare-task body for a loop, or { error }. */
function taskFor(id, { repo, site = null } = {}) {
    const l = LOOPS.find((x) => x.id === id);
    if (!l) return { error: `A loop is one of ${LOOPS.map((x) => x.id).join(', ')}.` };
    const s = site == null || site === '' ? null : String(site).trim();
    if (s && !SITE.test(s)) return { error: 'The site is its https address.' };
    return { body: { title: `${l.name} loop`, prompt: l.prompt({ repo: String(repo || '').trim(), site: s }), repo, priority: 4, repeat: true } };
}

module.exports = { LOOPS, taskFor };
