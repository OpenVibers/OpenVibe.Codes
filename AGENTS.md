# AGENTS.md — OpenVibe.Codes

## Project overview

The open coding-agent harness: one place to send a coding task to the agent that fits it (by what the
task needs first, then cost), hand it over when an agent gets stuck, and keep the run in one place.
The same package runs on a person's own machine with their CLIs and keys; the site is the front door,
the router and the record. Node.js/Express + the `harness/` package, PostgreSQL (`ov_codes`),
CommonJS, **no build step**.

- Service id `codes`, port `4900`, origin `https://openvibe.codes`, unit `openvibe-codes.service`,
  release root `/opt/openvibe.codes`; live on openvibe-ovh.
- Design: plan T16 and [ADR-050](docs/adr/050-codes-harness-fabric.md). The developer console that
  used to live here moved to **OpenVibe.Services** on 2026-10-08; every one of its addresses here is
  a permanent redirect there.
- `package.json` `main` is [harness/index.js](harness/index.js) — the installable harness — while
  `npm start` runs [server/index.js](server/index.js), the site.

## What it owns

- The harness catalog and routing policy over it; placement itself is `openvibe-sdk/placement`.
- The harness package ([harness/](harness/), [bin/](bin/)): adapters for Claude Code, Codex, OpenCode,
  Command Code, Aider, the DeepSeek API and self-hosted models; the shared event format, hand-offs
  and the local run store.
- The site's records: `run_tasks` (tasks started on the site or API), `codes_session_lines`,
  attempts/hand-offs, inbound Run events and the `codes.task.*` outbox.
- Knowledge (`codes_knowledge`), skills/Rules/MCP/commands/hooks with immutable versions
  (`codes_skills`, `codes_skill_versions`), sharing, the task API/SSE stream and the agent catalog.
- Pages: `/`, `/start`, `/run`, `/run/tasks/:id`, `/knowledge`, `/skills`, `/harnesses`, `/improve`,
  `/policy*`, `/updates`, and the machine endpoints.

Not owned: the sandboxes/browsers (OpenVibe.Run), the machine's Link plugin (Link), the OpenVibe Git
host (`git.openvibe.codes`, repo OpenVibe-Git), the AI model runs (`openvibe.ai`, called through the
catalog), identity/grants (Network/Services), and the console that moved to Services.

## Who calls it, and whom it calls

- Callers: people in the browser; services with a Network service token audience `openvibe.codes` and
  `codes.task.start|read|cancel` (OpenVibe.Actor is the main one), using `X-OV-Subject` (and
  `X-OV-Project`) to act for a person; the CLI `openvibe-codes task` with the person's own token.
