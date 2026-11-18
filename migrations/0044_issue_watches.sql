-- phase: expand
-- GitHub issues as tasks (plan §AD.6, Codes next (2)): a person watches one of their repositories for a label; an
-- issue that gets the label after the watch began becomes one of their tasks (once: the task's idempotency key is
-- gh-issue:<owner>/<name>#<number>), with a pull request whose description says "Fixes #<number>", so merging it
-- closes the issue. server/domain/issue-tickets.js reads the repository's labeled issues every few minutes.
CREATE TABLE IF NOT EXISTS codes_issue_watches (
    id          text COLLATE "C" PRIMARY KEY,                -- iw_<ULID>
    subject     text COLLATE "C" NOT NULL,                   -- usr_… whose tasks they become
    repo        text COLLATE "C" NOT NULL,                   -- owner/name, lowercased
    label       text COLLATE "C" NOT NULL DEFAULT 'codes',
    created_at  timestamptz NOT NULL DEFAULT now(),
    checked_at  timestamptz,
    last_error  text COLLATE "C",
    tickets     integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS codes_issue_watches_repo ON codes_issue_watches (subject, repo);
