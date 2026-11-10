-- phase: expand
-- AL1: keep the task's outcome, typed check, and independent verifier record with the task itself.
ALTER TABLE run_tasks
    ADD COLUMN IF NOT EXISTS goal jsonb,
    ADD COLUMN IF NOT EXISTS goal_verdict jsonb;
