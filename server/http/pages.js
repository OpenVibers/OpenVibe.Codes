'use strict';

/**
 * Public pages: the home page (the open coding-agent harness), getting started with the harness on your own machine,
 * the agent catalog, Improve OpenVibe (how OpenVibe itself is built and how to help), the community documents, and the
 * update log. Crawl artifacts (robots.txt,
 * sitemap.xml, llms.txt, llms-full.txt, the home page's JSON-LD) live in http/discovery.js and are mounted here.
 *
 * What is shown is read, never restated: the catalog is server/data/harness-offers.json as validated at boot, the
 * repositories are the pinned openvibe-contracts service manifests, and the community documents render this
 * repository's Markdown files as they are. The developer console that used to live here (projects, apps, docs,
 * tools, releases) is OpenVibe.Services' since 2026-10-08; http/moved.js redirects its addresses there.
 */
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd, SERVICES_ORIGIN } = require('./discovery');
const { html, raw, table, notice } = require('../render/html');
const { send } = require('../render/layout');
const { markdown } = require('../render/markdown');
const placement = require('../domain/harness-placement');

const ROOT = path.join(__dirname, '..', '..');
const GITHUB = 'https://github.com/OpenVibers';
const { version: VERSION } = require('../../package.json');
// The harness installs from its release tag, the way every OpenVibe library is pinned.
const INSTALL = `npm install -g https://codeload.github.com/OpenVibers/OpenVibe.Codes/tar.gz/refs/tags/v${VERSION}`;

/**
 * Community documents: Markdown in this repository (the same files GitHub shows), rendered as they are. A document
 * whose text starts with the draft line is shown with a draft notice, kept out of search engines and the sitemap;
 * removing that line after the owner's review publishes it.
 */
