-- phase: expand
-- OpenVibe.Codes: task events in and out (plan 2026-10-28 §6, decisions 2 and 3). run.job.* deliveries are claimed in
-- codes_events_inbox in the same transaction that finalizes the task, so a replay changes nothing. Every state change
-- writes its codes.task.* event into codes_outbox in the same transaction; the publisher sends each fixed evt_ id
-- once, backs off on failure and survives a restart. started_at/finished_at are the Run timings carried in the event
-- payload (run_tasks.updated_at stays the local write clock).
ALTER TABLE run_tasks ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE run_tasks ADD COLUMN IF NOT EXISTS finished_at timestamptz;
CREATE INDEX IF NOT EXISTS run_tasks_job_id ON run_tasks (job_id) WHERE job_id IS NOT NULL;

-- Inbound OpenVibe.Events deliveries already applied: a redelivery is a no-op.
CREATE TABLE IF NOT EXISTS codes_events_inbox (
    event_id     text COLLATE "C" PRIMARY KEY,                 -- evt_<ULID>
    event_type   text COLLATE "C" NOT NULL,
    task_id      text COLLATE "C",                             -- tsk_… when the event named a Codes task
    outcome      text COLLATE "C",
    processed_at timestamptz NOT NULL DEFAULT now()
);

-- The fixed Events evt_ id is chosen when the row is written, so a retry (or a restart) never makes a second event.
CREATE TABLE IF NOT EXISTS codes_outbox (
    event_id        text COLLATE "C" PRIMARY KEY,              -- evt_<ULID>
    topic           text COLLATE "C" NOT NULL,                 -- codes.task.queued|running|succeeded|failed|cancelled
    subject         text COLLATE "C" NOT NULL,                 -- usr_… the task's owner
    payload         jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    published_at    timestamptz,
    attempts        integer NOT NULL DEFAULT 0,
    last_error      text,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    claimed_at      timestamptz,
    claimed_by      text
);
CREATE INDEX IF NOT EXISTS codes_outbox_pending ON codes_outbox (next_attempt_at) WHERE published_at IS NULL;
