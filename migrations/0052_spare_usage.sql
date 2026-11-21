-- phase: expand
-- Spare usage (plan §AD.37; the owner, 2026-11-21: "if the weekly reset's coming up and there's still usage available,
-- you should be able to set a task list if it's not doing something else already, so that you actually get every
-- ounce of your usage across all your code harnesses"). A person's list of things worth doing, and when the planner
-- (server/domain/spare.js) may start them: an agent whose plan window resets within reset_within_hours with at least
-- min_left_pct left, not busy with anything of theirs, takes the next one. Expand-only: two new tables.
CREATE TABLE IF NOT EXISTS codes_spare_settings (
    subject text COLLATE "C" PRIMARY KEY,
    enabled boolean NOT NULL DEFAULT false,
    reset_within_hours integer NOT NULL DEFAULT 12 CHECK (reset_within_hours BETWEEN 1 AND 168),
    min_left_pct integer NOT NULL DEFAULT 15 CHECK (min_left_pct BETWEEN 1 AND 100),
    keep_pct integer NOT NULL DEFAULT 5 CHECK (keep_pct BETWEEN 0 AND 50),
    max_running integer NOT NULL DEFAULT 1 CHECK (max_running BETWEEN 1 AND 4),
    agents jsonb,
    project_id text COLLATE "C",
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS codes_spare_tasks (
    id text COLLATE "C" PRIMARY KEY,
    subject text COLLATE "C" NOT NULL,
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
    prompt text NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 8000),
    repo text NOT NULL CHECK (char_length(repo) BETWEEN 1 AND 300),
    agent text COLLATE "C" NOT NULL DEFAULT 'any',
    priority integer NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
    repeat boolean NOT NULL DEFAULT false,
    state text COLLATE "C" NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'failed', 'paused')),
    task_id text COLLATE "C",
    last_agent text COLLATE "C",
    last_window text,
    note text CHECK (note IS NULL OR char_length(note) <= 400),
    runs integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS codes_spare_tasks_subject ON codes_spare_tasks (subject, state, priority, created_at);
CREATE INDEX IF NOT EXISTS codes_spare_tasks_running ON codes_spare_tasks (state) WHERE state = 'running';