const GOVERNANCE = [
    { slug: 'code-of-conduct', file: 'CODE_OF_CONDUCT.md', blurb: 'how we treat each other, and how to report a problem' },
    { slug: 'contributing', file: 'CONTRIBUTING.md', blurb: 'how to report a bug, propose a change and open a pull request' },
    { slug: 'contributor-ladder', file: 'docs/governance/contributor-ladder.md', blurb: 'participant, contributor, reviewer, maintainer, owner' },
    { slug: 'moderation', file: 'docs/governance/moderation.md', blurb: 'what is moderated, the steps, and appeals' },
];
const DRAFT_LINE = /^\*\*Draft — pending owner review\.\*\*.*$/m;
function loadGovernance() {
    return GOVERNANCE.map((g) => {
        const text = fs.readFileSync(path.join(ROOT, g.file), 'utf8');
        const title = (text.match(/^# (.+)$/m) || [null, g.slug])[1].trim();
        const draft = DRAFT_LINE.test(text.split('\n').slice(0, 5).join('\n'));
        const body = text.replace(/^# .+\n/m, '').replace(DRAFT_LINE, '');
        return { ...g, title, draft, body };
    });
}

/**
 * The repositories OpenVibe is built from, as the pinned contracts' service manifests name them: the services that
 * run (by their site position), then the libraries every service shares. A manifest without a repository is skipped.
 */
function repositories() {
    const rows = contracts.services.manifests
        .filter((m) => m && typeof m.repository === 'string' && /^OpenVibers\/[A-Za-z0-9._-]+$/.test(m.repository))
        .filter((m) => m.exposure && ['live', 'library'].includes(m.exposure.state));
    const order = (m) => (m.site && m.site.position != null ? m.site.position : 50);
    const running = rows.filter((m) => m.exposure.state === 'live').sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
    const libraries = rows.filter((m) => m.exposure.state === 'library').sort((a, b) => a.name.localeCompare(b.name));
    return { running, libraries };
}

const FLAG_LABELS = { host_access: 'runs on your machine', mcp: 'MCP tools', long_autonomy: 'long autonomous runs', resume: 'resumes a session', review: 'reviews', vision: 'reads images' };
const flagsOf = (c) => Object.keys(FLAG_LABELS).filter((k) => c && c[k]).map((k) => FLAG_LABELS[k]);

function createPageRoutes(ctx) {
    const { config, harnesses } = ctx;
    const r = asyncRouter();
    const PUBLIC_CACHE = cache.htmlHeaders({ maxAge: 300 });
    const governance = loadGovernance();
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });

    // ── Home: code with any agent ───────────────────────────
    r.get('/', (req, res) => {
        const offers = harnesses.list();
        const tasks = Object.keys(placement.TASKS);
        const snippet = `$ openvibe-codes run "add a test for the date parser"
run run_20261008… · ~/my-project
▶ codex · session 0199…
! You have hit your usage limit.
⇢ handing over from codex: You have hit your usage limit.
▶ claude-code · session 4f2e…
  → Read src/date.js
  → Edit test/date.test.js
Added test/date.test.js: three cases, all pass.
✔ done (48 s · $0.0400 · 31k in / 1.2k out)`;
        page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            jsonLd: homeJsonLd(config),
            styles: [showcase.STYLESHEET],
            body: html`${raw(showcase.hero({
                eyebrow: 'OpenVibe.Codes · the open coding-agent harness · alpha',
                title: 'Code with', accent: 'any agent',
                lede: 'One open harness for Claude Code, Codex, OpenCode, Command Code, Aider, the DeepSeek API and models you host yourself: send a coding task to the agent that fits it, hand it over when one gets stuck, and keep the whole run in one place. Then point it at OpenVibe itself.',
                actions: [{ label: 'Install the harness', href: '/start', primary: true }, { label: 'Meet the agents', href: '/harnesses' }],
                note: `Open source (AGPL-3.0). Version ${VERSION} runs on your machine with the agents and keys you already have; nothing goes through OpenVibe. A hosted runner comes next; the list below says exactly what works.`,
                aside: { html: `<pre class="codes-hero-code"><code>${showcase.esc(snippet)}</code></pre>` },
            }))}
${raw(showcase.features({
                id: 'agents', title: 'The agents', lede: `${offers.length} harnesses in the catalog, each with the models it runs. Routing picks one by what the task needs first, then by cost.`,
                items: offers.map((o) => ({ title: o.name, text: [o.provider, ...flagsOf(o.capabilities).slice(0, 3)].join(' · '), href: `/harnesses#${o.id}` })),
            }))}
${raw(showcase.steps({
                title: 'How a task finds its agent',
                items: [
                    { title: 'Describe the task', text: `One of ${tasks.join(', ')}, plus anything it must have: a capability, a runtime, a ceiling on cost.` },
                    { title: 'Hard limits first', text: 'An agent that lacks a required capability is out, whatever it costs. Each refusal says why.' },
                    { title: 'Then the cheapest fit', text: 'Already-paid capacity and free allowances first, then price per token, through the same placement engine every OpenVibe service uses.' },
                    { title: 'Hand-offs', text: 'When an agent fails, hits its usage limit or goes quiet, the task moves to the next one with a note: the task, the files touched and the state of the tree.' },
                ],
            }))}
