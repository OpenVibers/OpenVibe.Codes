# ADR-050: The Codes harness fabric and its boundaries

**Status:** Proposed 2026-10-05; decision 8 added by the owner's decision of 2026-10-08. Governs the Codes product code that has not been written yet; the catalog, the
placement adapter and the read API recorded under **Context and current evidence** are the seed this
record is written against, as they stand on `main` (most recently `af3aab3`, `a1097e7`). Written in Codes'
first `docs/adr/` — the plan (§8) lists **ADR-050 Codes Harness Fabric** among the ADRs "to write before their code", and no earlier record covers it.

## Context and current evidence

- **The plan makes Codes the coding-harness fabric, not one harness.** The plan's owner-direction block (line 43): "OpenVibe.Codes is the
  coding-harness fabric and vibe-coding environment: OpenRouter for coding agents plus the contribution surface for
  OpenVibe itself." T16's finish line is "OpenRouter for coding harnesses plus the cloud/local vibe-coding IDE ... all
  routing through the universal Fabric, never through a second coding-harness router."
- **One placement implementation is a build rule.** §2.1.11: "`openvibe-sdk/placement` is the only generic
  placement/routing implementation. Product services may add policy and domain-specific eligibility, but must never
  create independent cost, health or provider optimizers." T16 restates it: harnesses "Routed by
  `openvibe-sdk/placement` like every other offer (§2.1.11)."
- **What actually shipped in Codes is the catalog and the router, not an execution engine.** `server/data/harness-offers.json`
  is a committed catalog of six harnesses — `claude-code`, `codex`, `command-code`, `opencode`, `aider`, `deepseek` —
  each with at least one agent. Its shape is fixed by Contracts: each row (minus `agents`) is validated as
  `platform.harness-offer@1` and each agent as `platform.agent-offer@1` at boot (`server/domain/harnesses.js:30,36`); a
  bad seed row, a duplicate id, or an agent whose `harness` names another row fails boot
  (`harnesses.js:32,38,39`; `server/app.js:79-80`, "a bad seed row fails boot"). The catalog is read once; the source
  says ownership of offers is not settled: "Static harness catalog. Replace the file reader when offer ownership is
  settled." (`harnesses.js:3`).
- **Each harness × agent pair becomes one Fabric offer.** `toOffer()` (`server/domain/harness-placement.js:31-58`) maps
  one catalog row + agent to a `platform.resource-offer@1` of `kind: 'harness'` (`:41`) whose `detail` is the row itself
  as `platform.harness-offer@1` (`:50-54`), and whose `offer_id` is `<harness>:<agent.id or agent.model>` (`:40`). The
  offer's `capabilities` are the task kinds, the true harness flags and the declared runtimes (`:45`): `task:<kind>`,
  `harness:<flag>` (the `HARNESS_FLAGS` map, `:19-22`) and `runtime:<class>` for each entry in `capabilities.runtimes`.
  A row without `task_capabilities` derives its kinds from `capabilities.edit` / `capabilities.review` (`tasksFor`,
  `:14-16`; `TASK_FLAGS`, `:12`). Capacity comes from the harness's `limits.max_concurrent_runs` and pricing is the
  agent's fresh token price as a marginal per-token figure (`:46,48`). The deepseek row declares no `runtimes` and no
  task flags, so its offer carries an empty capability list (`test/harness-placement.test.js:52-55`) — the mapping is
  what it is; it does not invent a runtime class.
- **Routing is capability-first and goes only through the SDK planner.** `route()` (`harness-placement.js:78-99`) builds
  the offers and calls `plan()` from `openvibe-sdk/placement` (`:8,84`). Capability is a *hard constraint* in the SDK,
  evaluated before cost or latency: `excluded()` returns "lacks <c>" for any missing required capability
  (`openvibe-sdk/src/placement.js:88-91`), and the planner's own contract is "hard constraints first: capabilities,
  trust, residency/region, health, latency ceiling, capacity, cost ceiling. A cheaper candidate that misses one is
  excluded, with the reason, never chosen" (`placement.js:12-14`). `requirementsFor()` turns a task into
  `{ kind: 'harness.<task>', mobility: 'job', latency_class: 'interactive', objective: 'balanced', capabilities: [...] }`
  (`harness-placement.js:60-76`) — Codes adds task vocabulary and eligibility, it adds no optimizer. The planner's
  answer is validated as `platform.placement-result@1` unless nothing was selected (`:86-93`); the API response is
  reshaped to `{ selected, reasons, candidates }` with each candidate's eligibility and exclusion reason (`:94-98`).
  Note `route()` passes no `current` placement, so the SDK's hysteresis branch
  (`placement.js:20-21,127,165-168`) is inert here today; whether Codes pins a current placement is **open**.
