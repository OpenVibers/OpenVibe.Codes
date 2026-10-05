# OpenVibe.Codes

> The developer portal: projects and apps over OpenVibe.Network, scoped credentials, generated contract and SDK docs, OAuth and webhook tools, grant-respecting playgrounds, manifest validation and release metadata.

**Status:** alpha (roadmap Wave 20). **Deployed and public since 2026-09-23:** `https://openvibe.codes` is served by this portal (openvibe-ovh, unit `openvibe-codes` on 127.0.0.1:4900 behind nginx), and the domain left [OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites). The Network OAuth client `codes` is registered. Production use so far is nil (0 manifests, 0 releases, 0 playground runs). Tests run against in-process stand-ins for Network, Events and Media. See [STATUS.json](STATUS.json) for exactly what works and what does not.
**Domain:** `openvibe.codes` · **Port:** 4900 · **Service id:** `codes`
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §15.17, §24.2 (proof flow 6), §30; binding decision ADR-014 in OpenVibe.Contracts.
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

A place where a developer outside the network goes from an OpenVibe account to a working, scoped integration using only public docs, the SDK and their own credentials. Codes is a **portal**: the identity authority (OpenVibe.Network) owns projects, apps, credentials, grants and quotas (ADR-014), and Codes shows and forwards what the signed-in person asks for, with that person's own Network token.

## Owns

