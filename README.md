# OpenVibe.Codes

> Code with any agent: the open coding-agent harness for Claude Code, Codex, OpenCode, Command Code, Aider, the DeepSeek API and models you host yourself, and the way to improve OpenVibe itself.

**Status:** alpha. Public at `https://openvibe.codes` (openvibe-ovh, unit `openvibe-codes` on 127.0.0.1:4900 behind nginx). On 2026-10-08 the owner made Codes the open, modular coding-agent harness; the developer console that used to live here (projects, apps, keys, grants, the API reference, OAuth and webhook tools, releases) moved to [OpenVibe.Services](https://github.com/OpenVibers/OpenVibe.Services) at `https://openvibe.services`, and every one of its addresses here answers a permanent redirect there. See [STATUS.json](STATUS.json) for exactly what works and what does not.
**Domain:** `openvibe.codes` · **Port:** 4900 · **Service id:** `codes`
**Plan:** plan T16 (the coding-harness fabric); the harness boundaries are [ADR-050](docs/adr/050-codes-harness-fabric.md) (proposed).
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

One place to send a coding task to the agent that fits it — by what the task needs first, then by cost — hand it over when one agent gets stuck, and keep the run in one place; and the front door for anyone who wants to improve OpenVibe itself. The agents run on people's own machines or OpenVibe's; Codes routes, records and hands off, and never holds a person's provider keys in the clear.

## What is here

| Surface | Path | Notes |
|---|---|---|
| The harness | `openvibe-codes` ([bin/openvibe-codes.js](bin/openvibe-codes.js), [harness/](harness/)) | Runs on a person's own machine with their CLIs and keys; nothing goes through OpenVibe. See **Use the harness** below. |
| Home | `/` | What the harness is, the agents in the catalog, how a task finds its agent, Improve OpenVibe, and an honest table of what works today and what comes next. |
| Get started | `/start` | Install, the agents and what each needs, the commands, permission levels, hand-offs, the event format and using it from code. |
| The agents | `/harnesses` | Every harness in [`server/data/harness-offers.json`](server/data/harness-offers.json) (validated at boot as `platform.harness-offer@1`, each model as `platform.agent-offer@1`) with its provider, address kind, what it can do, price and limits, and its models with context limits and token prices. No local path is ever shown. |
| Agent API | `GET /api/v1/harnesses`, `POST /api/v1/harnesses/route` | Public, no key. The router takes `{ task, requirements? }` (`task` is `edit`, `review`, `long` or `resume`; `requirements.capabilities` adds hard constraints) and answers `{ selected, reasons, candidates }` from `openvibe-sdk/placement` — hard constraints first (a missing capability excludes an agent, and says so), then cost. RFC 9457 problems (`harness.invalid`, `harness.task_unknown`). |
| Improve OpenVibe | `/improve` | Every OpenVibe repository, from the pinned contracts' service manifests (the services that run, then the shared libraries), and the path from a change to a reviewed pull request. |
| Community | `/policy`, `/policy/<document>` | The code of conduct ([CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)), the contribution guide ([CONTRIBUTING.md](CONTRIBUTING.md)), the [contributor ladder](docs/governance/contributor-ladder.md) and the [moderation policy](docs/governance/moderation.md), rendered from those files. All four are **drafts pending owner review**: marked at the top, shown with a notice, not indexed; deleting the draft line publishes one. They govern the repositories and the apps and releases on OpenVibe.Services alike. |
| Moved | `/projects`, `/docs`, `/oauth`, `/tools`, `/manifests`, `/releases`, `/apps`, `/staff`, `/policy/{rfc,compatibility,licensing,transparency}`, `/api/v1/*` but the agent API | Permanent redirects to the same path and query on `https://openvibe.services`: 301 for GET and HEAD, 308 for anything else (the method and body are kept). `/docs/harnesses` goes to `/harnesses` here. [`server/http/moved.js`](server/http/moved.js). |
| Machine | `/api/health`, `/api/ready`, `/release.json`, `/metrics` | Readiness is truthful (the database and the catalog required; JWKS, the OAuth client and Valkey reported as optional checks). `/metrics` answers loopback callers only. |
| Crawl artifacts | `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/llms-full.txt` | Built with openvibe-shared/seo. robots.txt disallows sign-in and the API and leaves the moved addresses crawlable, so engines follow their 301s to openvibe.services; the sitemap lists the public pages with STATUS.json's content date (never "today"). |

Everything is server-rendered and usable without JavaScript.

## Use the harness

```bash
npm install -g https://codeload.github.com/OpenVibers/OpenVibe.Codes/tar.gz/refs/tags/v0.2.0   # Node.js 22+
openvibe-codes agents                                   # what this machine can run, and why not the rest
openvibe-codes run "rename getUser to findUser"         # routed, handed off on failure, kept
openvibe-codes run --agent codex --permission read "where is the session cookie set?"
openvibe-codes runs                                     # the latest runs
openvibe-codes resume <run id> "now add a test"
```

| Agent | Adapter | Needs |
|---|---|---|
| Claude Code | `claude -p --output-format stream-json` | `claude` on PATH |
| Codex | `codex exec --json` | `codex` on PATH |
| OpenCode | `opencode run --format json` | `opencode` on PATH |
| Command Code | `cmd --print --output-format json` | `cmd` on PATH |
| Aider | `aider --message` | `aider` on PATH |
| DeepSeek | the harness's own agent loop ([harness/adapters/api.js](harness/adapters/api.js)) | `DEEPSEEK_API_KEY` |
| Your own model | the same loop against any OpenAI-compatible server | `OPENVIBE_CODES_BASE_URL`, `OPENVIBE_CODES_MODEL`, optional `OPENVIBE_CODES_API_KEY` |

- **Events.** Every adapter turns its agent's output into one stream in Claude Code's `stream-json` shape (system/init, assistant text and tool_use, user tool_result, system warning/error/handoff, exactly one result), [harness/events.js](harness/events.js). Keys, tokens and private keys are redacted before an event is printed or kept.
- **Permission levels.** `read` (Claude Code plan mode, Codex read-only sandbox, read tools only), `edit` (the default: edits in the working directory, Claude Code refused `git push`, the API loop without commands), `full` (anything, unattended). The API loop never leaves the working directory, never reads `.env` and never writes under `.git`.
- **Hand-offs.** A failed, rate-limited, crashed or silent attempt (`stallMs`) is stopped and the task goes to the next agent the router picks, leaving out the ones tried, with a note: the task, why the last agent stopped, its tools, the files it changed, its last message and `git status`.
- **Runs** are kept in `$OPENVIBE_CODES_HOME` (else `$XDG_STATE_HOME/openvibe-codes`, else `~/.local/state/openvibe-codes`), one 0700 directory per run.
- **From code:** `const { createHarness } = require('openvibe-codes')`, then `for await (const e of createHarness().run({ prompt, cwd }))`.

## What comes next

1. **A hosted runner** — the same harness on OpenVibe.Run workers for people who would rather not run agents themselves: `POST /api/v1/jobs`, a stream, cancel, budgets per person and per project, metered through Billing, the run log in Codes' own database.
2. **OpenVibe.Actor uses Codes** — Actor is OpenVibe's general agent (owner, 2026-10-08); its coding steps run through this harness.
3. **Improve OpenVibe as a flow** — repository → change → tests → independent review → pull request, never straight to `main`.
4. **The OpenVibe agent pool on this package** — `~/openvibe/agents` (the pool that builds OpenVibe) replaces its own adapters with these.

## Owns

- The harness catalog and the routing policy over it (placement itself is `openvibe-sdk/placement`, the one implementation every service uses).
- Its pages and the community documents in this repository.
- The harness package (`harness/`, `bin/`): adapters, the event format, hand-offs and the local run store.
- Nothing in its database yet: migration 0002 dropped the console's tables when the console moved; hosted runs will live here.

## Does not own

- The developer console, releases, manifests, trust tiers, playgrounds and the generated reference: **OpenVibe.Services**.
- Accounts, projects, apps, credentials and grants: **OpenVibe.Network**.
- Provider keys: **OpenVibe.AI** (bring-your-own keys are stored and used there).

## Depends on

- **OpenVibe.Network** — SSO (OAuth client `codes`, PKCE S256) and its JWKS.
- **PostgreSQL 18 and Valkey 9** (OpenVibe.Host `roles/data/`, ADR-035): `openvibe-sdk/db`; Valkey holds the per-actor limit counters (optional).
- **openvibe-contracts v0.122.1**, **openvibe-sdk v0.35.2**, **openvibe-shared v2.17.0** (pinned tag tarballs).

No path in Codes sends or accepts a shared loopback key (tested by grep and at runtime).

## Configuration

See [.env.example](.env.example). Required in production: `OV_OAUTH_CLIENT_SECRET`, `BASE_URL`, `DATABASE_URL` (and `DATABASE_DIRECT_URL` for the boot migrations, run as the owner). Optional: `VALKEY_URL`, `CODES_LIMITS_MINUTE` / `CODES_LIMITS_HOUR`.

### Per-actor limits

`/api/v1` limits who calls it, once the caller is known and before any work: `server/http/actor-limits.js`, openvibe-sdk/limits, roadmap WS-R task 4. A signed-in person counts as `user:usr_…`, anyone else by address. Past a limit: `429` problem+json `rate_limited` with `Retry-After`, one `[Limits]` log line and `codes_rate_limited_total{limit,window}`. Reads: `CODES_LIMITS_MINUTE` / `CODES_LIMITS_HOUR` (120 / 3000); the router: 30 a minute, 600 an hour. Never limited per actor: `/api/health`, `/api/ready`, `/release.json`, `/metrics`, sign-in and the public pages (the per-address limit bounds them).

## Deploy (for the lead)

Production deploys with `sudo ovhost deploy codes` on the host (strategy `git-checkout`: fetch, fast-forward `/opt/openvibe.codes`, install on a lockfile change, restart, wait for `/api/ready`). The unit is `openvibe-codes.service` on `127.0.0.1:4900`, the env file `/etc/openvibe/codes.env`, the database `ov_codes` on the host's data role. nginx serves `openvibe.codes` from [deploy/nginx/openvibe.codes.conf](deploy/nginx/openvibe.codes.conf). Rollback: ovhost puts the previous sha back by itself when `/api/ready` does not answer 2xx after the restart; afterwards `sudo ovhost rollback codes --to <sha>`. Migration 0002 drops the console's tables (their rows were copied into `ov_services` first), so a rollback to a release before it finds no console tables: roll Codes forward, or restore `ov_codes` from the backup taken before the deploy.

## Development

```bash
npm install
fnm exec --using=22.22.1 npm test          # every test/*.test.js on temp PGlite databases with a mock Network
fnm exec --using=22.22.1 npm run dev       # http://localhost:4900
```

Tests: the harness against stand-in agents (`test/helpers/fake-agents.js`: every CLI adapter's events, hand-offs on failure and on silence, redaction, resume, the API loop against a stand-in server with its path rules, the command line and its exit codes); the catalog (validation at boot, the API and the router: capability first, the reasons, refusals as problems); the redirects (every console address 301 or 308 to the same path on openvibe.services, what stays here answering 200); sign-in (PKCE, state, next=, an assertion or app token is not a session, cross-site sign-out refused); the community documents (drafts marked, not indexed, every link resolving); the crawl artifacts; per-actor limits; no internal key anywhere; no secret in any response, the database or the logs; no URL a caller typed ever fetched; readiness, release.json and loopback metrics; the released codes manifest matching the code; and the home page's size budgets (`test/perf-budget.test.js`, openvibe-shared/perf-budget).

## Security (threat notes)

Reporting a vulnerability: [SECURITY.md](SECURITY.md).

- Session tokens are httpOnly cookies; a FedCM assertion, an app token or a service token is never a session.
- Codes never fetches a URL anyone typed: the router reads requirements, and the moved addresses are redirects built from the path.
- Secrets never reach logs: errors are logged without request bodies.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.122.1
- openvibe-sdk: v0.35.2
- openvibe-shared: v2.17.0
<!-- versions:end -->
