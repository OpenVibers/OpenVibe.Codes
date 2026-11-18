-- phase: expand
-- Each coding agent set up the way the person wants it (2026-11-18, /settings/agents, server/domain/harness-prefs.js):
-- per agent id, code mode (strict, beside, off, or the person's switch), the model and reasoning it starts on, and
-- standing instructions. Older releases ignore the column.
ALTER TABLE codes_user_settings ADD COLUMN IF NOT EXISTS harness_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
