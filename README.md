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
- **openvibe-contracts v0.129.0**, **openvibe-sdk v0.42.0**, **openvibe-shared v3.0.1** (pinned tag tarballs).

No path in Codes sends or accepts a shared loopback key (tested by grep and at runtime).

## Capabilities

- **Registered:** none. The released `codes` service manifest declares no capability and no events, and the developer console's `codes.release.*`, `codes.resource.*` and `codes.app.*` names are retired (their replacements are OpenVibe.Services'). `capabilitiesRegistered` in STATUS.json records that empty registration.
- **Routed over:** each catalog offer (`platform.harness-offer@1`, [server/data/harness-offers.json](server/data/harness-offers.json)) carries the flags the router matches. A task (`edit`, `review`, `long`, `resume`) becomes the requirements `task:edit`, `task:review`, and — for a long run or a resume — `harness:long-autonomy` and `harness:resume`; an agent's own flags add `harness:host-access`, `harness:mcp`, `harness:long-autonomy`, `harness:resume`, `harness:edit`, `harness:review`, `harness:tools`, `harness:vision`, `harness:browser` and `harness:computer-use`, and each runtime adds `runtime:<name>` (`runtime:code` today) ([server/domain/harness-placement.js](server/domain/harness-placement.js)).
- **Called on other services:** none. Sign-in uses OpenVibe.Network's OAuth2 authorization, token and revoke endpoints (client `codes`, PKCE S256) and its JWKS, not a capability.

## Acceptance

`npm test` (development: `fnm exec --using=22.22.1 npm test`) runs every `test/*.test.js` in its own process ([test/run.js](test/run.js)), each on a temp PGlite database with in-process mocks of OpenVibe.Network, Events and Media ([test/helpers/boot.js](test/helpers/boot.js)); `CODES_TEST_STORE=pg` runs the same against the containers. The main files, one line each:

- [test/harness-run.test.js](test/harness-run.test.js) — every CLI adapter turns its agent's output into the shared events with one result; availability comes from PATH and keys; routing leaves out what is not here and says why; a failed or silent attempt hands the task on; redaction; the local run store.
- [test/harness-api.test.js](test/harness-api.test.js) — the API agent loop against a stand-in OpenAI-compatible server: tools confined to the working directory, permission levels, `.env`/`.git`/outside paths refused, an HTTP error ends the run, resume continues the conversation.
- [test/harness-placement.test.js](test/harness-placement.test.js) — placement over the catalog: hard capability constraints first, then cost, with the reasons; an unknown task is refused.
- [test/harnesses.test.js](test/harnesses.test.js) — the catalog validated at boot as `platform.harness-offer@1` / `platform.agent-offer@1`.
- [test/harnesses-api.test.js](test/harnesses-api.test.js) — `GET /api/v1/harnesses` and `POST /api/v1/harnesses/route`, their 422 problems and their per-actor limits.
- [test/harness-cli.test.js](test/harness-cli.test.js) — the `openvibe-codes` command (`agents`, `route`, `run`, `runs`, `show`, `resume`) and its exit code.
- [test/moved.test.js](test/moved.test.js) — every former console address answers 301 or 308 to the same path on openvibe.services, and what stays here is untouched.
- [test/auth-jwks.test.js](test/auth-jwks.test.js) — the Network signing key is fetched and verified: the last good keys through an outage, backoff, readiness reporting the cache.
- [test/security-session.test.js](test/security-session.test.js) — a session cookie must hold a Network session token, not a FedCM assertion or an app/service token.
- [test/security-secrets.test.js](test/security-secrets.test.js) — no secret reaches a response, the database or a log line.
- [test/no-internal-key.test.js](test/no-internal-key.test.js) — no `X-Internal-Key` in code, deploy files or the environment, and no special treatment for one.
- [test/security-ssrf.test.js](test/security-ssrf.test.js) — no URL a caller typed is ever fetched, plus a ratchet on the files that make outbound requests.
- [test/actor-limits.test.js](test/actor-limits.test.js) — per-actor 429s with `Retry-After` before any work, while another caller still passes and the never-limited endpoints stay open.
- [test/contracts.test.js](test/contracts.test.js) — the released codes manifest matches the code, with no console capability or event left.
- [test/open-redirect.test.js](test/open-redirect.test.js) — sign-in's `next=` never leaves the site.
- [test/governance.test.js](test/governance.test.js) — the community documents are served as they are, drafts marked and kept out of search.
- [test/start-page.test.js](test/start-page.test.js) — `/start` names every adapter and its needs, and the command line prints the same version.
- [test/discovery.test.js](test/discovery.test.js) — robots.txt, sitemap.xml and llms.txt are served with real public entries and a lastmod from the site's own data.
- [test/perf-budget.test.js](test/perf-budget.test.js) — the home page's size budgets, measured on the server as it runs.

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
- openvibe-contracts: v0.129.0
- openvibe-sdk: v0.42.0
- openvibe-shared: v3.0.1
<!-- versions:end -->
