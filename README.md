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
- The events `codes.app.published`, `codes.app.deprecated`, `codes.app.revoked` (through the openvibe-sdk transactional outbox).
- The generated reference (rendered from the pinned packages at boot; nothing hand-written that can drift) and the portal's pages.

## Does not own

- Projects, members, apps, credentials, grants, allowances, quotas, audit: **OpenVibe.Network** (`/api/v1/projects`). Codes never copies them.
- Secrets: Network returns a client secret once; Codes renders it in that one response (`Cache-Control: no-store`) and keeps no copy. Tests scan every table, every log line and every later response for each secret.
- Token issuance and quota enforcement: Network issues tokens; the service that owns a capability enforces its quota. Codes labels quotas "recorded limit — enforced by `<service>`".
- The registry (Network) and the contracts (OpenVibe.Contracts).

## What is here

| Surface | Path | Notes |
|---|---|---|
| Portal | `/projects`, `/projects/:project`, `/projects/:project/apps/:app` | Create projects; add members; create sandbox/production apps (secret shown once); rotate and revoke credentials; request, approve, deny and revoke grants through a scope editor that offers only grantable capabilities (public, or partner when in the allowance) with each one's description, owner and visibility; quotas; audit (admin+); **export** a project's metadata as one JSON document (`/projects/:project/export`: Network's project, members, apps with credential ids and hints, grants, quotas and, for admin+, audit, plus Codes' releases with manifests and logs, trust tiers and playground runs; never a secret) and **delete** a project (owner, confirmed by name: Network archives it — it offers archiving, not erasure — then Codes deletes drafts, their manifests and playground runs, and revokes published releases so installers are told). Network's errors are shown with its status, code, detail and request id. |
| OAuth helper | `/oauth`, `/oauth/test-callback` | Explains authorization code + PKCE (S256) for apps, builds a test authorize URL, and a callback that shows `code`/`state`/`error` and **never exchanges** the code. |
| Webhook tools | `/tools/webhooks` | Verify a delivery as a receiver that requires signature v2 does: `X-OpenVibe-Signature-V2: t=<ts>,v2=<HMAC of "<ts>.<raw body>">` must match and `t` must be within ±300 s of now (the page shows the age and the window, and tells a stale-but-correct signature from a wrong one); `X-OpenVibe-Timestamp` must equal `t`; v1 `X-OpenVibe-Signature: sha256=<HMAC>` is checked and shown but never decides. In the browser with Web Crypto, or on the server without JavaScript with openvibe-sdk's `verifyDelivery`/`verifyDeliveryV2`; constant-time; secret dropped. Generate a sample delivery signed with v1 and v2 (`signDeliveryHeaders`) for any event type the contracts catalog lists. |
| Docs | `/docs/*` | Contracts (field tables, fixtures as examples, raw schema), capability catalog (grantable ones highlighted), event types, SDK reference from its `.d.ts` files, ADRs. Every page states the versions it was generated from. The service registry is read live from Network, with health as Network reports it. |
| Playgrounds | `/projects/:project/apps/:app/playground` | Media upload (sandbox, `media.object.upload`) and Events publish (`events.app.publish`: types `app.<project_key>.*`, source `app-<app ULID>`), run **as the app** with its own token (from its secret typed for that one request, or a pasted token). Refused — with the missing grant named, and nothing requested or called — unless Network lists the grant as approved. Sandbox apps only. |
| Manifests | `/manifests/validate`, `/projects/:project/apps/:app/releases/new` | Validate `codes.app-manifest@1` and `mods.mod-manifest@1` with openvibe-contracts; create, publish, deprecate and revoke releases. |
| Policy | `/policy/*` | Proposal process and the decision record; compatibility and deprecation policy rendered from ADR-002 and ADR-016 as published; licensing read from package metadata; transparency (what Codes stores and does not). |
| API | `/api/v1/*` | Public release reads (`codes.release.read`: no token needed; a presented token must hold it), manifest validation, docs versions; release management by an app with its own token (`codes.release.manage`). Guarded with openvibe-contracts `requireCapability`. RFC 9457 problems. |
| Machine | `/api/health`, `/api/ready`, `/release.json`, `/metrics` | Readiness is truthful (db and docs required; Network, JWKS, OAuth client and events relay reported as optional checks). `/metrics` answers loopback callers only. |

Everything is server-rendered and usable without JavaScript. The only scripts of Codes' own are optional: in-browser webhook verification and a copy button.

## Depends on

