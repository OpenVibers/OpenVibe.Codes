-- phase: expand
-- Know K5: a person's workspace knowledge — the lessons and facts their own runs taught them.
--
-- A row belongs to one person. It is private unless the person shares it with a team (a Network developer project,
-- the same prj_… a run belongs to): visibility 'team' plus team_id makes it readable by that project's members.
-- The text is scrubbed of secrets before it is written here; source_task points at the run that taught it.
--
-- A capture is idempotent: (subject, kind, dedupe_key) is unique, so running the same capture twice raises `seen`
-- and moves `last_seen_at` instead of writing a second row. Nothing in this table is a token or a key.

CREATE TABLE IF NOT EXISTS codes_knowledge (
    id              text COLLATE "C" PRIMARY KEY,              -- kn_<ULID>
    subject         text COLLATE "C" NOT NULL,                 -- usr_… who owns the row
    team_id         text COLLATE "C",                          -- prj_… when shared with a team
    visibility      text COLLATE "C" NOT NULL DEFAULT 'private'
                    CHECK (visibility IN ('private', 'team')),
    kind            text COLLATE "C" NOT NULL DEFAULT 'lesson'
                    CHECK (kind IN ('lesson', 'fact')),
    text            text NOT NULL,                             -- redacted before it is stored
    repo            text,                                      -- host/owner/name, or the task's repository
    paths           jsonb NOT NULL DEFAULT '[]'::jsonb,        -- files the row names
    source_task     text COLLATE "C",                          -- tsk_… the run it came from
    source_job      text COLLATE "C",                          -- Run's job_…
    source_agent    text,                                      -- the harness that learned it
    dedupe_key      text COLLATE "C",                          -- sha256 of the normalized text
    seen            integer NOT NULL DEFAULT 1,
    pinned          boolean NOT NULL DEFAULT false,
    redacted        boolean NOT NULL DEFAULT false,
    created_at      bigint NOT NULL,
    updated_at      bigint NOT NULL,
    last_seen_at    bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS codes_knowledge_subject ON codes_knowledge (subject, created_at DESC);
CREATE INDEX IF NOT EXISTS codes_knowledge_team ON codes_knowledge (team_id, created_at DESC) WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS codes_knowledge_source ON codes_knowledge (source_task) WHERE source_task IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS codes_knowledge_dedupe ON codes_knowledge (subject, kind, dedupe_key)
    WHERE dedupe_key IS NOT NULL;
