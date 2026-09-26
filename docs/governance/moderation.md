# Moderation policy

**Draft — pending owner review.** This text is a proposal. It takes effect only when the owner of the OpenVibers organization approves it and removes this line.

This policy explains how OpenVibe moderates its developer spaces: the OpenVibers repositories, OpenVibe.Codes, and the apps and releases published through it. Viewer- and streamer-facing products (Live, Chat, Community) keep their own moderation rules; this policy does not change them.

## What can be moderated

- **Conduct** in issues, pull requests, discussions and reviews, under the [code of conduct](https://openvibe.codes/policy/code-of-conduct).
- **Releases** published in Codes: a release that is malicious, misleading about what it does, infringes someone's rights, or breaks the platform's rules.
- **Apps and projects**: an app that abuses its grants, tries to get around them, or harms the people who use it.
- **Trust tiers** (unreviewed, reviewed, first-party): these are information only. A tier never grants or blocks anything; changing one is a note to users, not a sanction.

## What moderators can do

From mildest to most serious. Moderators pick the mildest step that fixes the problem.

1. **Note.** A private message explaining the problem and what to change.
2. **Hide or lock.** Hide a comment, or lock an issue or discussion that has turned hostile.
3. **Warning.** A recorded warning, public or private.
4. **Deprecate or revoke a release.** A deprecated release still works and shows a reason; a revoked release is marked revoked with a public reason, and the revocation is announced through the `codes.app.revoked` event to apps that follow it.
5. **Revoke grants or credentials.** OpenVibe.Network staff can revoke an app's grants, change a project's allowance, revoke credentials or revoke the app. The app loses access immediately.
6. **Archive a project.** Every app in it is revoked. This cannot be undone.
7. **Ban.** A temporary or permanent ban from the repositories and from creating projects.

## How decisions are made

- Anyone can report a problem to Contact@OpenVibe.Network. Security problems in someone's app go to the same address.
- Moderators are the maintainers of the affected repository and OpenVibe staff; for anything beyond a note, at least one moderator other than the person who acted reviews it, unless the harm is immediate.
- **Immediate harm** (credentials leaked in public, a release that attacks people who install it, threats, sexual content involving minors, doxxing): moderators act first and explain afterwards.
- Moderators who are involved in the dispute do not take part in the decision.
- The owner of the organization has the final say.

## Transparency

- Revocation and deprecation reasons for releases are public on the release page, and changes to trust tiers are listed in the app's public trust history.
- Network keeps an append-only audit log of changes to projects, apps, credentials and grants; project admins can read it for their own project, and can download it with the project export.
- A release revoked by Codes staff who could not manage it as project members, and every trust tier change, are also reported as `codes.moderation.action` to the network's moderation audit log, which OpenVibe staff can read.
- Reports and the identity of the people who report stay confidential.

## Appeals

If you think a decision was wrong, write to Contact@OpenVibe.Network within 30 days, say which decision and why. Someone who took no part in the original decision reviews it and answers in writing. A decision can be kept, reduced or reversed. A reversed revocation cannot bring a release back (revoked is final), but the app can publish a new version.

## Open questions for the owner

- Confirm the report and appeal address (the draft uses Contact@OpenVibe.Network).
- The appeal window (30 days).
- Whether to publish periodic moderation statistics.
