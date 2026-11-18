-- phase: expand
-- Agent homes (plan §AD.22, openvibe.home@1): what a person's agents need on a machine (tools, agent CLIs, git's
-- identity, repositories), kept once here and made real on any of their machines by a Codes job of mode 'home' in
-- their sandbox there, so nobody logs in to a machine to set it up. APPLIED is per machine: the last job and when.
CREATE TABLE IF NOT EXISTS codes_homes (
    subject     text COLLATE "C" PRIMARY KEY,                -- usr_… whose home it is
    spec        jsonb NOT NULL,                              -- openvibe.home@1, checked (engine/home.js readSpec)
    applied     jsonb NOT NULL DEFAULT '{}'::jsonb,          -- { "<device>": { "job": "job_…", "at": "…" } }
    updated_at  timestamptz NOT NULL DEFAULT now()
);
