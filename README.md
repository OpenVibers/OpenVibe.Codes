# OpenVibe.Codes

> The developer portal: projects and apps over OpenVibe.Network, scoped credentials, generated contract and SDK docs, OAuth and webhook tools, grant-respecting playgrounds, manifest validation and release metadata.

**Status:** alpha (roadmap Wave 20). Runs and is tested against in-process stand-ins for Network, Events and Media. **Not deployed**; `openvibe.codes` still serves its placeholder from [OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites). See [STATUS.json](STATUS.json) for exactly what works and what does not.
**Domain:** `openvibe.codes` · **Port:** 4900 · **Service id:** `codes`
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §15.17, §24.2 (proof flow 6), §30; binding decision ADR-014 in OpenVibe.Contracts.
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

A place where a developer outside the network goes from an OpenVibe account to a working, scoped integration using only public docs, the SDK and their own credentials. Codes is a **portal**: the identity authority (OpenVibe.Network) owns projects, apps, credentials, grants and quotas (ADR-014), and Codes shows and forwards what the signed-in person asks for, with that person's own Network token.

## Owns

- **Release metadata** keyed to Network app ids: validated app and mod manifests, releases (`draft → published → deprecated → revoked`), an append-only release log.
- **Trust tiers** (`untrusted`, `verified`, `trusted`, `platform-maintained`) — **metadata only**; a tier never grants, allows or bypasses anything.
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
| Portal | `/projects`, `/projects/:project`, `/projects/:project/apps/:app` | Create projects; add members; create sandbox/production apps (secret shown once); rotate and revoke credentials; request, approve, deny and revoke grants through a scope editor that offers only grantable capabilities (public, or partner when in the allowance) with each one's description, owner and visibility; quotas; audit (admin+). Network's errors are shown with its status, code, detail and request id. |
| OAuth helper | `/oauth`, `/oauth/test-callback` | Explains authorization code + PKCE (S256) for apps, builds a test authorize URL, and a callback that shows `code`/`state`/`error` and **never exchanges** the code. |
| Webhook tools | `/tools/webhooks` | Verify `X-OpenVibe-Signature: sha256=<HMAC>` against a raw body (in the browser with Web Crypto, or on the server without JavaScript, constant-time, secret dropped); generate a signed sample delivery for any event type the contracts catalog lists. |
| Docs | `/docs/*` | Contracts (field tables, fixtures as examples, raw schema), capability catalog (grantable ones highlighted), event types, SDK reference from its `.d.ts` files, ADRs. Every page states the versions it was generated from. The service registry is read live from Network, with health as Network reports it. |
| Playgrounds | `/projects/:project/apps/:app/playground` | Media upload (sandbox) and Events publish, run **as the app** with its own token (from its secret typed for that one request, or a pasted token). Refused — with the missing grant named, and nothing requested or called — unless Network lists the grant as approved. Sandbox apps only. |
| Manifests | `/manifests/validate`, `/projects/:project/apps/:app/releases/new` | Validate `mods.mod-manifest@1` and app manifests with openvibe-contracts; create, publish, deprecate and revoke releases. |
| Policy | `/policy/*` | Proposal process and the decision record; compatibility and deprecation policy rendered from ADR-002 and ADR-016 as published; licensing read from package metadata; transparency (what Codes stores and does not). |
| API | `/api/v1/*` | Public release reads, manifest validation, docs versions; release management by an app with its own token (`codes.release.manage`, proposed). RFC 9457 problems. |
| Machine | `/api/health`, `/api/ready`, `/release.json`, `/metrics` | Readiness is truthful (db and docs required; Network, JWKS, OAuth client and events relay reported as optional checks). `/metrics` answers loopback callers only. |

Everything is server-rendered and usable without JavaScript. The only scripts of Codes' own are optional: in-browser webhook verification and a copy button.

## Depends on