- **Release metadata** keyed to Network app ids: validated app and mod manifests, releases (`draft → published → deprecated → revoked`), an append-only release log.
- **Trust tiers** per ADR-013 (`unreviewed`, `reviewed`, `first-party`) — **metadata only**: a tier changes defaults and discovery, never a grant check. Databases written with the earlier four names are migrated at boot (untrusted→unreviewed, verified/trusted→reviewed, platform-maintained→first-party), idempotently.
- **Playground run logs** (who ran what, outcome, stage, problem code; never a credential).
- The events `codes.app.published`, `codes.app.deprecated`, `codes.app.revoked`, and `codes.moderation.action` for staff revocations and trust tier changes (the network's moderation audit log), through the openvibe-sdk transactional outbox.
- The generated reference (rendered from the pinned packages at boot; nothing hand-written that can drift) and the portal's pages.

## Does not own

- Projects, members, apps, credentials, grants, allowances, quotas, audit: **OpenVibe.Network** (`/api/v1/projects`). Codes never copies them.
- Secrets: Network returns a client secret once; Codes renders it in that one response (`Cache-Control: no-store`) and keeps no copy. Tests scan every table, every log line and every later response for each secret.
- Token issuance and quota enforcement: Network issues tokens; the service that owns a capability enforces its quota. Codes labels quotas "recorded limit — enforced by `<service>`".
- The registry (Network) and the contracts (OpenVibe.Contracts).

## What is here

| Surface | Path | Notes |
|---|---|---|
| Portal | `/projects`, `/projects/:project`, `/projects/:project/apps/:app` | Create projects; add members; create sandbox/production apps (secret shown once); rotate and revoke credentials; request, approve, deny and revoke grants through a scope editor that offers only grantable capabilities (public, or partner when in the allowance) with each one's description, owner and visibility; quotas; **usage** (owner, admins and staff: `/projects/:project/usage?days=7|30|90&env=all|production|sandbox`, Network's `GET /api/v1/projects/:project/usage` rendered server-side: usage by service, capability and day, each recorded quota's headroom as a `<meter>`, the published limits of the services used (their `/limits.json`), errors by code and the sampled failures with their trace ids and job or event ids; the numbers come from the services' hourly `*.usage.recorded` rollups, which Network adds up per day, so the current hour is not counted yet); audit (admin+); **export** a project's metadata as one JSON document (`/projects/:project/export`: Network's project, members, apps with credential ids and hints, grants, quotas and, for admin+, audit, plus Codes' releases with manifests and logs, trust tiers and playground runs; never a secret); owners and admins also download the **full archive** (`POST /projects/:project/export/archive`, one zip: that document with the audit log, the release manifests, the project's Media objects with download URLs and its namespaces, and its retained app events, for production and sandbox; read with Network's read-only export tokens; all or nothing when a service fails; [format](https://openvibe.codes/docs/export)) and **delete** a project (owner, confirmed by name: Network archives it — it offers archiving, not erasure — then Codes deletes drafts, their manifests and playground runs, and revokes published releases so installers are told). Network's errors are shown with its status, code, detail and request id. |
| OAuth helper | `/oauth`, `/oauth/test-callback` | Explains authorization code + PKCE (S256) for apps, builds a test authorize URL, and a callback that shows `code`/`state`/`error` and **never exchanges** the code. |
| Webhook tools | `/tools/webhooks` | Verify a delivery as a receiver that requires signature v2 does: `X-OpenVibe-Signature-V2: t=<ts>,v2=<HMAC of "<ts>.<raw body>">` must match and `t` must be within ±300 s of now (the page shows the age and the window, and tells a stale-but-correct signature from a wrong one); `X-OpenVibe-Timestamp` must equal `t`. v2 only: the v1 header (`X-OpenVibe-Signature`) was retired on 2026-09-28 and has no field. In the browser with Web Crypto, or on the server without JavaScript with openvibe-sdk's `verifyDeliveryV2`; constant-time; secret dropped. Generate a sample delivery signed as Events signs it (`X-OpenVibe-Timestamp` and v2, `signDeliveryHeaders`) for any event type the contracts catalog lists. |
| Docs | `/docs/*` | Contracts (field tables, fixtures as examples, raw schema), capability catalog (grantable ones highlighted), event types, SDK reference from its `.d.ts` files, ADRs. Every page states the versions it was generated from. The service registry is read live from Network, with health as Network reports it. |
| Coding-harness registry | `/docs/harnesses`, `/api/v1/harnesses` | Lists the coding harnesses Codes can route to with their agents (`GET /api/v1/harnesses`) and picks an offer for a task (`POST /api/v1/harnesses/route`). |
| Playgrounds | `/projects/:project/apps/:app/playground` | Media upload (sandbox, `media.object.upload`) and Events publish (`events.app.publish`: types `app.<project_key>.*`, source `app-<app ULID>`), run **as the app** with its own token (from its secret typed for that one request, or a pasted token). Refused — with the missing grant named, and nothing requested or called — unless Network lists the grant as approved. Sandbox apps only. |
| Manifests | `/manifests/validate`, `/projects/:project/apps/:app/releases/new` | Validate `codes.app-manifest@1` and `mods.mod-manifest@1` with openvibe-contracts; create, publish, deprecate and revoke releases. |
| Policy | `/policy/*` | Proposal process and the decision record; compatibility and deprecation policy rendered from ADR-002 and ADR-016 as published; licensing read from package metadata; transparency (what Codes stores and does not); governance — code of conduct ([CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)), contribution guide ([CONTRIBUTING.md](CONTRIBUTING.md)), [contributor ladder](docs/governance/contributor-ladder.md) and [moderation policy](docs/governance/moderation.md) — rendered from those files. All four are **drafts pending owner review**: marked at the top, shown with a notice, not indexed; deleting the draft line publishes one. |
| API | `/api/v1/*` | Public release reads (`codes.release.read`: no token needed; a presented token must hold it), manifest validation, docs versions; release management by an app with its own token (`codes.release.manage`). Guarded with openvibe-contracts `requireCapability`. RFC 9457 problems. |
| Machine | `/api/health`, `/api/ready`, `/release.json`, `/metrics` | Readiness is truthful (db and docs required; Network, JWKS, OAuth client and events relay reported as optional checks). `/metrics` answers loopback callers only. |
| Crawl artifacts | `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/llms-full.txt` | Built with openvibe-shared/seo for search and AI crawlers. robots.txt keeps every disallow (the portal, staff, sign-in and the API are not crawlable) and names the sitemap; the sitemap lists the fixed public pages with STATUS.json's content date and each public app and published release with its real publish time (never "today"); llms.txt maps the site; llms-full.txt lists every fixed public page the sitemap does, one title and one line of text each. |