- Depends on: **Network** (SSO client `codes`, PKCE, JWKS); **AI** (`ai.openvibe.services` — the
  model catalog and completion); **Run** (`server/domain/run-client.js` — jobs in class `code`,
  artifact `openvibe-codes@1.0.0`, `trust: user-owned`, placed only on the person's machines);
  **Link** (`openvibe-codes job` in the machine's job sandbox); **Network projects** for delegation;
  **Git** (`git.openvibe.codes` — branch push and pull request with Codes' service token acting for
  the person); PostgreSQL and Valkey; Events for the outbox.

## Repository map

- **Site entry:** [server/index.js](server/index.js) — `createApp()`, listen, graceful stop.
- **App:** [server/app.js](server/app.js) — helmet/CSP, `/internal/events`,
  `/internal/sandbox-workers`, `/auth`, `/shared`, `/api/v1` (agent, task, knowledge, skills and
  resource routers), pages, moved-address redirects, machine endpoints.
- **Harness entry:** [harness/index.js](harness/index.js) — `createHarness({ env, fetch, store })`,
  `agents()`, `route()`, `run()` and the event stream; [harness/job.js](harness/job.js) is the job the
  Link runs.
- **Domain:** [server/domain/](server/domain/) — `run-tasks.js`, `attempts.js`, `harnesses.js`,
  `harness-placement.js`, `knowledge.js`, `skills.js`, `run-client.js`, `github.js`, `redact.js`.
- **HTTP:** [server/http/](server/http/) — `pages.js`, `api.js`, `tasks-api.js`, `run.js`,
  `knowledge.js`, `skills-pages.js`, `moved.js`, `discovery.js`, `openapi.js`.
- **Catalog:** [server/data/harness-offers.json](server/data/harness-offers.json) (validated at boot).
- **Browser:** [public/js/run.js](public/js/run.js), `composer.js`, `chat.js`, `c4.js`, `copy.js`,
  `setup.js`; CSS in [public/css/](public/css/).
- **Sandbox:** [sandbox/](sandbox/) (bwrap/seccomp/egress, worker/supervisor),
  [deploy/sandbox/](deploy/sandbox/).
- **Deploy:** [deploy/systemd/openvibe-codes.service](deploy/systemd/openvibe-codes.service),
  [deploy/nginx/openvibe.codes.conf](deploy/nginx/openvibe.codes.conf).

## Commands

```bash
npm ci
npm run dev                # NODE_ENV=development node server/index.js
npm start                  # node server/index.js, http://127.0.0.1:4900
npm test                   # test/run.js, temp PGlite, mock Network/Events/Media
npm run test:pg            # same suite on PostgreSQL (CODES_TEST_STORE=pg)
npm test -- schedule       # filter by file name; --strict makes a skip fail
ov test                    # the harness's sharded run of what the change reaches
```

The harness is also run from a machine:

```bash
npm install -g <this repo tarball>
openvibe-codes agents      # what this machine can run, and why not the rest
openvibe-codes run "…"     # routed, handed off on failure, kept
```

## Database and migrations

PostgreSQL database `ov_codes` on the host's data role (ADR-035); PGlite in development/tests.
Async through `openvibe-sdk/db`; migrations `migrations/NNNN_*.sql` applied at boot with the owner
connection (`DATABASE_DIRECT_URL`). Never edit an applied migration. **Migration 0002 dropped the old
console tables** (rows were copied into `ov_services`): a rollback to a release before it finds no
console tables, so roll forward or restore `ov_codes` from the pre-deploy backup. Skills are
versioned: every save is an immutable version and a rollback copies an old version into a new one —
never UPDATE a version body.

## Auth and task ownership

- The site signs people in with Network SSO (OAuth client `codes`, PKCE S256); session tokens are
  HttpOnly cookies. A FedCM assertion, an app token or a service token is never a session.
- The task API accepts either the person's own Network access token (they see every task they own,
  whoever started it) or a first-party service token with the route's capability plus
  `X-OV-Subject`; a service reads/cancels only the tasks it started for that person (otherwise 404).
- `idempotency_key` makes a retry answer the first task (`200`, `created: false`).
- Per-person budgets: starts and cancels 6/minute, 60/hour. `permission` is `review` (read-only),
  `edit` (default) or `full`.
- Codes never sends or accepts a shared loopback key (tested by grep and at runtime).

## Frontend loading model

Everything on the site is **server-rendered and usable without JavaScript**; small no-build scripts
under [public/js/](public/js/) enhance the run view, composer, chat and C4 pages. There is no SPA,
bundler or transpiler. `openvibe-shared` supplies the Frame, the session view
(`openvibe-shared/agent-session.js`) and `/shared/*` from the pinned node_modules. CSP is in
[server/app.js](server/app.js); crawl files use `openvibe-shared/seo` and IndexNow on deploy.

## Deploy

`sudo ovhost deploy codes` (git-checkout: fetch, fast-forward `/opt/openvibe.codes`, install on a
lockfile change, restart, wait for `/api/ready`). Unit `openvibe-codes.service` on `127.0.0.1:4900`,
env `/etc/openvibe/codes.env`; vhost
[deploy/nginx/openvibe.codes.conf](deploy/nginx/openvibe.codes.conf). Rollback
`sudo ovhost rollback codes --to <sha>` — mind migration 0002 above. The sandbox worker is a separate
unit/service installed from [deploy/sandbox/install.sh](deploy/sandbox/install.sh).

## Tests

`npm test` runs each `test/*.test.js` in its own process through `openvibe-shared/test-runner`, with
PGlite and in-process Network/Events/Media mocks. It covers the harness adapters and hand-offs,
routing/catalog, the task API and attempts/SSE, knowledge and skills, redaction, the moved redirects,
the pages/llms/openapi, sandbox rules and the contracts. `ov test` runs the same.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; domain logic in `server/domain/`, HTTP in
  `server/http/`, harness in `harness/`; injectable config/db/clock/fetch/log.
- The harness is standalone: it must not need OpenVibe to run, and nothing about a local run goes
  through OpenVibe unless the person asks.
- Errors are RFC 9457 problem+json with stable codes (`harness.invalid`, `harness.task_unknown`,
  `codes.no_project`); never leak a path, a key or a request body.
- IDs and capability names come from `openvibe-contracts`; bump the pin before using a new one.

## Pitfalls

- **Never push the branch a task started from.** A job may push a new branch (never the base) and open
  a pull request only when asked and the machine holds `GITHUB_TOKEN`.
- **The API loop stays in the working directory**, never reads `.env`, never writes under `.git`;
  the permission levels (`review`/`edit`/`full`) are enforced by the adapters, not by prompt text.
- **`/run` tasks run on the person's own machine**, not OpenVibe's. A task with no `/run` project is
  `409 codes.no_project`; do not "fix" it by placing work anywhere else.
- **Knowledge is private by default and redacted** before storage; a shared row goes through the
  share gate, never a raw link.
- **Skills are immutable versions**; a rollback is a new version.
- **Moved addresses are 301 for GET/HEAD and 308 for anything else**, preserving path, query, method
  and body — do not reintroduce the console.
- **`/metrics` is loopback only**; readiness is truthful (database + catalog required).
- **A service may act only for the person it names** and only on the tasks it started.

## Documentation

- [README.md](README.md) — every surface, the harness, API, configuration and deploy.
- [docs/adr/050-codes-harness-fabric.md](docs/adr/050-codes-harness-fabric.md) — the boundaries.
- [docs/harness-runtime.md](docs/harness-runtime.md), [docs/cli.md](docs/cli.md),
  [docs/checkpoints.md](docs/checkpoints.md), [docs/agent-runs.md](docs/agent-runs.md).
- [docs/model-plans.md](docs/model-plans.md), [docs/g3-local-clone.md](docs/g3-local-clone.md),
  [docs/governance/](docs/governance/), [CONTRIBUTING.md](CONTRIBUTING.md).
