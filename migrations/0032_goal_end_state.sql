-- phase: expand
-- AL1: the honest end state of a goal task (ready, waiting, blocked, failed, dropped, stopped_by_budget), and the
-- model turns an attempt used so a goal's turn budget can be counted across attempts.
ALTER TABLE run_tasks
    ADD COLUMN IF NOT EXISTS end_state text;
ALTER TABLE codes_attempts
    ADD COLUMN IF NOT EXISTS turns integer;