- **The read surface is two JSON routes and one docs page.** `GET /api/v1/harnesses` returns the catalog with its
  agents (`server/http/api.js:61-63`); `POST /api/v1/harnesses/route` validates the body (non-empty string `task`; a
  plain-object `requirements`; a string array `requirements.capabilities`) and routes, answering 422
  `harness.invalid` / `harness.task_unknown` for a bad request and 500 `harness.placement_invalid` if the planner's
  result violates its contract (`api.js:66-81`). Both sit under the per-actor limits (`codes.read`,
  `codes.harness.route`; `api.js:38-46`), and the routes are declared in the module header (`api.js:8-9`). A
  server-rendered, read-only page `/docs/harnesses` lists the catalog (`server/http/docs.js:19,383`), with sitemap
  and `llms.txt` entries (`server/http/discovery.js:43,100,224`). `STATUS.json` describes exactly this and nothing more:
  "a validated catalog of harnesses and their agents ..., a task placement adapter over openvibe-sdk/placement, and a
  public read API and read-only docs page".
- **The product half of T16 does not exist in Codes yet.** There is no workspace, editor, terminal, task feed, diff,
  review verdict, cost, or branch/PR code in `server/` — the strings do not appear. T16's product line is
  "repository browser, workspace, editor, terminal, task feed, tests, diff, harness explanation, review verdict, cost,
  branch/PR flow — usable hosted and on a Node (T14) for local harnesses", and T16's dependency line is
  "T1 (Fabric offers), T2 (projects/grants), T5 (metering/Vibes), T17 (Actor for planning), T14 (Run/Node for
  execution)". The plan does not use the phrase "forge model"; the repository/branch/PR authority it describes is
  Forgejo/GitHub under T16, and the project/grant authority is T2.
- **Forgejo is a Codes deliverable that must not gate Codes.** T16: "**Forgejo belongs here,** not in generic
  operations: Codes is the product that understands repository, branch, fork, PR/MR, review, CI, provenance. The
  platform supports GitHub and Forgejo adapters regardless of which is canonical; the Forgejo migration
  (git.openvibe.codes, one repository at a time) is a Codes deliverable and must not gate Codes." The plan voices it too:
  "Forgejo belongs to Codes; `openvibe-agents` is its prototype." Which forge is canonical, and when the migration runs, are **open**; neither may stop the
  catalog, routing and read surface, which is what ships now.

## Decision

1. **Codes is the harness fabric, and the fabric's router is the SDK's.** Codes owns the harness *catalog*, the
   harness-specific offer mapping and the task vocabulary; it does not own a router. Every routing call goes through
   `openvibe-sdk/placement` `plan()` (`harness-placement.js:84`), as §2.1.11 requires. Capability remains a hard
   constraint in the SDK, so a task's required capabilities decide eligibility before cost or latency
   (`placement.js:88-91`).
2. **The catalog is committed data validated against Contracts at boot.** `server/data/harness-offers.json` is the
   single source of harnesses and agents; every row is checked against `platform.harness-offer@1` and every agent
   against `platform.agent-offer@1` when Codes starts (`harnesses.js:30,36`), so an invalid catalog is a boot failure
   (`app.js:79-80`), never a runtime surprise.
3. **One harness × agent pair is one `platform.resource-offer@1` of `kind: harness`** with the catalog row as its
   `platform.harness-offer@1` `detail` (`harness-placement.js:31-58`). Offers carry `task:<kind>`, `harness:<flag>` and
   `runtime:<class>` capabilities; a row that declares no runtime declares none (no default is synthesized).
4. **The read surface is `GET /api/v1/harnesses` and `POST /api/v1/harnesses/route`, plus the read-only docs page.**
   These are additive and public-read; they expose the catalog and the placement decision with reasons and candidates
   (`api.js:61-81`). Nothing in this surface launches a harness, streams a run, meters usage or resumes a session.
5. **The write half is deferred, and its dependencies are named, not guessed.** Workspace, branch, PR/review, usage and
   execution depend on T1 (`platform.agent-offer@1` / Fabric offers), T2 (projects and grants), T5 (metering/Vibes),
   T14 (Run/Node execution) and T17 (Actor planning), per T16's dependency line. This record fixes no interface for
   them; they are **open** until those tracks land.
6. **Forgejo does not gate the fabric.** Codes must understand repository/branch/fork/PR/MR, CI and provenance, and
   the platform supports GitHub and Forgejo adapters "regardless of which is canonical" (T16). The migration to
   `git.openvibe.codes` is a Codes deliverable performed one repository at a time and must not block the catalog,
   routing or read surface. Which forge is canonical, and the adapter interface, are **open**.
7. **Where the catalog lives is open.** Today it is a committed file read once at boot, and the code says so
   (`harnesses.js:3`). When ADR-046 (Universal Adaptive Fabric) and ADR-047 (Cells and Resource Registry) settle offer
   ownership and registry publication, the catalog moves behind the registry and the file becomes a seed/fallback, or
   it does not; this record does not decide that. Nor does it decide trust defaults: `toOffer()` defaults every harness
   to `trust: 'external'` (`harness-placement.js:44`, asserted at `test/harness-placement.test.js:56`) — whether
   first-party harnesses should advertise a different class is **open**.

