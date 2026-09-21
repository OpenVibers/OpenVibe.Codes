# OpenVibe.Codes

> The developer portal: registry and contract explorers, credentials, playgrounds, examples, mod/app publishing, governance.

**Status:** placeholder — planning only, no runnable code yet.  
**Domain:** `openvibe.codes`  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §15.2 and §15.5.  
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

A real developer portal launched only once Contracts, SDK, the registry, Events and Media are genuinely usable. Until then the domain stays a placeholder that says so.

## Owns

- project/app credentials and scope editor, OAuth callback helper, webhook tester and signed-event inspector
- docs generated from published contract and SDK versions
- playgrounds for Events/Realtime, Media uploads, Billing sandbox, Chat bots
- mod/app manifest editor/validator, publish/release/deprecate/revoke, trust tiers as metadata
- RFC process, compatibility/deprecation policy, contributor ladder, licensing and transparency pages
- scoped vibe-coding session publication

## Does not own

- the registry itself (Network), the contracts (Contracts), authority for any product

## Planned surfaces

- `apps/web` SSR portal, `apps/api` project/app/release metadata, `packages/docs-gen`, `packages/playground`, `packages/templates`, `workers/`

## Data (authority tables / families)

- projects, apps, credentials metadata (no raw secrets), releases, trust status, usage/trace views

## Capabilities and events

- `codes.project.*`, `codes.app.*`, `codes.release.*`, `codes.credential.revoke`

Events: ``codes.app.published|deprecated|revoked``

## Depends on

- OpenVibe.Contracts
- OpenVibe.SDK
- OpenVibe.Network (registry, principals)
- OpenVibe.Events
- OpenVibe.Media
- OpenVibe.Examples

## Acceptance (must be true before "done")

- a new external developer goes from account to a working Media/event/capability integration with only public docs, SDK and credentials — no loopback `X-Internal-Key`
- credentials can be scoped, rotated and revoked
- the playground cannot exceed its project grants

## Bootstrap / extraction source

Today's scattered docs (Live streaming docs, Tools dev tools, repo READMEs) plus the new Contracts/SDK/registry surfaces.

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following exist here (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability;
2. canonical identity/auth integration (OpenVibe.Network subjects, scoped service principals);
3. server-rendered or static public routes that are useful without JavaScript;
4. real persistence and end-to-end workflows;
5. capability and event registration against `OpenVibe.Contracts`;
6. a migration/seed strategy, a security/threat review, and sitemap/robots/feed behaviour;
7. acceptance tests proving the advertised functionality.

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and
registers maturity in the ecosystem registry atomically. A placeholder is never counted as an
implemented service.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
