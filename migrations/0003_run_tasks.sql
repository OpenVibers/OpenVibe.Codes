-- phase: expand
-- Plan T16: a coding task a person starts on openvibe.codes and runs on their own machine (an OpenVibe Run job Codes
-- starts for them). The row is the person's record of it: what was asked, which Run job runs it, and its result
-- (the agents' summary, the changed files and the patch) once it ends. Nothing here holds a token or a key.
CREATE TABLE run_tasks (
    id          text COLLATE "C" PRIMARY KEY,               -- tsk_<ULID>
    subject     text COLLATE "C" NOT NULL,                  -- usr_… who asked
    project_id  text COLLATE "C" NOT NULL,                  -- prj_… the job belongs to
    job_id      text COLLATE "C",                           -- Run's job_<ULID>
    repo        text NOT NULL,
    ref         text,
    prompt      text NOT NULL,
    agent       text,
    push        boolean NOT NULL DEFAULT false,
    pull_request boolean NOT NULL DEFAULT false,
    state       text COLLATE "C" NOT NULL,                  -- Run's job state: queued … succeeded, failed, cancelled, expired
    result      jsonb,
    error       text,
    created_at  bigint NOT NULL,
    updated_at  bigint NOT NULL
);
CREATE INDEX run_tasks_subject ON run_tasks (subject, created_at DESC);