- **OpenVibe.Network** — SSO (OAuth client `codes`, PKCE S256), JWKS, `/api/v1/projects` (called server-side with the person's Network access token), the registry (`/api/v1/registry/services`, `/.well-known/openvibe`), client-credentials tokens (Codes' own for the events relay; the app's own in playgrounds).
- **OpenVibe.Events** — the outbox relay publishes `codes.app.*` with Codes' service token (`events.event.publish`); the Events playground calls it with the app's token (`events.app.publish`).
- **OpenVibe.Media** — the Media playground uploads with the app's token into the project's namespace.
- **openvibe-contracts** tag v0.27.0 (its package.json says 0.28.0; the docs show both), **openvibe-sdk v0.4.0**, **openvibe-shared v1.3.0** (pinned tag tarballs).

No path in Codes sends or accepts a shared loopback key (tested by grep and at runtime).

## Grants and registration the lead must add

In Network (`server/identity/principals.js` / `server/db/database.js`, as for coupons and host):

- OAuth client `codes`, name `OpenVibe.Codes`, redirect URI `https://openvibe.codes/auth/callback`.
- Service grant `['codes', 'events.event.publish', 'openvibe.events', []]` (the outbox relay).

The Codes service manifest, `codes.release.manage|read` and `codes.app-manifest@1` are released in openvibe-contracts (tag v0.27.0; this repository pins v0.28.0, same content); the CI contracts check is blocking.

For the playgrounds to succeed end to end (not Codes' code; configuration elsewhere): Network `DEV_SANDBOX_AUDIENCES` including `openvibe.media` and `openvibe.events`, a staff-set allowance containing `media.object.upload` and `events.app.publish` for the project, a Media tenant keyed by the project id, and OpenVibe.Events serving `events.app.publish` for app tokens. On 2026-09-23 these were in place on production: a sandbox app uploaded to Media (tenant `prj_…-sandbox`) and published and read app events through public endpoints. That run used curl, not the Codes playgrounds, and it is not yet a committed, repeatable check.

## Configuration

See [.env.example](.env.example). Required in production: `OV_OAUTH_CLIENT_SECRET`, `CODES_FORM_SECRET`, `BASE_URL`, `CODES_DB_PATH`. Optional: `EVENTS_URL` (relay), `CODES_STAFF_SUBJECTS`, `CODES_PLAYGROUND_*`, `CODES_REGISTRY_TTL_MS`.

## Deploy (for the lead)

1. `git clone` to `/opt/openvibe.codes`; `npm ci --omit=dev` with Node 22.
2. `/etc/openvibe/codes.env` from `.env.example` (secrets from the Network client registration).
3. `deploy/systemd/openvibe-codes.service` → `/etc/systemd/system/`; `systemctl enable --now openvibe-codes`. State lives in `/var/lib/openvibe-codes`.
4. `deploy/nginx/openvibe.codes.conf` → `/etc/nginx/sites-available/`, certificate for `openvibe.codes` + `www`, reload nginx.
5. Check `curl -s http://127.0.0.1:4900/api/ready`.
6. Only when the launch rule below holds: remove `openvibe.codes` from `OpenVibe.Sites/sites.json` and switch routing.

## Development

```bash
npm install
fnm exec --using=22.22.1 npm test          # every test/*.test.js on temp databases with mock Network, Events, Media
fnm exec --using=22.22.1 npm run dev       # http://localhost:4900
npx openvibe-contracts-check --service codes --src server
```

Tests: ADR-013 trust-tier migration; secrets never persisted or re-displayed; Network errors surfaced honestly (404/403/409/422/503, unreachable, expired session refresh); scope editor offers only grantable capabilities and refuses forged requests before Network sees them; generated docs match the pinned versions (every contract, capability, event type, SDK module); webhook verification, v1 and v2 (tampering, prefixes, lengths, the ±300 s window both ways, timestamp header mismatch, v1 never deciding, constant-time, the in-browser verifier agreeing); playgrounds refuse without the grant and call nothing; project export (complete, no secrets, audit for admin+ only, never partial) and delete (owner only, Network first, drafts and runs removed, public releases revoked with an event); manifest validation; release lifecycle and events; no internal key anywhere; PKCE sign-in; readiness, release.json, loopback metrics; the released codes manifest matching the code.

## Acceptance (must be true before "done")

- A new external developer goes from account to a working Media, event and capability integration with only public docs, the SDK and scoped credentials — no loopback key. **Partly shown: one production run on 2026-09-23 covered account, project, sandbox app, auto-approved grants, Media upload and app event publish/read with public endpoints (curl, not the SDK or the playgrounds). It is not committed as a repeatable check, and it did not cover webhook delivery to an external endpoint, publishing a release or revoking credentials.**
- Credentials can be inspected, scoped, rotated and revoked. **Yes, through Network's API (tested against a stand-in; not yet used on production).**
- The playground cannot exceed its project's grants. **Yes (tested).**
- A published app or mod release carries compatibility and trust metadata. **Yes (tested).**

## Launch rule

The domain keeps its placeholder page on [OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the following exist (plan §12.12). **Codes left Sites on 2026-09-23 and serves `openvibe.codes`.** The items: an owning runtime with health/readiness and observability (**done**); canonical identity/auth integration (**done; the OAuth client `codes` is registered**); server-rendered public routes useful without JavaScript (**done**); real persistence and end-to-end workflows (**persistence done; the external-developer path ran once on production with curl, not yet through the portal**); capability and event registration against OpenVibe.Contracts (**released**); a migration/seed strategy (none needed: no data is imported; raw old developer keys are never imported), a security review and sitemap/robots behaviour (**sitemap and robots done; the security review is the threat notes below, self-authored**); acceptance tests proving the advertised functionality (**against stand-ins**). Roadmap binding: do not launch Codes as a developer portal while these paths are mocked.

### Threat notes

- Session tokens are httpOnly (unlike the navbar-readable `ov_token` elsewhere) because this site displays secrets; forms carry an HMAC form token and require a same-site `Origin`.
- Secrets never reach logs: errors are logged without request bodies; playground failure details are scrubbed of the credential before they are stored or shown.
- Codes never fetches a URL a developer types (the webhook tester produces a `curl` for their own endpoint instead).
- Grant checks happen twice: Codes refuses to forward non-grantable capabilities, and Network decides. Playgrounds verify the app token's signature, subject, project, environment, audience and capability before calling anything.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
