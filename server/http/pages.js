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
const express = require('express');
const contracts = require('openvibe-contracts');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd, SERVICES_ORIGIN } = require('./discovery');
const { html, raw, table, notice } = require('../render/html');
const kit = require('openvibe-shared/kit');
const { send } = require('../render/layout');
const { markdown } = require('../render/markdown');
const placement = require('../domain/harness-placement');
const { parseArgs } = require('../../harness/job');
const home = require('./home');
const seo = require('openvibe-shared/seo');

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
    const { config, harnesses, sso, store, run, log = console } = ctx;
    const r = asyncRouter();
    const PUBLIC_CACHE = cache.htmlHeaders({ maxAge: 300 });
    const governance = loadGovernance();
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    // OpenVibe Git's public repositories for the home (read in the background, never awaited here); tests set ctx.git.
    const gitReader = home.createGitReader({ internalUrl: config.git.internalUrl, publicUrl: config.git.publicUrl, enabled: config.nodeEnv !== 'test' });

    // ── Home: code with any agent ───────────────────────────
    function homePage() {
        const offers = harnesses.list();
        const tasks = Object.keys(placement.TASKS);
        // What a run prints (bin/openvibe-codes.js), as an example: Codex hits its limit and Claude Code finishes.
        const snippet = `# an example run: one agent hits its limit, the next one finishes
$ openvibe-codes run "add a test for the date parser"
run run_20261008… · ~/my-project
▶ codex · session 0199…
! You have hit your usage limit.
⇢ handing over from codex: You have hit your usage limit.
▶ claude-code · session 4f2e…
  → Read src/date.js
  → Edit test/date.test.js
Added test/date.test.js: three cases, all pass.
✔ done (48 s · $0.0400 · 31k in / 1.2k out)`;
        return {
            agent: true, index: true, cache: PUBLIC_CACHE,
            jsonLd: [...homeJsonLd(config), seo.jsonLd.faq(home.faqPairs())],
            styles: [showcase.STYLESHEET],
            body: html`${raw(showcase.hero({
                eyebrow: 'OpenVibe.Codes · the open coding-agent harness · alpha',
                title: 'Code with', accent: 'any agent',
                lede: 'One open harness for Claude Code, Codex, OpenCode, Command Code, Aider, the DeepSeek API and models you host yourself: send a coding task to the agent that fits it, hand it over when one gets stuck, and keep the whole run in one place. Then point it at OpenVibe itself.',
                actions: [{ label: 'Install the harness', href: '/start', primary: true }, { label: 'Run on your machine from the web', href: '/run' }, { label: 'Meet the agents', href: '/harnesses' }],
                note: `Open source (AGPL-3.0). Version ${VERSION} runs on your machine with the agents and keys you already have, from your terminal or started from this site in any browser; the list below says exactly what works.`,
                aside: { html: `<pre tabindex="0" class="codes-hero-code"><code>${showcase.esc(snippet)}</code></pre>` },
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
${raw(home.quickStart({ install: INSTALL }))}
${raw(home.gitSection((ctx.git || gitReader).peek()))}
<section class="sc-sec" aria-labelledby="h-improve"><h2 id="h-improve">Improve OpenVibe</h2>
<p class="sc-lede">OpenVibe is built in the open, ${repositories().running.length} services and their shared libraries, every one on GitHub. Pick a repository, describe the change, and send a pull request; the harness's job is to make that one step.</p>
<p><a class="sc-btn sc-primary" href="/improve">Start contributing</a> <a class="sc-btn" href="/policy/contributing">Read the guide</a></p></section>
<section class="sc-sec" aria-labelledby="h-status"><h2 id="h-status">What works today</h2>
${table(['Piece', 'State'], [
                [html`<a href="/start">The harness on your machine</a> (<code>openvibe-codes</code>)`, `Live, ${VERSION}: runs a task on any of the eight agents with your CLIs and keys, streams one event format, keeps every run to show or resume.`],
                ['Hand-offs between agents', 'Live: a failed, rate-limited or silent agent hands the task to the next one with a note on what was done.'],
                [html`<a href="/run">Run on your machine</a>: start a task in any browser, your phone included; your own computer runs it`, 'Live: add your machine on openvibe.bot/machines (one command), then watch the task live here and get the patch, a branch or a pull request. It runs only on your own machines, in the Node\'s job sandbox.'],
                [html`<a href="/harnesses">The agent catalog</a>`, 'Live: every harness and model with its capabilities, prices and limits.'],
                [html`<code>GET /api/v1/harnesses</code>, <code>POST /api/v1/harnesses/route</code>`, 'Live: public, no key needed; per-address and per-caller limits.'],
                [html`<a href="/improve">Improve OpenVibe</a>: a repository, a change on a branch with its test, a pull request that CI checks and a maintainer reviews`, 'Live: pick a repository, describe the change, and start a guided run on your machine.'],
                [html`<a href="${config.git.publicUrl}/">OpenVibe Git</a>: OpenVibe's own code forge`, 'Live: every public OpenVibe repository, mirrored from GitHub hourly, with OpenVibe sign-in and HTTPS cloning. GitHub stays canonical until a repository moves here.'],
            ])}</section>