<section class="sc-sec" aria-labelledby="h-improve"><h2 id="h-improve">Improve OpenVibe</h2>
<p class="sc-lede">OpenVibe is built in the open, ${repositories().running.length} services and their shared libraries, every one on GitHub. Pick a repository, describe the change, and send a pull request; the harness's job is to make that one step.</p>
<p><a class="sc-btn sc-primary" href="/improve">Start contributing</a> <a class="sc-btn" href="/policy/contributing">Read the guide</a></p></section>
<section class="sc-sec" aria-labelledby="h-status"><h2 id="h-status">What works today</h2>
${table(['Piece', 'State'], [
                [html`<a href="/start">The harness on your machine</a> (<code>openvibe-codes</code>)`, `Live, ${VERSION}: runs a task on any of the seven agents with your CLIs and keys, streams one event format, keeps every run to show or resume.`],
                ['Hand-offs between agents', 'Live: a failed, rate-limited or silent agent hands the task to the next one with a note on what was done.'],
                [html`<a href="/harnesses">The agent catalog</a>`, 'Live: every harness and model with its capabilities, prices and limits.'],
                [html`<code>GET /api/v1/harnesses</code>, <code>POST /api/v1/harnesses/route</code>`, 'Live: public, no key needed; per-address and per-caller limits.'],
                ['A hosted runner: tasks on OpenVibe\'s machines, with budgets', 'Next, on OpenVibe.Run workers.'],
                ['OpenVibe.Actor using Codes for its coding work', 'Next: Actor is OpenVibe\'s general agent; Codes is the part of it that writes code.'],
                [html`Improve OpenVibe from here: repository → change → tests → review → pull request`, 'Planned. Today: the harness plus the contributor path on GitHub, below.'],
            ])}</section>
${raw(showcase.cta({ title: 'Building an app instead?', text: 'Projects, keys, grants and the API docs of every OpenVibe service live on OpenVibe.Services.', actions: [{ label: 'Open the developer platform', href: SERVICES_ORIGIN, primary: true }, { label: 'Meet the agents', href: '/harnesses' }] }))}`,
        });
    });

    // ── Getting started: the harness on your own machine (bin/openvibe-codes.js, harness/) ──
    r.get('/start', (req, res) => {
        const example = `$ openvibe-codes agents
✔ claude-code        Claude Code      ~/.local/bin/claude
✔ codex              Codex            ~/.local/bin/codex
· aider              Aider            \`aider\` is not on PATH (install Aider)
· deepseek           DeepSeek         set DEEPSEEK_API_KEY

$ cd my-project
$ openvibe-codes run "rename getUser to findUser everywhere"
$ openvibe-codes run --permission read "where is the session cookie set?"
$ openvibe-codes runs
$ openvibe-codes resume run_… "now add a test"`;
        const fromCode = `const { createHarness } = require('openvibe-codes');

const harness = createHarness();          // your PATH, your keys
for await (const event of harness.run({ prompt: 'fix the failing test', cwd: '.' })) {
    if (event.type === 'result') console.log(event.is_error ? 'failed' : 'done', event.result);
}`;
        const events = `{"type":"system","subtype":"init","agent":"codex","session_id":"0199…","run_id":"run_…"}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","content":"…","is_error":false}]}}
{"type":"system","subtype":"handoff","from":"codex","reason":"You have hit your usage limit."}
{"type":"result","subtype":"success","is_error":false,"result":"…","total_cost_usd":0.04,"usage":{…}}`;
        page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            title: 'Get started with the coding-agent harness',
            description: 'Install openvibe-codes and run coding tasks on Claude Code, Codex, OpenCode, Command Code, Aider, the DeepSeek API or your own model, with hand-offs between them, from your terminal or your own code.',
            crumbs: [{ label: 'Get started' }],
            body: html`<h1>Get started</h1>
<p><code>openvibe-codes</code> runs a coding task on whichever agent fits it, hands it to the next one when an agent fails, hits its limit or goes quiet, and keeps the whole run. It runs on your machine with the agents and keys you already have: nothing goes through OpenVibe, and it needs no account.</p>
<h2 id="install">Install</h2>
<p>Node.js 22 or newer, then:</p>
<pre><code>${INSTALL}</code></pre>
<p>Or from a clone: <code>git clone ${GITHUB}/OpenVibe.Codes</code>, <code>npm ci</code>, then <code>node bin/openvibe-codes.js</code>. Check what it found with <code>openvibe-codes agents</code>.</p>
<h2 id="agents">The agents it can use</h2>
<p>Install any of them; the harness uses what is there and says why the rest are not.</p>
${table(['Agent', 'What it needs'], [
                [html`<a href="/harnesses#claude-code">Claude Code</a>`, html`<code>claude</code> on PATH, signed in`],
                [html`<a href="/harnesses#codex">Codex</a>`, html`<code>codex</code> on PATH, signed in`],
                [html`<a href="/harnesses#opencode">OpenCode</a>`, html`<code>opencode</code> on PATH`],
                [html`<a href="/harnesses#command-code">Command Code</a>`, html`<code>cmd</code> on PATH`],
                [html`<a href="/harnesses#aider">Aider</a>`, html`<code>aider</code> on PATH`],
                [html`<a href="/harnesses#deepseek">DeepSeek</a>`, html`<code>DEEPSEEK_API_KEY</code>; the harness runs its own agent loop against the API`],
                [html`<a href="/harnesses#openai-compatible">Your own model</a>`, html`<code>OPENVIBE_CODES_BASE_URL</code> (an OpenAI-compatible server: llama.cpp, vLLM, Ollama, LM Studio…), <code>OPENVIBE_CODES_MODEL</code>, and <code>OPENVIBE_CODES_API_KEY</code> if it wants one`],
            ])}
<h2 id="use">Use it</h2>
<pre><code>${example}</code></pre>
${table(['Command', 'What it does'], [
                [html`<code>agents</code>`, 'Which agents this machine can run, and why not the others.'],
                [html`<code>route [--task edit] [--need harness:resume]</code>`, 'Which agent a task would go to, with the reason for every candidate.'],
                [html`<code>run [options] "task"</code>`, html`Run a task. <code>--agent</code> skips routing, <code>--model</code> picks the first agent's model, <code>--cwd</code> sets where it works, <code>--attempts</code> caps the hand-offs (default 3), <code>--no-handoff</code> stops at the first result, <code>--json</code> prints the events. A task of <code>-</code> is read from stdin.`],
                [html`<code>runs</code>`, 'The latest runs on this machine.'],
                [html`<code>show &lt;run id&gt; [--json]</code>`, 'One run: each attempt, its session and the result; every event with --json.'],
                [html`<code>resume &lt;run id&gt; "follow-up"</code>`, 'Continue the run\'s last session with the same agent.'],
            ])}
