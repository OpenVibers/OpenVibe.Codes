-- phase: expand
-- Codes skills hub (the Compute plan §5, E6): skills, rules, MCP servers, commands and hooks kept per person, per
-- project and for the gallery; versioned, with the four sharing audiences of openvibe-sdk/share
-- (public, link, people, private). A record's body lives only in its versions: every save is an immutable row, and a
-- rollback copies an old version into a new one so a machine that synced version 3 can still name it.
--
-- Only public records are in the gallery; link, people and private ones are never listed. The Node sync reads the
-- person's assignments through GET /api/v1/me/skills, never the gallery.
CREATE TABLE IF NOT EXISTS codes_skills (
    id             text COLLATE "C" PRIMARY KEY,                 -- skl_<ULID>
    owner_subject  text COLLATE "C" NOT NULL,                    -- usr_<ULID>
    kind           text COLLATE "C" NOT NULL
        CHECK (kind IN ('skill', 'rule', 'mcp', 'command', 'hook')),
    slug           text COLLATE "C" NOT NULL,                    -- the SKILL.md folder name, stable for the owner
    title          text NOT NULL,
    official       boolean NOT NULL DEFAULT false,               -- OpenVibe's own records, shown beside community ones
    tools          jsonb NOT NULL DEFAULT '[]'::jsonb,           -- harness ids this record is written for; [] = all
    latest_version integer NOT NULL DEFAULT 1 CHECK (latest_version >= 1),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_subject, slug)
);
CREATE INDEX IF NOT EXISTS codes_skills_owner ON codes_skills (owner_subject, updated_at DESC);
-- The audience and the members are openvibe-sdk/share's (shares/share_members, service 'codes', kind 'skill'): this
-- hub registers every record there, so the same four audiences and the same access check apply as to a run task.

-- One immutable version. The body, summary, tools and audience are copied here so a save never loses what an older
-- machine wrote; the skill row names the newest.
CREATE TABLE IF NOT EXISTS codes_skill_versions (
    skill_id    text COLLATE "C" NOT NULL REFERENCES codes_skills(id) ON DELETE CASCADE,
    version     integer NOT NULL CHECK (version >= 1),
    summary     text NOT NULL DEFAULT '',
    body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 131072),
    tools       jsonb NOT NULL DEFAULT '[]'::jsonb,
    audience    text COLLATE "C" NOT NULL
        CHECK (audience IN ('public', 'link', 'people', 'private')),
    created_by  text COLLATE "C" NOT NULL,                       -- usr_<ULID> or system
    note        text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (skill_id, version)
);

-- What one person chose to sync, per project ('' is the person's own, everywhere). The Node asks for the person's
-- scope plus the slug of the project it is writing into.
CREATE TABLE IF NOT EXISTS codes_skill_assignments (
    subject    text COLLATE "C" NOT NULL,                        -- usr_<ULID>
    project    text COLLATE "C" NOT NULL DEFAULT '',             -- '' or a project slug
    skill_id   text COLLATE "C" NOT NULL REFERENCES codes_skills(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (subject, project, skill_id)
);
CREATE INDEX IF NOT EXISTS codes_skill_assignments_subject ON codes_skill_assignments (subject, project);