${raw(home.faq())}
${raw(showcase.network({ service: 'codes' }))}
${raw(showcase.cta({ title: 'Building an app instead?', text: 'Projects, keys, grants and the API docs of every OpenVibe service live on OpenVibe.Services.', actions: [{ label: 'Open the developer platform', href: SERVICES_ORIGIN, primary: true }, { label: 'Meet the agents', href: '/harnesses' }] }))}`,
        };
    }
    r.get('/', (req, res) => page(req, res, homePage()));

    // ── Getting started: the harness on your own machine (bin/openvibe-codes.js, harness/) ──
    function startPage() {
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
        return {
            agent: true, index: true, cache: PUBLIC_CACHE,
            title: 'Get started with the coding-agent harness',
            description: 'Install openvibe-codes and run coding tasks on Claude Code, Codex, OpenCode, Command Code, Aider, the DeepSeek API or your own model, with hand-offs between them, from your terminal or your own code.',
            crumbs: [{ label: 'Get started' }],
            body: html`<h1>Get started</h1>
<p><code>openvibe-codes</code> runs a coding task on whichever agent fits it, hands it to the next one when an agent fails, hits its limit or goes quiet, and keeps the whole run. It runs on your machine with the agents and keys you already have: nothing goes through OpenVibe, and it needs no account.</p>
<h2 id="install">Install</h2>
<p>Node.js 22 or newer, then:</p>
<pre tabindex="0"><code>${INSTALL}</code></pre>
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
                [html`<a href="/harnesses#openvibe-ai">OpenVibe.AI</a>`, html`<code>OPENVIBE_APP_ID</code> and <code>OPENVIBE_APP_SECRET</code> (an app of your project on openvibe.services with <code>ai.app.run</code>), or a Network token in <code>OPENVIBE_AI_TOKEN</code>. For tool-capable models, keep your provider's key as a project secret granted to <code>ai</code> and name it in <code>OPENVIBE_AI_SECRET</code>, with <code>OPENVIBE_AI_PROVIDER_URL</code> and <code>OPENVIBE_AI_PROVIDER_MODEL</code>: the key never sits on this machine`],
                [html`<a href="/harnesses#openai-compatible">Your own model</a>`, html`<code>OPENVIBE_CODES_BASE_URL</code> (an OpenAI-compatible server: llama.cpp, vLLM, Ollama, LM Studio…), <code>OPENVIBE_CODES_MODEL</code>, and <code>OPENVIBE_CODES_API_KEY</code> if it wants one`],
            ])}