<p>The exit code follows the result: 0 when the last agent finished, 1 when it did not.</p>
<h2 id="permission">Permission levels</h2>
${table(['Level', 'What the agent may do'], [
                [html`<code>read</code>`, 'Look and answer. Claude Code runs in plan mode, Codex in its read-only sandbox, the API agents get only list, read and search tools.'],
                [html`<code>edit</code> (default)`, html`Change files in the working directory. Claude Code accepts edits and is refused <code>git push</code>; Codex runs in its workspace-write sandbox; the API agents can write and edit files but not run commands.`],
                [html`<code>full</code>`, 'Anything, unattended, including running commands. Use it in a container, a VM or a throwaway checkout.'],
            ])}
<p>The built-in API agent never leaves the working directory, never reads a <code>.env</code> file and never writes under <code>.git</code>, at any level.</p>
<h2 id="handoffs">Hand-offs</h2>
<p>When an attempt fails, hits a usage limit, crashes or prints nothing for a while, the harness stops it and gives the task to the next agent the router picks, leaving out the ones already tried. The next agent gets a note: the original task, which agent tried and why it stopped, the tools it used, the files it changed, its last message and <code>git status</code>. Every attempt is in the run.</p>
<h2 id="events">One event format</h2>
<p>Every agent's output becomes the same events: one JSON object per line with <code>--json</code>, the same shape as Claude Code's <code>stream-json</code>, ending with exactly one <code>result</code>. Keys and tokens in an agent's output are redacted before an event is printed or kept.</p>
<pre><code>${events}</code></pre>
<h2 id="runs">Where runs are kept</h2>
<p>In <code>$OPENVIBE_CODES_HOME</code>, else <code>$XDG_STATE_HOME/openvibe-codes</code>, else <code>~/.local/state/openvibe-codes</code>: one directory per run with its attempts and events, readable only by you.</p>
<h2 id="code">From your own code</h2>
<pre><code>${fromCode}</code></pre>
<p><code>harness.agents()</code>, <code>harness.route({ task })</code> and <code>harness.run({ prompt, cwd, agent, permission, handoff })</code> are what the command line uses. The router is the same one behind <a href="/api/v1/harnesses"><code>/api/v1/harnesses/route</code></a>.</p>
<h2 id="next">What comes next</h2>
<p>A hosted runner on OpenVibe.Run workers for people who would rather not run agents themselves, with budgets; OpenVibe.Actor using Codes for its coding work; and <a href="/improve">Improve OpenVibe</a> as a guided run: pick a repository, describe the change, get a pull request.</p>`,
        });
    });

    // ── The agent catalog (server/data/harness-offers.json, validated at boot) ──
    // No address target that is a local path is ever shown — only the address kind.
    const isLocalPath = (t) => /^(?:[A-Za-z]:[\\/]|[~/]|\.\.?[\\/])/.test(String(t || ''));
    const addressOf = (o) => {
        const kind = (o.address && o.address.kind) || '—';
        const target = o.address && o.address.target;
        return target && !isLocalPath(target) ? html`${kind} <code>${target}</code>` : kind;
    };
    const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
    const duration = (n) => (n >= 3600 && n % 3600 === 0 ? `${n / 3600} h` : `${n} s`);
    const count = (n) => Number(n).toLocaleString('en-US');
    r.get('/harnesses', (req, res) => {
        const offers = harnesses.list();
        page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            title: 'The coding agents',
            description: 'Claude Code, Codex, OpenCode, Command Code, Aider and the DeepSeek API: every coding harness OpenVibe.Codes routes a task to, with its models, capabilities, prices and limits.',
            crumbs: [{ label: 'Agents' }],
            body: html`<h1>The coding agents</h1>
