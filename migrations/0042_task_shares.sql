-- phase: expand
-- Shareable replays (plan §AD.6, Codes next (6)): a task's owner makes a link anyone can open to read the task as it
-- happened — the brief, every turn, the steps and the answers — without signing in. One row is one link: TOKEN is the
-- unguessable part of /r/<token> (24 random bytes, base64url), REVOKED_AT ends it. A task has at most one live link;
-- stopping and sharing again makes a new one, so an old link never comes back.
CREATE TABLE IF NOT EXISTS codes_task_shares (
    token       text COLLATE "C" PRIMARY KEY,
    task_id     text COLLATE "C" NOT NULL,               -- tsk_…
    subject     text COLLATE "C" NOT NULL,               -- usr_… who shared it (the task's owner)
    created_at  timestamptz NOT NULL DEFAULT now(),
    revoked_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS codes_task_shares_live ON codes_task_shares (task_id) WHERE revoked_at IS NULL;
