-- phase: expand
-- Ask 354: a message to a running task. A Run job on the person's own machine cannot be interrupted mid-run, so a
-- message sent while an attempt is live waits here (the conductor's turn queue, codes_conductor_messages, works the
-- same way): when the attempt ends, the next attempt carries the waiting notes in its prompt. n is the message's
-- place in the queue; state is queued until an attempt takes it, then delivered. Every row hangs under a task and is
-- erased with it (server/account-data.js).

CREATE TABLE IF NOT EXISTS codes_task_messages (
    id          text COLLATE "C" PRIMARY KEY,             -- msg_<ULID>
    task_id     text COLLATE "C" NOT NULL REFERENCES run_tasks(id) ON DELETE CASCADE,
    n           integer NOT NULL,                         -- 1, 2, … the message's place in the queue
    text        text NOT NULL,                            -- what the person said (at most 4000 characters)
    state       text COLLATE "C" NOT NULL,                -- queued | delivered
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS codes_task_messages_task_n ON codes_task_messages (task_id, n);
CREATE INDEX IF NOT EXISTS codes_task_messages_queued ON codes_task_messages (task_id) WHERE state = 'queued';
