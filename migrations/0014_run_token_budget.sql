-- phase: expand
-- The budget a run token carries (Codes C3), and where the money an attempt spent went.
--
-- codes_run_tokens: the budget the minted token carries (null: no cap). OpenVibe.AI holds the counter for it, keyed by
-- the token's jti; these columns say what the token was given, so a run can be traced without asking AI.
-- codes_attempts: the budget the attempt was given, and the limit that stopped it ('usd', 'tokens', 'steps', 'minutes').
--
-- The budget is never raised here: it is what the task's limits (a benchmark's per-task limits) or the person's default
-- says, and it is written once, when the attempt's token is minted.
ALTER TABLE codes_run_tokens ADD COLUMN IF NOT EXISTS budget_usd double precision;
ALTER TABLE codes_run_tokens ADD COLUMN IF NOT EXISTS budget_tokens bigint;

ALTER TABLE codes_attempts ADD COLUMN IF NOT EXISTS budget_usd double precision;
ALTER TABLE codes_attempts ADD COLUMN IF NOT EXISTS budget_tokens bigint;
ALTER TABLE codes_attempts ADD COLUMN IF NOT EXISTS budget_hit text COLLATE "C";   -- usd | tokens | steps | minutes