Everything is server-rendered and usable without JavaScript. The only scripts of Codes' own are optional: in-browser webhook verification and a copy button.

## Depends on

- **OpenVibe.Network** — SSO (OAuth client `codes`, PKCE S256), JWKS, `/api/v1/projects` (called server-side with the person's Network access token), the registry (`/api/v1/registry/services`, `/.well-known/openvibe`), client-credentials tokens (Codes' own for the events relay; the app's own in playgrounds).
- **OpenVibe.Events** — the outbox relay publishes `codes.app.*` with Codes' service token (`events.event.publish`); the Events playground calls it with the app's token (`events.app.publish`); the project archive pulls the project's app events with a Network export token (`events.app.read`).
- **OpenVibe.Media** — the Media playground uploads with the app's token into the project's namespace; the project archive lists the project's objects, namespaces and download URLs with a Network export token (`media.object.list`, `media.object.read`).
- **PostgreSQL 18 and Valkey 9** (OpenVibe.Host `roles/data/`, ADR-035): every read and write is async through `openvibe-sdk/db`; Valkey holds the per-actor limit counters (optional).
- **openvibe-contracts** v0.86.0, **openvibe-sdk v0.26.0**, **openvibe-shared v2.6.0** (pinned tag tarballs; the docs show the tag and the package version, and say so when they differ).

No path in Codes sends or accepts a shared loopback key (tested by grep and at runtime).

## Grants and registration the lead must add

Implemented here (the service manifest's `capabilities`): `codes.release.read` (public release reads;
no token needed, a presented token must hold it) and `codes.release.manage` (release management by an
app with its own token), both guarded with openvibe-contracts `requireCapability`.

Called elsewhere: as the service principal `codes`, `events.event.publish` at Events (the outbox relay);
as the signed-in person, with their own Network token, Network's `/api/v1/projects`; as the app, with
its own token, `media.object.upload` (Media) and `events.app.publish` (Events) in the playgrounds; and,
for the project archive, Network's read-only export tokens holding `events.app.read`,
`media.object.list` and `media.object.read`.

In Network (`server/identity/principals.js` / `server/db/database.js`, as for coupons and host):

- OAuth client `codes`, name `OpenVibe.Codes`, redirect URI `https://openvibe.codes/auth/callback`.
- Service grant `['codes', 'events.event.publish', 'openvibe.events', []]` (the outbox relay).

The Codes service manifest, `codes.release.manage|read` and `codes.app-manifest@1` are released in openvibe-contracts (tag v0.27.0; this repository pins v0.86.0); the CI contracts check is blocking.

For the playgrounds to succeed end to end (not Codes' code; configuration elsewhere): Network `DEV_SANDBOX_AUDIENCES` including `openvibe.media` and `openvibe.events`, a staff-set allowance containing `media.object.upload` and `events.app.publish` for the project, a Media tenant keyed by the project id, and OpenVibe.Events serving `events.app.publish` for app tokens. On 2026-09-23 these were in place on production: a sandbox app uploaded to Media (tenant `prj_…-sandbox`) and published and read app events through public endpoints. That run used curl, not the Codes playgrounds, and it is not yet a committed, repeatable check.

## Configuration

See [.env.example](.env.example). Required in production: `OV_OAUTH_CLIENT_SECRET`, `CODES_FORM_SECRET`, `BASE_URL`, `DATABASE_URL` (and `DATABASE_DIRECT_URL` for the boot migrations, run as the owner). Optional: `EVENTS_URL` (relay), `INDEXNOW_KEY` (see below), `CODES_STAFF_SUBJECTS`, `CODES_PLAYGROUND_*`, `CODES_REGISTRY_TTL_MS`, `CODES_LIMITS_MINUTE` / `CODES_LIMITS_HOUR`.

### IndexNow (openvibe-shared/indexnow)

With `INDEXNOW_KEY` set (8–128 hex or alphanumeric characters, what IndexNow's own tools
generate), the key file is served at `/<key>.txt` as `text/plain` and every public release
transition tells the engines: publish, deprecate and revoke of a published or deprecated release
ping `api.indexnow.org` with the release page (while it is published), the app page, `/updates`
and `/sitemap.xml`; the module batches and debounces these. Nothing pings for a draft, and a
release that was never public stays silent. Unset: the feature is off — no key file, nothing sent
(what tests and drills do). The key is not a secret in the credential sense: engines fetch it by
design. `test/indexnow.test.js`.

### Per-actor limits

`/api/v1`, the portal (`/projects`), release actions, the tools' forms and the staff trust form also
limit who calls them, once the caller is known and before any work (before a form or upload is read,
before Network is asked): `server/http/actor-limits.js`, openvibe-sdk/limits, roadmap WS-R task 4. An
app token counts as its app (`app:app_…`), a signed-in person as `user:usr_…`, anyone else by address.
Past a limit: `429` problem+json `rate_limited` with `Retry-After`, one `[Limits]` log line and
`codes_rate_limited_total{limit,window}`. The per-address limits (pages 300 a minute, portal writes 60,
tools 30, API writes 60, sign-in) and the playground's runs an hour stay. Codes hosts no git remotes, so
there are no clone or push routes to leave out.

| Routes | Per caller, a minute / an hour |
|---|---|
| API reads; portal pages (each asks Network with the person's token) | `CODES_LIMITS_MINUTE` / `CODES_LIMITS_HOUR` (120 / 3000) |
| Project create | 5 / 30 |
| Members, roles, archive, delete | 20 / 200 |
| Project export (JSON and the full archive) | 3 / 20 |
| App create | 10 / 60 |
| Redirect URIs, grants, app revoke | 30 / 300 |
| Credential rotate and revoke | 10 / 60 |
| Playground runs (above the 60 an hour per person) | 10 / 120 |
| Release create and "validate only" (portal and API) | 20 / 200 |
| Release publish, deprecate, revoke (portal and API) | 20 / 200 |
| Manifest validate (form and API); webhook verify and sample | 30 / 600 each |
| Staff trust tier | 30 / 300 |

Never limited per actor: `/api/health`, `/api/ready`, `/release.json`, `/metrics`, sign-in, and the
public pages and docs. `test/actor-limits.test.js`; the other tests boot with the per-actor limits off,
as they raise the per-address limit.

## Deploy (for the lead)

Production deploys with `sudo ovhost deploy codes` on the host (strategy `git-checkout`: fetch,
fast-forward `/opt/openvibe.codes`, install on a lockfile change, restart, wait for `/api/ready`).
The unit is `openvibe-codes.service` on `127.0.0.1:4900`, the env file `/etc/openvibe/codes.env`. The database is
`ov_codes` on the host's data role (`sudo /opt/openvibe.host/roles/data/add-service.sh codes` writes its settings); the
release migrates it at boot. nginx serves `openvibe.codes` from
[deploy/nginx/openvibe.codes.conf](deploy/nginx/openvibe.codes.conf).
Rollback: ovhost puts the previous sha back by itself when `/api/ready` does not answer 2xx after the
restart; afterwards `sudo ovhost rollback codes --to <sha>`. One blocker: the trust table was rebuilt
once to the ADR-013 tier names, so a release from before that change expects the old names.

First install (done once; kept for a rebuild):

1. `git clone` to `/opt/openvibe.codes`; `npm ci --omit=dev` with Node 22.
2. `/etc/openvibe/codes.env` from `.env.example` (secrets from the Network client registration).
3. `deploy/systemd/openvibe-codes.service` → `/etc/systemd/system/`; `systemctl enable --now openvibe-codes`.
4. `deploy/nginx/openvibe.codes.conf` → `/etc/nginx/sites-available/`, certificate for `openvibe.codes` + `www`, reload nginx.
5. Check `curl -s http://127.0.0.1:4900/api/ready`.
6. Only when the launch rule below holds: remove `openvibe.codes` from `OpenVibe.Sites/sites.json` and switch routing (done on 2026-09-23).

## Development

```bash
npm install
fnm exec --using=22.22.1 npm test          # every test/*.test.js on temp PGlite databases with mock Network, Events, Media
fnm exec --using=22.22.1 npm run dev       # http://localhost:4900
npx openvibe-contracts-check --service codes --src server
```

Tests: the crawl artifacts (robots.txt, sitemap.xml, llms.txt and llms-full.txt — the public pages only, llms-full.txt listing every page the sitemap does, and lastmod from STATUS.json, never the clock); ADR-013 trust-tier migration; secrets never persisted or re-displayed; Network errors surfaced honestly (404/403/409/422/503, unreachable, expired session refresh); scope editor offers only grantable capabilities and refuses forged requests before Network sees them; generated docs match the pinned versions (every contract, capability, event type, SDK module); webhook verification, v2 only (tampering, lengths, malformed headers, the ±300 s window both ways, timestamp header mismatch, a v1-only delivery refused, samples without v1, constant-time, the in-browser verifier agreeing); playgrounds refuse without the grant and call nothing; the usage page (owner, admins and staff only, Network not asked for anyone else, filters forwarded as offered, a Network failure shown as it answered); project export (complete, no secrets, audit for admin+ only, never partial) and delete (owner only, Network first, drafts and runs removed, public releases revoked with an event); manifest validation; release lifecycle and events; no internal key anywhere; PKCE sign-in; readiness, release.json, loopback metrics; the released codes manifest matching the code; IndexNow (off without a key, the key file served with a key, a publish pinging the page and the sitemap, a draft never pinging); and the home page's size budgets (`test/perf-budget.test.js`, openvibe-shared/perf-budget).

## Acceptance (must be true before "done")

- A new external developer goes from account to a working Media, event and capability integration with only public docs, the SDK and scoped credentials — no loopback key. **Partly shown: one production run on 2026-09-23 covered account, project, sandbox app, auto-approved grants, Media upload and app event publish/read with public endpoints (curl, not the SDK or the playgrounds). It is not committed as a repeatable check, and it did not cover webhook delivery to an external endpoint, publishing a release or revoking credentials.**
- Credentials can be inspected, scoped, rotated and revoked. **Yes, through Network's API (tested against a stand-in; not yet used on production).**
- The playground cannot exceed its project's grants. **Yes (tested).**
- A published app or mod release carries compatibility and trust metadata. **Yes (tested).**

## Launch rule

The domain keeps its placeholder page on [OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the following exist (plan §12.12). **Codes left Sites on 2026-09-23 and serves `openvibe.codes`.** The items: an owning runtime with health/readiness and observability (**done**); canonical identity/auth integration (**done; the OAuth client `codes` is registered**); server-rendered public routes useful without JavaScript (**done**); real persistence and end-to-end workflows (**persistence done; the external-developer path ran once on production with curl, not yet through the portal**); capability and event registration against OpenVibe.Contracts (**released**); a migration/seed strategy (none needed: no data is imported; raw old developer keys are never imported), a security review and sitemap/robots behaviour (**sitemap and robots done; the security review is the threat notes below, self-authored**); acceptance tests proving the advertised functionality (**against stand-ins**). Roadmap binding: do not launch Codes as a developer portal while these paths are mocked.

## Security (threat notes)

Reporting a vulnerability: [SECURITY.md](SECURITY.md).

- Session tokens are httpOnly (unlike the navbar-readable `ov_token` elsewhere) because this site displays secrets; forms carry an HMAC form token and require a same-site `Origin`.
- Secrets never reach logs: errors are logged without request bodies; playground failure details are scrubbed of the credential before they are stored or shown.
- Codes never fetches a URL a developer types (the webhook tester produces a `curl` for their own endpoint instead).
- Grant checks happen twice: Codes refuses to forward non-grantable capabilities, and Network decides. Playgrounds verify the app token's signature, subject, project, environment, audience and capability before calling anything.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