<h2 id="use">Use it</h2>
<pre tabindex="0"><code>${example}</code></pre>
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
<pre tabindex="0"><code>${events}</code></pre>
<h2 id="runs">Where runs are kept</h2>
<p>In <code>$OPENVIBE_CODES_HOME</code>, else <code>$XDG_STATE_HOME/openvibe-codes</code>, else <code>~/.local/state/openvibe-codes</code>: one directory per run with its attempts and events, readable only by you.</p>
<h2 id="code">From your own code</h2>
<pre tabindex="0"><code>${fromCode}</code></pre>
<p><code>harness.agents()</code>, <code>harness.route({ task })</code> and <code>harness.run({ prompt, cwd, agent, permission, handoff })</code> are what the command line uses. The router is the same one behind <a href="/api/v1/harnesses"><code>/api/v1/harnesses/route</code></a>.</p>
<h2 id="next">What comes next</h2>
<p>Tasks from the web already run on your own machine (<a href="/run">Run on your machine</a>). Next: a hosted runner on OpenVibe.Run workers for people who would rather not run agents themselves, with budgets; OpenVibe.Actor using Codes for its coding work; and <a href="/improve">Improve OpenVibe</a> as a guided run: pick a repository, describe the change, get a pull request.</p>`,
        };
    }
    r.get('/start', (req, res) => page(req, res, startPage()));

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
    function harnessesPage() {
        const offers = harnesses.list();
        return {
            agent: true, index: true, cache: PUBLIC_CACHE,
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
        };
    }
    r.get('/harnesses', (req, res) => page(req, res, harnessesPage()));

    // ── Improve OpenVibe ─────────────────────────────────────
    const knownRepo = (owner, name) => {
        const full = `${owner}/${name}`;
        return contracts.services.manifests.find((m) => m && m.repository === `OpenVibers/${name}` && m.repository === `OpenVibers/${name}` ? full === m.repository : false) || null;
    };
    const repoMeta = () => contracts.services.manifests
        .filter((m) => m && typeof m.repository === 'string' && /^OpenVibers\/[A-Za-z0-9._-]+$/.test(m.repository) && m.exposure && ['live', 'library'].includes(m.exposure.state));
    const repoGroups = () => {
        const rows = repoMeta();
        const order = (m) => (m.site && m.site.position != null ? m.site.position : 50);
        const running = rows.filter((m) => m.exposure.state === 'live').sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
        const libraries = rows.filter((m) => m.exposure.state === 'library').sort((a, b) => a.name.localeCompare(b.name));
        return { running, libraries };
    };
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const sameOrigin = (req) => {
        const origin = req.get('origin');
        if (!origin) return true;
        try { return new URL(origin).origin === new URL(config.baseUrl).origin; } catch { return false; }
    };
    const projectsOf = async (req, res) => {
        const list = await sso.asViewer(req, res, async (token) => {
            const out = await fetch(`${config.networkInternalUrl}/api/v1/projects`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
            if (out.status === 401) { const e = new Error('expired'); e.status = 401; throw e; }
            if (!out.ok) throw new Error(`Network answered ${out.status}`);
            return (await out.json()).projects || [];
        });
        const delegable = new Set(['owner', 'admin']);
        return list.filter((p) => delegable.has(p.role) && !p.archived_at).map((p) => ({ id: p.id, name: p.name }));
    };
    const ensureProject = async (req, res) => {
        const projects = await projectsOf(req, res);
        if (projects.length) return projects[0].id;
        const created = await sso.asViewer(req, res, async (token) => {
            const out = await fetch(`${config.networkInternalUrl}/api/v1/projects`, {
                method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ name: 'My code' }), signal: AbortSignal.timeout(8000),
            });
            if (out.status === 401) { const e = new Error('expired'); e.status = 401; throw e; }
            if (!out.ok) throw new Error(`Network answered ${out.status}`);
            return out.json();
        });
        return created.id;
    };
    const repoForgejoUrl = (owner, name) => `${config.git.publicUrl}/${owner}/${name}`;
    const repoCloneUrl = (owner, name) => `${config.git.publicUrl}/${owner}/${name}.git`;

    // The four steps of every change; the index is step 1, a repository's page is step 2.
    const IMPROVE_STEPS = [
        { label: 'Pick a repository', href: '/improve' },
        { label: 'Describe the change', note: 'the harness runs it on your machine' },
        { label: 'Review the result', note: 'then open the pull request' },
        { label: 'A maintainer reviews', note: 'the owner approves what ships' },
    ];
    const improveSteps = (at) => kit.steps({ label: 'From a change to a pull request', current: at, items: IMPROVE_STEPS });
    const shortName = (m) => m.repository.split('/')[1].replace(/^OpenVibe\./, '');
    const tagline = (m) => (m.site && (m.site.tagline || m.site.what)) || m.name;

    /** Step 1: pick the repository. One search box (it works without JavaScript: ?q=), then every repository as a row. */
    function improvePage(q = '') {
        const { running, libraries } = repoGroups();
        const needle = String(q || '').trim().toLowerCase().slice(0, 60);
        const hit = (m) => !needle || [m.repository, m.name, tagline(m)].some((t) => String(t || '').toLowerCase().includes(needle));
        const rows = (list) => list.filter(hit).map((m) => kit.row({ href: `/improve/${m.repository}`, title: shortName(m), sub: tagline(m), trail: kit.icon('chevron') }));
        const services = rows(running), libs = rows(libraries);
        const found = services.length + libs.length;
        const lists = !found
            ? kit.empty({ icon: 'search', title: `No repository matches “${needle}”`, text: 'Try a site\'s name (chat, video, games) or what it does.', action: { href: '/improve', label: 'Every repository' } })
            : (services.length ? kit.list(services, { title: `Services · ${services.length}` }) : '') + (libs.length ? kit.list(libs, { title: `Shared libraries · ${libs.length}` }) : '');
        return {
            agent: true, index: !needle, cache: PUBLIC_CACHE,
            styles: ['kit.css'], sharedScripts: ['kit-web.js'],
            title: 'Improve OpenVibe',
            description: 'OpenVibe is open source: every service and library is on GitHub. Pick a repository, describe the change, and send a pull request; the harness makes the change on your machine.',
            body: html`${raw(kit.head({ title: 'Improve OpenVibe', sub: 'All open source. Pick one, describe a change.', sticky: false }))}
