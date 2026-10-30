-- phase: expand
-- Codes C9b: the conductor. A long-lived task whose single attempt is one Claude Code session on a machine the person
-- chooses: the orchestrator that used to be a Claude Code session on the workstation, now running in openvibe.codes.
--
-- run_tasks grows the kind of work it holds and, for a conductor, what the session needs:
--   kind      code (a coding task, the default) | conductor
--   folder    the working folder Claude Code opens, so it loads that project's memory and AGENTS.md
--   model     the conductor's model (opus by default); the row's own, so a page can show it before a job exists
--   machine   the machine the person chose (a node principal, nod_…), or NULL for the person's default
--   safety    ask | project | full: the person's safety level for this session
--
-- codes_conductor_messages is the conductor's turn queue. A message becomes the next turn of the session (Claude Code
-- --resume) and waits while a turn runs. n is the turn's place: the first message is the hand-over brief.
--
-- codes_approvals is the approvals inbox. When the safety level is ask, a risky tool call is written here by the
-- approve MCP tool and waits for the person to decide from the phone; the command is shown, never the whole input.
--
-- Every row hangs under a task and is erased with it (server/account-data.js).

ALTER TABLE run_tasks ADD COLUMN IF NOT EXISTS kind text COLLATE "C" NOT NULL DEFAULT 'code';
ALTER TABLE run_tasks ADD COLUMN IF NOT EXISTS folder text COLLATE "C";
ALTER TABLE run_tasks ADD COLUMN IF NOT EXISTS model text COLLATE "C";
ALTER TABLE run_tasks ADD COLUMN IF NOT EXISTS machine text COLLATE "C";
ALTER TABLE run_tasks ADD COLUMN IF NOT EXISTS safety text COLLATE "C";

CREATE TABLE IF NOT EXISTS codes_conductor_messages (
    id          text COLLATE "C" PRIMARY KEY,             -- msg_<ULID>
    task_id     text COLLATE "C" NOT NULL,                -- tsk_<ULID>
    n           integer NOT NULL,                         -- 1, 2, … the turn's place in the session
    prompt      text NOT NULL,                            -- what the person said (or the hand-over brief)
    attachments jsonb,                                    -- [{ name, mime, data }] images, written as files on the machine
    state       text COLLATE "C" NOT NULL,                -- queued | running | done | failed | stopped
    job_id      text COLLATE "C",                         -- Run's job for this turn
    session     text COLLATE "C",                         -- the harness session this turn left behind
    result      jsonb,                                    -- what the turn answered
    error       text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    started_at  timestamptz,
    finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS codes_conductor_messages_task_n ON codes_conductor_messages (task_id, n);
CREATE INDEX IF NOT EXISTS codes_conductor_messages_task ON codes_conductor_messages (task_id, n);
CREATE INDEX IF NOT EXISTS codes_conductor_messages_job ON codes_conductor_messages (job_id) WHERE job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS codes_approvals (
    id          text COLLATE "C" PRIMARY KEY,             -- apr_<ULID>
    task_id     text COLLATE "C" NOT NULL,                -- tsk_<ULID>
    attempt_id  text COLLATE "C",
    tool        text COLLATE "C" NOT NULL,                -- the tool that wants to run
    input       jsonb,                                    -- its arguments, for the record (never shown whole)
    summary     text COLLATE "C",                         -- the command or file, one line, what the person reads
    decision    text COLLATE "C",                         -- allow | deny | always; NULL while it waits
    message     text COLLATE "C",                         -- what the person said
    created_at  timestamptz NOT NULL DEFAULT now(),
    decided_at  timestamptz
);
CREATE INDEX IF NOT EXISTS codes_approvals_task ON codes_approvals (task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS codes_approvals_pending ON codes_approvals (task_id) WHERE decision IS NULL;
