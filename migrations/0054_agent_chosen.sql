-- phase: expand
-- An agent the person chose (the owner, 2026-11-21: they picked Claude Code; its attempt failed on their machine and
-- DeepSeek took the task over without a word, while the panel said Claude Code was Ready). A task whose agent the
-- person named is never switched to another agent by the engine: it ends saying what stopped the chosen one and how to
-- set it up (server/domain/attempts.js decide). Expand-only: one column with a default.
ALTER TABLE run_tasks ADD COLUMN IF NOT EXISTS agent_chosen boolean NOT NULL DEFAULT false;
