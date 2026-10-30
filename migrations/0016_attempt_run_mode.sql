-- phase: expand
-- How an attempt was paid for: 'ai' (it ran through OpenVibe.AI under a run token, metered by the task's budget),
-- 'plan' (the person's own CLI subscription on their machine: no AI token, nothing metered), 'none' (no run token
-- could be minted, so the harness ran as it did before).
ALTER TABLE codes_attempts ADD COLUMN IF NOT EXISTS run_mode text COLLATE "C";
