# Contributor ladder

**Draft — pending owner review.** This text is a proposal. It takes effect only when the owner of the OpenVibers organization approves it and removes this line.

This describes the roles people can hold in the OpenVibers repositories, what each role may do, and how someone moves from one role to the next. Today one owner maintains every repository; this ladder is how other people can take on more over time.

Roles are held per repository (or per group of related repositories), not across the whole organization. Someone can be a maintainer of OpenVibe.SDK and a contributor everywhere else.

## Participant

Anyone who opens an issue, comments, answers a question or reports a bug.

- **Can:** open issues and discussions, comment, review pull requests (comments only).
- **Expected to:** follow the [code of conduct](https://openvibe.codes/policy/code-of-conduct).

## Contributor

Someone who has had at least one pull request merged.

- **Can:** everything a participant can; be assigned issues.
- **Expected to:** follow the [contribution guide](https://openvibe.codes/policy/contributing), and respond to review on their own pull requests.
- **How to become one:** get a pull request merged.

## Reviewer

A contributor trusted to review other people's changes in a repository.

- **Can:** approve pull requests (an approval counts toward merging), label and triage issues.
- **Expected to:** review within a reasonable time or say they cannot; check tests, contracts and the platform's rules (no shared internal keys, no secrets stored or logged, each service owns its data); be kind and specific.
- **How to become one:** several substantial merged pull requests in the repository over at least two months, and good reviews of others' changes. A maintainer proposes it; the maintainers of that repository agree.

## Maintainer

Someone responsible for a repository: its direction, its releases and its quality.

- **Can:** merge pull requests; cut releases and tags; accept or decline proposals that affect only their repository; take part in moderation decisions.
- **Expected to:** keep `main` releasable and tests passing; keep the README and status notes honest; follow the [compatibility policy](https://openvibe.codes/policy/compatibility) (deprecate before removing, announce breaking changes); take part in proposals that touch their repository's interfaces.
- **How to become one:** sustained work as a reviewer, with good judgement about compatibility and security. Existing maintainers propose it; the owner approves.
- **Deploy access** (production servers, secrets) is separate from maintainer rights and is given only by the owner, to named people, for named services.

## Owner

The owner of the OpenVibers organization.

- **Can:** everything; grant and remove roles; approve changes to governance documents (including this one); decide proposals that span several services when maintainers do not agree.
- **Expected to:** explain decisions that affect contributors, in public where possible.

## Stepping down and inactivity

Anyone can step down from a role at any time by saying so. A reviewer or maintainer who has not been active for six months may be moved to emeritus status after being asked; they can return by asking. Roles can also be removed under the [moderation policy](https://openvibe.codes/policy/moderation).

## Open questions for the owner

- Whether roles are per repository (as drafted) or organization-wide.
- The time thresholds (two months, six months).
- Who else, if anyone, holds reviewer or maintainer roles today.