${raw(improveSteps(0))}
${raw(kit.find({ action: '/improve', name: 'q', value: needle, placeholder: 'Find: chat, video, games…', label: 'Find a repository' }))}
${raw(lists)}
<p class="ovk-muted">Changes arrive as pull requests the owner approves — never straight to <code>main</code>. Before you start: the <a href="/policy/contributing">contributing guide</a>, the <a href="/policy/code-of-conduct">code of conduct</a> and the <a href="/policy/contributor-ladder">contributor ladder</a>. Building your own app instead? That is <a href="${SERVICES_ORIGIN}">OpenVibe.Services</a>.</p>`,
        };
    }
    r.get('/improve', (req, res) => page(req, res, improvePage(req.query && req.query.q)));

    async function improveRepoPage(owner, name, { signed = false } = {}) {
        const meta = repoMeta().find((m) => m.repository === `${owner}/${name}`);
        if (!meta) return null;
        let forgejoInfo = null;
        let forgejoError = null;
        if (signed) {
            try { forgejoInfo = await ctx.forgejo.getRepo(owner, name); } catch (e) { forgejoError = e.code === 'forgejo.unconfigured' ? null : e.message; }
        }
        const agents = harnesses.list();
        const opt = (v, label, sel) => html`<option value="${v}"${sel ? raw(' selected') : ''}>${label}</option>`;
        const form = signed ? html`<form class="run-card run-form" method="post" action="/improve/start">
