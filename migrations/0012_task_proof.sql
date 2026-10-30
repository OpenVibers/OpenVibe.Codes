-- phase: expand
-- Stage C8 (openvibe.codes v1): the proof of a finished task. "Proof, not promises": every task ends with its tests,
-- its screenshots, its diff and a second model's review.
--
-- The items live in codes_task_proof, one row per proof item of one attempt: the tests the change reached, the pages
-- it touched (phone and desktop), the diff, and the review. The task's row keeps the outcome in plain words
-- ("Done with proof", "Didn't finish, with what is left", "Stopped by you") in run_tasks.outcome / outcome_note, as
-- codes.task@2 states it.
--
-- The number is 0012 so it follows the run tokens of stage C3 (0011) without colliding with them.

CREATE TABLE IF NOT EXISTS codes_task_proof (
    id          text COLLATE "C" PRIMARY KEY,          -- prf_<ULID>
    task_id     text COLLATE "C" NOT NULL,             -- tsk_<ULID>
    attempt_n   integer NOT NULL DEFAULT 0,           -- the attempt the proof belongs to (0: the task itself)
    n           integer NOT NULL,                       -- the item's place in the proof (1, 2, …)
    kind        text COLLATE "C" NOT NULL,             -- tests | screenshots | diff | review
    label       text COLLATE "C" NOT NULL,             -- what a person reads: 'tests', 'screenshots', …
    ok          boolean NOT NULL,                       -- did it pass
    skipped     boolean NOT NULL DEFAULT false,         -- it could not run here (and why is in summary)
    summary     text COLLATE "C",                      -- one line, in plain words
    family      text COLLATE "C",                      -- the reviewer's model family
    detail      jsonb,                                  -- the item's own data (shots, stats, the patch)
    created_at  timestamptz NOT NULL DEFAULT now()
);
-- The fence: one proof item of one kind per attempt, so a second ending of the same attempt (the portal's
-- 10-30 bug) writes no second row and no second event.
CREATE UNIQUE INDEX IF NOT EXISTS codes_task_proof_item ON codes_task_proof (task_id, attempt_n, kind);
CREATE UNIQUE INDEX IF NOT EXISTS codes_task_proof_task_n ON codes_task_proof (task_id, n);
CREATE INDEX IF NOT EXISTS codes_task_proof_task ON codes_task_proof (task_id, attempt_n);
