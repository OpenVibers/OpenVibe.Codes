# Contributing to OpenVibe

**Draft — pending owner review.** This text is a proposal. It takes effect only when the owner of the OpenVibers organization approves it and removes this line.

Thank you for helping. This guide covers every OpenVibers repository; a repository's own README adds anything specific to it (how to run it, its tests, its deploy rules). By taking part you agree to the [code of conduct](https://openvibe.codes/policy/code-of-conduct).

## Where things live

- Each service has its own repository under [github.com/OpenVibers](https://github.com/OpenVibers): OpenVibe.Network (identity, projects, apps, grants), OpenVibe.Live, OpenVibe.Media, OpenVibe.Events, OpenVibe.Chat, OpenVibe.Codes (this portal), and others.
- Interfaces between services live in OpenVibe.Contracts: schemas, capabilities, event types, service manifests and the decision record (ADRs).
- The client library for apps is OpenVibe.SDK (`openvibe-sdk`). Working examples are in OpenVibe.Examples.

## Before you start

- For a bug, open an issue in the repository that has it: what you did, what you expected, what happened, and the version (the service's `/release.json`, or the package version).
- For a small fix (a typo, a clear bug with an obvious fix), you can open a pull request straight away.
- For anything that changes a public interface — a contract, a capability, an event type, an API route others call — start with a proposal, as described in [proposals and decisions](https://openvibe.codes/policy/rfc). A pull request that changes an interface without an accepted proposal will be asked to open one first.
- Security problems: do not open a public issue. Write to Contact@OpenVibe.Network with the details and give us time to fix it before you publish anything.

## Making a change

1. Fork the repository and create a branch from `main`.
2. Use Node.js 22 (the version production runs). Install with `npm ci` and run the tests with `npm test`; they use temporary databases and in-process stand-ins, so they need no network and no real service.
3. Match the code around you. Most repositories use CommonJS (`require`), four-space indentation, single quotes and semicolons; there is no formatter, so keep diffs small and in the existing style.
4. Add or change tests with your change. A fix comes with a test that fails without it.
5. Keep each commit focused on one thing, with a message that says what changed and why.
6. Run `node --check` on the files you touched and the full `npm test`. Services that own capabilities also run `npx openvibe-contracts-check`; CI runs it too.
7. Open a pull request that explains the problem, the change, and how you tested it. Link the issue or proposal.

## What reviewers look for

- The change does what the pull request says, and nothing else.
- Tests cover it and pass.
- It keeps the platform's rules: services talk to each other through published contracts and scoped credentials, never shared internal keys; secrets are never stored in plain text, logged or shown twice; each service owns its own data.
- Public text is plain and accurate. It does not promise features that do not exist yet.

A maintainer may ask for changes. When the pull request is approved and CI passes, a maintainer merges it. Deploying is a separate step that maintainers do.

## Licensing

Each repository's LICENSE file applies to contributions to it. The services are licensed under the AGPL-3.0; the SDK and contracts packages have their own licenses, shown on the [licensing page](https://openvibe.codes/policy/licensing). By opening a pull request you confirm that you have the right to contribute the code under that repository's license. Do not add code you copied from somewhere whose license does not allow it.

## Growing as a contributor

Regular contributors can become reviewers and maintainers. How that works is described in the [contributor ladder](https://openvibe.codes/policy/contributor-ladder).

## Open questions for the owner

- Whether to require a sign-off (Developer Certificate of Origin) or a contributor license agreement.
- Confirm the security reporting address (the draft uses Contact@OpenVibe.Network).