<input type="hidden" name="repo" value="${repoForgejoUrl(owner, name)}">
<input type="hidden" name="ref" value="${(forgejoInfo && forgejoInfo.default_branch) || 'main'}">
<h2>Start a guided run</h2>
${forgejoError ? html`<p class="run-notice run-notice-error" role="alert">OpenVibe Git is not reachable right now (${forgejoError}); you can still start a run on your machine.</p>` : ''}
<label class="run-field"><span>What should the agent change?</span><textarea name="prompt" rows="5" required maxlength="16000" placeholder="Add a test for the date parser and fix what it finds"></textarea></label>
<div class="run-field-row">
<label class="run-field"><span>Agent</span><select name="agent">${opt('', 'Any: the best fit, with hand-offs', true)}${agents.map((a) => opt(a.id, a.name))}</select></label>
<label class="run-field"><span>It may</span><select name="permission">${opt('edit', 'Edit files', true)}${opt('full', 'Run anything (tests, installs)', false)}</select></label>
</div>
<label class="run-check"><input type="checkbox" name="push" value="1" checked> Push the change to a new branch on OpenVibe Git <small>(needs a token on your machine; never the branch it started from)</small></label>
<label class="run-check"><input type="checkbox" name="pull_request" value="1" checked> and open a pull request</label>
<button class="run-btn run-btn-primary" type="submit">Start on my machine</button>
</form>` : html`<p class="ovk-muted">Say what should change, in plain words. The harness makes the change on your machine, runs the tests, and can open the pull request.</p><p>${raw(kit.button({ href: `/auth/login?next=${encodeURIComponent(`/improve/${owner}/${name}`)}`, label: 'Sign in to describe a change', icon: 'user' }))}</p>`;
        return {
            agent: true, index: true, cache: PUBLIC_CACHE,
            title: `Improve ${name}`,
            description: `Contribute to ${meta.name}: describe a change and run it on your machine through OpenVibe.Codes.`,
            crumbs: [{ label: 'Improve OpenVibe', href: '/improve' }, { label: meta.name }],
            styles: ['kit.css'], sharedScripts: ['kit-web.js'],
            body: html`${raw(kit.head({ title: meta.name, sub: tagline(meta), sticky: false }))}
