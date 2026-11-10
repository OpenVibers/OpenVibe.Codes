-- phase: expand
-- AL5: a ticket follows its pull request. One row per ticket (task) bound to a PR: which repo and PR number, the
-- role it plays there, how the PR was found, and the automatic fixes so far. A red check, a conflict or a review
-- comment on the PR wakes the same worker (a follow-up Run job on the PR branch); at most 3 automatic fixes per
-- PR; a person's "stop" or a merged/closed PR ends the binding. Nothing here holds a secret.
CREATE TABLE pr_bindings (
    id               text COLLATE "C" PRIMARY KEY,               -- prb_<ULID>
    task_id          text COLLATE "C" NOT NULL,                  -- tsk_… the ticket's current task (moves to each follow-up)
    repo             text COLLATE "C" NOT NULL,                  -- owner/name, lowercased
    pr_number        integer NOT NULL CHECK (pr_number > 0),
    role             text COLLATE "C" NOT NULL,                  -- review|verify|fix
    how_found        text COLLATE "C" NOT NULL,                  -- created|worktree|review
    branch           text COLLATE "C",                            -- the PR branch a follow-up pushes to (update, never a new PR)
    state            text COLLATE "C" NOT NULL DEFAULT 'active', -- active|ended
    fix_count        integer NOT NULL DEFAULT 0,                 -- automatic fixes this binding's task lineage used
    ended_reason     text COLLATE "C",                            -- merged|closed|stopped_by_person
    last_wake_at     bigint,
    last_wake_reason text COLLATE "C",
    created_at       bigint NOT NULL,
    updated_at       bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS pr_bindings_pr ON pr_bindings (repo, pr_number);
CREATE INDEX IF NOT EXISTS pr_bindings_task ON pr_bindings (task_id);
