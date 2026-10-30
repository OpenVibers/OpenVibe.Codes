-- phase: expand
-- Codes C4b: a person's own workspace choices. The Settings screen remembers the default agent, the default machine,
-- their notifications and their safety level per person, so a signed-in visitor finds their choices where they left
-- them. One row per person; no other table holds a preference (run_tasks holds work, codes_attempts its attempts).
--
-- The row holds ids a person already sees (a harness id such as codex, a node principal nod_…, a level) and three
-- yes/no choices. It holds no secret: the provider keys live in OpenVibe.AI (codes_connections is not a table here).

CREATE TABLE IF NOT EXISTS codes_user_settings (
    subject         text COLLATE "C" PRIMARY KEY,      -- usr_<ULID>
    default_agent   text COLLATE "C",                  -- a harness id from the catalog, or null for Auto
    default_machine text COLLATE "C",                  -- a node principal (nod_…), or null for Auto
    notify_done     boolean NOT NULL DEFAULT true,     -- tell me when a task finishes
    notify_needs    boolean NOT NULL DEFAULT true,     -- tell me when a task needs me
    safety          text COLLATE "C" NOT NULL DEFAULT 'ask',   -- ask | project | full
    updated_at      timestamptz NOT NULL DEFAULT now()
);