${raw(improveSteps(1))}
${form}
${raw(kit.fold({ title: 'How the run works', body: '<ol class="steps"><li>The harness clones the repository onto <strong>your machine</strong> and checks out the default branch.</li><li>The agent makes the change you described and runs the tests.</li><li>If you asked it to push, it commits to a new branch and opens a pull request on OpenVibe Git.</li><li>You review the result, then the maintainers review the pull request.</li></ol>' }))}
${raw(kit.fold({ title: 'Clone it yourself', meta: 'git clone', body: `${kit.snippet({ code: `git clone ${repoCloneUrl(owner, name)}`, id: 'clone-cmd' })}<p class="ovk-muted">Browse it at <a href="${kit.esc(repoForgejoUrl(owner, name))}">${kit.esc(repoForgejoUrl(owner, name))}</a> or on <a href="${kit.esc(`${GITHUB}/${name}`)}">GitHub</a>.</p>` }))}`,
        };
    }
    r.get('/improve/:owner/:name', async (req, res) => {
        const out = await improveRepoPage(req.params.owner, req.params.name, { signed: signedIn(req) });
        if (!out) return page(req, res, { title: 'Not found', body: html`<h1>Not found</h1><p>No such OpenVibe repository. <a href="/improve">All repositories</a></p>` }, 404);
        page(req, res, out);
    });

    r.post('/improve/start', express.urlencoded({ extended: false, limit: '32kb' }), async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent('/improve')}`);
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        const b = req.body || {};
        const repo = String(b.repo || '').trim();
        const m = /^https:\/\/([^/]+)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/?$/.exec(repo);
        const meta = m && repoMeta().find((x) => x.repository === `${m[2]}/${m[3]}`);
        if (!meta) return page(req, res, { title: 'Not found', body: html`<h1>Not found</h1><p>Pick a repository from <a href="/improve">Improve OpenVibe</a>.</p>` }, 404);
        const owner = m[2];
        const name = m[3];
        const prompt = String(b.prompt || '');
        const agent = String(b.agent || '').trim();
        const permission = b.permission === 'full' ? 'full' : 'edit';
        const push = b.push === '1';
        const pullRequest = push && b.pull_request === '1';
        let args;
        try {
            if (agent && !harnesses.list().some((a) => a.id === agent)) throw new Error('choose an agent from the list');
            args = parseArgs(JSON.stringify({
                repo, ref: String(b.ref || '').trim() || null, prompt, agent: agent || null, permission,
                ...(push ? { push: { branch: `openvibe-codes/improve-${Date.now().toString(36)}`, pull_request: pullRequest } } : {}),
            }));
        } catch (e) {
            return page(req, res, {
                title: `Improve ${name}`,
                body: html`<h1>Improve ${name}</h1><p class="run-notice run-notice-error">Check the form: ${e.message}.</p><p><a href="/improve/${owner}/${name}">Back</a></p>`,
            }, 422);
        }
        let project;
        try {
            project = await ensureProject(req, res);
        } catch (e) {
            return page(req, res, {
                title: `Improve ${name}`,
                body: html`<h1>Improve ${name}</h1><p class="run-notice run-notice-error">Could not get or create a project (${e.message}).</p><p><a href="/improve/${owner}/${name}">Back</a></p>`,
            }, e.status === 401 ? 401 : 502);
        }
        const { createRunTasks } = require('../domain/run-tasks');
        const taskStore = createRunTasks({ store, run, config, log });
        const row = await taskStore.start({ subject: req.viewer.subject, project, args });
        return res.redirect(303, `/run/tasks/${row.id}`);
    });

    // ── Community documents and the update log ───────────────
    // What shipped on OpenVibe.Codes: the shared update log every OpenVibe site has.
    const updatesPage = () => ({ agent: true, index: true, cache: PUBLIC_CACHE, title: 'What shipped on OpenVibe.Codes', body: raw(frame.updatesBody({ service: 'codes', siteName: 'OpenVibe.Codes' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`) });
    r.get('/updates', (req, res) => page(req, res, updatesPage()));
    const policyIndexPage = () => ({
        agent: true, index: true, cache: PUBLIC_CACHE, title: 'Community', crumbs: [{ label: 'Community' }],
        body: html`<h1>Community</h1>
<p>The rules for everyone who builds OpenVibe and everything published on it: the repositories, and the apps and releases on OpenVibe.Services.</p>
<ul class="cards">
${governance.map((g) => html`<li><a href="/policy/${g.slug}"><strong>${g.title}</strong></a><span>${g.blurb}${g.draft ? ' (draft, pending owner review)' : ''}</span></li>`)}</ul>
<p class="muted">The platform's own policy (how a contract or capability changes, compatibility and deprecation, licensing, transparency) is on <a href="${SERVICES_ORIGIN}/policy">OpenVibe.Services</a>.</p>`,
    });
    r.get('/policy', (req, res) => page(req, res, policyIndexPage()));

    const policyDocPage = (g) => ({
            agent: true, index: !g.draft, cache: PUBLIC_CACHE, title: g.title, crumbs: [{ label: 'Community', href: '/policy' }, { label: g.title }],
            body: html`<h1>${g.title}</h1>
${g.draft ? notice(html`<strong>Draft — pending owner review.</strong> This is a proposal, not yet in effect. It takes effect when the owner of the OpenVibers organization approves it.`, 'warn') : ''}
<article class="prose">${raw(markdown(g.body, { headingOffset: 0 }))}</article>
<p class="muted small">Source: <a href="${GITHUB}/OpenVibe.Codes/blob/main/${g.file}"><code>${g.file}</code></a>. Changes go through a pull request that the owner approves.</p>`,
    });
    for (const g of governance) r.get(`/policy/${g.slug}`, (req, res) => page(req, res, policyDocPage(g)));

    // The public pages the agent layer's Markdown twins (server/agent-pages.js) render with the same builders.
    r.publicViews = {
        home: homePage, start: startPage, harnesses: harnessesPage, improve: improvePage,
        improveRepo: improveRepoPage, updates: updatesPage, policy: policyIndexPage,
        policyDoc: (slug) => { const g = governance.find((x) => x.slug === String(slug || '')); return g ? policyDocPage(g) : null; },
    };

    // ── Discovery: robots.txt, sitemap.xml, llms.txt, llms-full.txt (http/discovery.js, openvibe-shared/seo) ──
    r.use(createDiscoveryRoutes({ ...ctx, governance }));

    return r;
}

module.exports = { createPageRoutes, GOVERNANCE, repositories };
