-- phase: expand
-- Code mode (2026-11-18, runner 0.13.0, harness/code-mode.js): a person's switch for Claude Code working in scripts
-- (Codes' own ov_code server, since Claude Code's own Code Mode works only in a terminal). Off until they turn it on.
-- Older releases ignore the column.
ALTER TABLE codes_user_settings ADD COLUMN IF NOT EXISTS code_mode boolean NOT NULL DEFAULT false;