- **OpenVibe.Network** — SSO (OAuth client `codes`, PKCE S256), JWKS, `/api/v1/projects` (called server-side with the person's Network access token), the registry (`/api/v1/registry/services`, `/.well-known/openvibe`), client-credentials tokens (Codes' own for the events relay; the app's own in playgrounds).
- **OpenVibe.Events** — the outbox relay publishes `codes.app.*` with Codes' service token (`events.event.publish`); the Events playground calls it with the app's token.
- **OpenVibe.Media** — the Media playground uploads with the app's token into the project's namespace.
- **openvibe-contracts v0.26.0**, **openvibe-sdk v0.2.2**, **openvibe-shared v1.3.0** (pinned tag tarballs).

No path in Codes sends or accepts a shared loopback key (tested by grep and at runtime).

## Grants and registration the lead must add

In Network (`server/identity/principals.js` / `server/db/database.js`, as for coupons and host):

- OAuth client `codes`, name `OpenVibe.Codes`, redirect URI `https://openvibe.codes/auth/callback`.
- Service grant `['codes', 'events.event.publish', 'openvibe.events', []]` (the outbox relay).

In OpenVibe.Contracts (next release): the service manifest `docs/service-manifest-proposal.json`, the capabilities in `docs/capabilities-proposal/`, and the contract `codes.app-manifest@1` from `docs/contracts-proposal/`.

For the playgrounds to succeed end to end (not Codes' code; configuration elsewhere): Network `DEV_SANDBOX_AUDIENCES` including `openvibe.media` (and `openvibe.events`), a staff-set allowance containing `media.object.upload` for the project, and a Media tenant keyed by the project id. `events.event.publish` is `internal` in contracts v0.26.0, so no app can publish events until Events publishes a public capability; the playground says so.

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

Tests: secrets never persisted or re-displayed; Network errors surfaced honestly (404/403/409/422/503, unreachable, expired session refresh); scope editor offers only grantable capabilities and refuses forged requests before Network sees them; generated docs match the pinned versions (every contract, capability, event type, SDK module); webhook verification (tampering, prefixes, lengths, constant-time); playgrounds refuse without the grant and call nothing; manifest validation; release lifecycle and events; no internal key anywhere; PKCE sign-in; readiness, release.json, loopback metrics; proposals valid against the contract schemas.

## Acceptance (must be true before "done")

- A new external developer goes from account to a working Media, event and capability integration with only public docs, the SDK and scoped credentials — no loopback key. **Codes' part is built; the path end to end also needs the Network registration, sandbox audiences, a project Media tenant and a public events capability listed above.**
- Credentials can be inspected, scoped, rotated and revoked. **Yes, through Network's API (tested against a stand-in).**
- The playground cannot exceed its project's grants. **Yes (tested).**
- A published app or mod release carries compatibility and trust metadata. **Yes (tested).**

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on [OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the following exist (plan §12.12): an owning runtime with health/readiness and observability (**done**); canonical identity/auth integration (**done in code; the OAuth client is not registered**); server-rendered public routes useful without JavaScript (**done**); real persistence and end-to-end workflows (**persistence done; end-to-end blocked on the items above**); capability and event registration against OpenVibe.Contracts (**proposed, not released**); a migration/seed strategy (none needed: no data is imported; raw old developer keys are never imported), a security review and sitemap/robots behaviour (**sitemap and robots done**); acceptance tests proving the advertised functionality (**against stand-ins**). Roadmap binding: do not launch Codes as a developer portal while these paths are mocked.

### Threat notes

- Session tokens are httpOnly (unlike the navbar-readable `ov_token` elsewhere) because this site displays secrets; forms carry an HMAC form token and require a same-site `Origin`.
- Secrets never reach logs: errors are logged without request bodies; playground failure details are scrubbed of the credential before they are stored or shown.
- Codes never fetches a URL a developer types (the webhook tester produces a `curl` for their own endpoint instead).
- Grant checks happen twice: Codes refuses to forward non-grantable capabilities, and Network decides. Playgrounds verify the app token's signature, subject, project, environment, audience and capability before calling anything.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
