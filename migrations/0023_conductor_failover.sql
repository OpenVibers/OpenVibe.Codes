-- phase: expand
-- The conductor's failover (owner 2026-11-03): a person picks up to three agents (and models) their conductor falls back
-- to when its own agent is near or at its usage limit, and the point at which it switches. Each turn records the agent
-- and model it ran on, and why it switched, so the conversation shows the hand-over and the next turn of the same agent
-- resumes that agent's own session (server/domain/conductor-failover.js).
ALTER TABLE codes_user_settings ADD COLUMN IF NOT EXISTS conductor_fallbacks jsonb;     -- [{ agent, model }], in order
ALTER TABLE codes_user_settings ADD COLUMN IF NOT EXISTS conductor_switch_pct smallint;  -- 50..95; NULL = 90
ALTER TABLE codes_conductor_messages ADD COLUMN IF NOT EXISTS agent text;               -- the agent the turn ran on; NULL = claude-code (before 0023)
ALTER TABLE codes_conductor_messages ADD COLUMN IF NOT EXISTS model text;               -- the model it was asked for
ALTER TABLE codes_conductor_messages ADD COLUMN IF NOT EXISTS switch_note text;         -- why it is not the primary, in plain words