8. **Owner decision, 2026-10-08: the harness runs on the person's machine first.** Codes became the open, modular
   coding-agent harness and the developer console moved to OpenVibe.Services. The write half that decision 5 left open
   starts where it needs no other track: `openvibe-codes` (`harness/`, `bin/`) launches the agents a person already
   has (Claude Code, Codex, OpenCode, Command Code, Aider as CLIs; DeepSeek and any OpenAI-compatible server through
   the harness's own tool loop), turns every agent's output into one event stream in Claude Code's `stream-json` shape,
   hands a failed or silent attempt to the next agent `plan()` picks with a note on what was done, and keeps runs in a
   local store. Routing still goes through `openvibe-sdk/placement` (decision 1): an agent that is not installed or has
   no key is passed to `plan()` as `health: down` with the reason. Nothing is sent to OpenVibe and no key leaves the
   machine, so T2/T5/T14 are not prerequisites for this half. A hosted runner (OpenVibe.Run workers, budgets, metering)
   still waits on T14 and T5, and OpenVibe.Actor (T17) uses Codes for its coding work rather than owning a second
   coding harness.

## Alternatives considered

- **A second coding-harness router inside Codes (or reusing `openvibe-agents`' scored router as the optimizer):**
  rejected. §2.1.11 allows products to add policy but not optimizers, and T16 requires routing "through the universal
  Fabric, never through a second coding-harness router". `openvibe-agents` is the *prototype* (§1.1, line 97) and becomes
  Actor's engine, not Codes' router.
- **Putting the catalog in Contracts or in a database now:** rejected for the seed. The catalog is Codes' data and
  changes per deployment; Contracts owns the *shape* (`platform.harness-offer@1`), not the rows. Moving the rows to the
  registry is a plausible later step (decision 7) but would make today's read API depend on tracks that have not
  landed.
- **Launching harnesses from the read API's wake (an adapter in Codes now):** rejected as premature. There is no
  execution substrate (T14), no project/grant scope (T2) and no usage metering (T5); T16's adapter interface ("each
  harness is an adapter that declares how it launches, streams, reports usage and resumes") is a product deliverable
  with those dependencies, and shipping it early would either be a placeholder (§2.1.3) or a second runtime.
- **Making Forgejo canonical first and gating Codes on the migration:** rejected by T16, explicitly: the migration
  "must not gate Codes".

## Migration consequences

- **No data migration:** this is Codes' first ADR; it adds documentation only. The catalog is committed data and the
  routes are additive.
- **When T1/T2/T5/T14/T17 land:** the catalog becomes registry-backed (decision 7), harness offers gain trust, health
  and latency from telemetry rather than static defaults, and adapters (launch/stream/usage/resume) attach behind the
  same offers. `route()` may begin passing a current placement so the SDK's hysteresis applies (decision 5's open
  point). None of these change the contract shape recorded here.
- **Contracts:** `platform.harness-offer@1`, `platform.agent-offer@1`, `platform.resource-offer@1` and
  `platform.placement-result@1` are already pinned (openvibe-contracts v0.97.0; openvibe-sdk v0.26.0; openvibe-shared
  v2.9.0). If the fabric needs a new harness capability name, it is an additive enum extension in Contracts, not a new
  contract.
- **Docs:** the `/docs/harnesses` page and the sitemap/`llms.txt` entries are generated from the catalog
  (`docs.js:383`, `discovery.js:43,100,224`), so catalog changes propagate without hand edits.

## Rollback

- This record is documentation; deleting or superseding it leaves the shipped catalog and routes untouched.
- The catalog and routes are additive to the existing developer portal: removing `GET/POST /api/v1/harnesses`,
  `/docs/harnesses` and the `harness-offers.json` seed returns Codes to its pre-fabric release with no schema or data
  change.

## Acceptance tests

- **Shipped and checked** (`test/harnesses.test.js`, `test/harness-placement.test.js`, `test/harnesses-api.test.js`,
  `test/layout.test.js`): every seed row validates as `platform.harness-offer@1` and `platform.agent-offer@1`, ids are
  unique and malformed catalogs are rejected with `harness.invalid` (`test/harnesses.test.js:15-62`); every seed offer
  validates as `platform.resource-offer@1` of `kind: harness` and the field-by-field mapping is asserted, including the
  deepseek offer's empty capabilities (`test/harness-placement.test.js:26-78`); `GET /api/v1/harnesses` returns every
  harness with its agents, `POST /harnesses/route` returns a selected offer among all agents' candidates, a bad body is
  422 `harness.invalid` and an unknown task is 422 `harness.task_unknown`, both under their per-actor limits
  (`test/harnesses-api.test.js:18-76`); `/docs/harnesses` server-renders every seed harness and hides local paths
  (`test/layout.test.js:60-73`).
- **Still owed before the product closes T16** (the §9 gates have not yet been run for Codes): never writes a
  protected branch directly; a failed harness continues via handoff; a cheaper ineligible candidate never wins on the
  *live* catalog; a broken harness fails over immediately and a healthy one is not re-picked without `minGain`
  hysteresis once a current placement is supplied; a routed task actually launches a harness, streams progress, reports
  usage and resumes — none of which exists in Codes today, and none of which this record claims.
