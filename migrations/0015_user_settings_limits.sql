-- phase: expand
-- Codes C9a: the person's own limits, in Settings → Limits. Steps per task (tool calls) and minutes per task (wall
-- clock), for every harness at once; null means no limit, never a zero budget. The harness's own caps follow them
-- (engine/budget.js caps): its turn cap sits 25 above the step limit and its wall clock 5 minutes past the time limit.
--
-- Two nullable integers on the settings row, so a person without limits needs no row and the existing defaults stand.

ALTER TABLE codes_user_settings
    ADD COLUMN IF NOT EXISTS steps integer,      -- steps per task: null = no limit
    ADD COLUMN IF NOT EXISTS minutes integer;    -- minutes per task: null = no limit