<p>A task is routed with <code>POST /api/v1/harnesses/route</code> over <code>openvibe-sdk/placement</code>, which picks an offer from this catalog: hard requirements first (a capability the task needs), then cost. The catalog is read and validated when Codes starts; every price and limit is as the offer states it. Machine-readable: <a href="/api/v1/harnesses"><code>GET /api/v1/harnesses</code></a>.</p>
${table(['Harness', 'Provider', 'Address', 'Can', 'Price', 'Limits'], offers.map((o) => [
                html`<strong id="${o.id}">${o.name}</strong><br><code>${o.id}</code>`,
                o.provider,
                addressOf(o),
                flagsOf(o.capabilities).join(', ') || '—',
                `${usd(o.price.amount_usd)} / ${o.price.unit}`,
                `${duration(o.limits.max_duration_seconds)}, ${count(o.limits.max_concurrent_runs)} concurrent, ${count(o.limits.max_context_tokens)} context tokens`,
            ]))}
<h2>Models</h2>
${offers.map((o) => html`<h3>${o.name} <code>${o.id}</code></h3>${o.agents.length
                ? table(['Provider', 'Model', 'Context (in / out)', 'Price per 1k tokens'], o.agents.map((a) => [
                    a.provider,
                    a.model,
                    `${count(a.context_limits.input_tokens)} / ${count(a.context_limits.output_tokens)}`,
                    `${usd(a.price_per_1k_tokens.fresh_usd)} fresh, ${usd(a.price_per_1k_tokens.cached_usd)} cached, ${usd(a.price_per_1k_tokens.output_usd)} output`,
                ]))
                : html`<p class="muted">no models yet</p>`}`)}`,
        });
    });

    // ── Improve OpenVibe ─────────────────────────────────────
    r.get('/improve', (req, res) => {
        const { running, libraries } = repositories();
        const repoCards = (list) => html`<ul class="cards">${list.map((m) => html`<li><a href="${GITHUB}/${m.repository.split('/')[1]}"><strong>${m.repository.split('/')[1]}</strong></a><span>${(m.site && (m.site.tagline || m.site.what)) || m.name}</span></li>`)}</ul>`;
        page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            title: 'Improve OpenVibe',
            description: 'OpenVibe is open source: every service and library is on GitHub. How to pick a repository, make a change, run its tests and open a pull request, and the community rules that apply.',
            crumbs: [{ label: 'Improve OpenVibe' }],
            body: html`<h1>Improve OpenVibe</h1>
