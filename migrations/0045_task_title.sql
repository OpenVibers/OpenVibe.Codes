-- phase: expand
-- A task's own name (plan §AD.8: the session's ⋯ menu, Rename): the person names it; without one the title is the
-- brief's first line, as before (server/domain/task-summary.js titleOf).
ALTER TABLE run_tasks ADD COLUMN IF NOT EXISTS title text COLLATE "C";
