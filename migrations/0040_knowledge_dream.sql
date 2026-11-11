-- phase: expand
-- The nightly dream pass rechecks auto-captured knowledge against its source task's saved transcript.
-- Unsupported rows remain visible to their owner but are omitted from the next agent's prompt.
ALTER TABLE codes_knowledge ADD COLUMN IF NOT EXISTS dream_status text COLLATE "C" NOT NULL DEFAULT 'active'
    CHECK (dream_status IN ('active', 'unsupported'));

CREATE TABLE IF NOT EXISTS codes_knowledge_dream_state (
    name text COLLATE "C" PRIMARY KEY,
    last_at bigint NOT NULL,
    cursor text COLLATE "C" NOT NULL DEFAULT ''
);
