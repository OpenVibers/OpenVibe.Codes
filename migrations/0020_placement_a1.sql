-- phase: expand
-- Placement A1 (agent plan 2026-10-30): Codes places each task's harness with openvibe-sdk/placement's place(), shows
-- the one line saying why on the task's timeline, and learns from the task's end.
--
-- codes_user_settings grows the person's two placement rules, off by default: noCloud ("Never send my code to the
-- cloud") and onlyFree ("Only free"). They are settings, not secrets, and a person without a row reads both false.
--
-- run_tasks grows the placement's one plain line and the option key it chose, so the timeline can say "Placed: …" and
-- the task's end can record one outcome for that option. placement_recorded makes the record exactly once, however
-- many times a terminal event is delivered. None of these columns holds a prompt, a key or a path: the line is the
-- SDK's fixed template, the key is the public option key.
--
-- placement_outcomes is the learned count, one row per (person, option key, step kind): two weights and a time. It
-- holds no text and no payload. Global counts are a SUM over these rows, read through a five-minute cache. The rows
-- are exported and erased with the person (server/account-data.js).

ALTER TABLE codes_user_settings
    ADD COLUMN IF NOT EXISTS no_cloud boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS only_free boolean NOT NULL DEFAULT false;

ALTER TABLE run_tasks
    ADD COLUMN IF NOT EXISTS placement_line text COLLATE "C",
    ADD COLUMN IF NOT EXISTS placement_option_key text COLLATE "C",
    ADD COLUMN IF NOT EXISTS placement_step_kind text COLLATE "C",
    ADD COLUMN IF NOT EXISTS placement_recorded boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS placement_outcomes (
    person_id  text COLLATE "C" NOT NULL,        -- usr_<ULID>
    option_key text COLLATE "C" NOT NULL,        -- the SDK's optionKey(offer)
    step_kind  text COLLATE "C" NOT NULL,        -- the task's kind, harness.edit / harness.review
    ok_w       double precision NOT NULL DEFAULT 0,   -- decayed successes
    n_w        double precision NOT NULL DEFAULT 0,   -- decayed tries
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (person_id, option_key, step_kind)
);
CREATE INDEX IF NOT EXISTS placement_outcomes_updated ON placement_outcomes (updated_at);