<p>Every OpenVibe service and library is open source under <a href="${GITHUB}">OpenVibers</a> on GitHub, and changes arrive as pull requests that the owner approves. You can do it by hand today; the harness will take the same path for you: repository → change → tests → independent review → pull request, never straight to <code>main</code>.</p>
<ol class="steps">
<li><strong>Pick a repository</strong> from the lists below, or find the page you want to change and follow its "source" link.</li>
<li><strong>Read its README</strong>: what it owns, how to run it, and its tests (<code>npm test</code> runs them on temporary databases; nothing needs a live service).</li>
<li><strong>Make the change</strong> on a branch, with a test that would have failed before it.</li>
<li><strong>Open a pull request</strong> that says what changes for people and why. CI runs the tests, an audit and a secret scan.</li>
<li><strong>Review</strong>: a maintainer reviews it; the owner approves what ships. See the <a href="/policy/contributor-ladder">contributor ladder</a> for how reviewers and maintainers are chosen.</li>
</ol>
<p>Before you start: the <a href="/policy/contributing">contributing guide</a> and the <a href="/policy/code-of-conduct">code of conduct</a>. Building your own app on OpenVibe instead? That is <a href="${SERVICES_ORIGIN}">OpenVibe.Services</a>.</p>
<h2>Services that run</h2>
${repoCards(running)}
<h2>Shared libraries</h2>
${repoCards(libraries)}`,
        });
    });

    // ── Community documents and the update log ───────────────
    // What shipped on OpenVibe.Codes: the shared update log every OpenVibe site has.
    r.get('/updates', (req, res) => page(req, res, { index: true, cache: PUBLIC_CACHE, title: 'What shipped on OpenVibe.Codes', body: raw(frame.updatesBody({ service: 'codes', siteName: 'OpenVibe.Codes' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`) }));
    r.get('/policy', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE, title: 'Community', crumbs: [{ label: 'Community' }],
        body: html`<h1>Community</h1>
<p>The rules for everyone who builds OpenVibe and everything published on it: the repositories, and the apps and releases on OpenVibe.Services.</p>
<ul class="cards">
${governance.map((g) => html`<li><a href="/policy/${g.slug}"><strong>${g.title}</strong></a><span>${g.blurb}${g.draft ? ' (draft, pending owner review)' : ''}</span></li>`)}</ul>
<p class="muted">The platform's own policy (how a contract or capability changes, compatibility and deprecation, licensing, transparency) is on <a href="${SERVICES_ORIGIN}/policy">OpenVibe.Services</a>.</p>`,
    }));

    for (const g of governance) {
        r.get(`/policy/${g.slug}`, (req, res) => page(req, res, {
            index: !g.draft, cache: PUBLIC_CACHE, title: g.title, crumbs: [{ label: 'Community', href: '/policy' }, { label: g.title }],
            body: html`<h1>${g.title}</h1>
${g.draft ? notice(html`<strong>Draft — pending owner review.</strong> This is a proposal, not yet in effect. It takes effect when the owner of the OpenVibers organization approves it.`, 'warn') : ''}
<article class="prose">${raw(markdown(g.body, { headingOffset: 0 }))}</article>
<p class="muted small">Source: <a href="${GITHUB}/OpenVibe.Codes/blob/main/${g.file}"><code>${g.file}</code></a>. Changes go through a pull request that the owner approves.</p>`,
        }));
    }

    // ── Discovery: robots.txt, sitemap.xml, llms.txt, llms-full.txt (http/discovery.js, openvibe-shared/seo) ──
    r.use(createDiscoveryRoutes({ ...ctx, governance }));

    return r;
}

module.exports = { createPageRoutes, GOVERNANCE, repositories };
