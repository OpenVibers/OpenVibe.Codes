-- phase: expand
-- Portable sessions (plan §AD.22, conversation.import@1): a coding agent's saved session a person carried here
-- (`openvibe-codes import`), to read and to continue on one of their machines. DATA is the document, gzipped (the
-- resumable tail of a Claude Code session: one of 3.8 GB on disk travels as about 1 MB). A conductor started from an
-- import names it in run_tasks.import_id: its first turn places the session on the machine and resumes it there.
CREATE TABLE IF NOT EXISTS codes_session_imports (
    id          text COLLATE "C" PRIMARY KEY,                -- imp_…
    subject     text COLLATE "C" NOT NULL,                   -- usr_… whose session it is
    harness     text COLLATE "C" NOT NULL,                   -- claude-code, codex …
    session_id  text COLLATE "C" NOT NULL,                   -- the agent's own id, which its --resume takes
    title       text NOT NULL,
    source_cwd  text,                                        -- the folder it ran in on the machine it came from
    resumable   boolean NOT NULL DEFAULT false,
    messages    integer NOT NULL DEFAULT 0,
    records     integer NOT NULL DEFAULT 0,
    size        integer NOT NULL,                            -- bytes of DATA
    preview     jsonb NOT NULL DEFAULT '[]'::jsonb,          -- the last messages, to read on the page
    data        bytea NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS codes_session_imports_subject ON codes_session_imports (subject, created_at DESC);
ALTER TABLE run_tasks ADD COLUMN IF NOT EXISTS import_id text COLLATE "C";
