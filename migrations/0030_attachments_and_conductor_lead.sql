-- phase: expand
-- Full file support in every composer (owner 2026-11-07): any file a person attaches to a message, stored in Codes'
-- own database, owner-only, and handed to the agent as a file in its workspace. The bytes live in `data` (bytea), never
-- in the message's JSON, so a 20 MB file is one row and not a 27 MB jsonb string.
--
--   subject      the person who uploaded it (every read and link is scoped to it)
--   task_id      set when the upload is attached to a task; NULL while it waits in the composer
--   attempt_n    the task's turn the file belongs to (1 for the brief, 2 for the first "carry on", …)
--   message_id   the message folder the agent reads it under: .openvibe/attachments/<message_id>/<name>
--   linked_at    when it was attached; an upload never moves to a second message
CREATE TABLE IF NOT EXISTS codes_attachments (
    id           text COLLATE "C" PRIMARY KEY,             -- fil_<ULID>
    subject      text COLLATE "C" NOT NULL,
    task_id      text COLLATE "C",
    attempt_n    integer,
    message_id   text COLLATE "C",
    name         text COLLATE "C" NOT NULL,
    mime         text COLLATE "C" NOT NULL,
    size         bigint NOT NULL,
    data         bytea NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    linked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS codes_attachments_subject ON codes_attachments (subject, created_at DESC);
CREATE INDEX IF NOT EXISTS codes_attachments_task ON codes_attachments (task_id, attempt_n);
CREATE INDEX IF NOT EXISTS codes_attachments_message ON codes_attachments (message_id) WHERE message_id IS NOT NULL;

-- "Who leads your tasks" (owner 2026-11-07): the agent and model a new conductor starts on, and the one every
-- conductor without its own pick keeps. NULL means today's choice: Claude Code on Opus.
ALTER TABLE codes_user_settings ADD COLUMN IF NOT EXISTS conductor_agent text COLLATE "C";
ALTER TABLE codes_user_settings ADD COLUMN IF NOT EXISTS conductor_model text COLLATE "C";
