-- phase: expand
-- The outbox's dead letters: an event OpenVibe.Events refuses (its envelope can never pass) is marked dead after a
-- fixed number of tries instead of being retried forever. dead_at says when it died, dead_reason why.
ALTER TABLE codes_outbox ADD COLUMN IF NOT EXISTS dead_at timestamptz;
ALTER TABLE codes_outbox ADD COLUMN IF NOT EXISTS dead_reason text COLLATE "C";   -- refused | failed
CREATE INDEX IF NOT EXISTS codes_outbox_dead ON codes_outbox (dead_at) WHERE dead_at IS NOT NULL;
