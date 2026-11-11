-- phase: expand
-- Where the repository field looks (ask 348, the owner 2026-11-10): Codes' own dropdown asks several sources and merges
-- their answers in this table's order. The owner sets which are on, their order, each one's limit and time, and any
-- custom source of their own. A custom source is an https URL template with {q}; Codes fetches it through the egress
-- rule for user-chosen URLs, never directly.
--
--   id           'recent', 'git', 'github' for the three built-ins, or 'src_<ULID>' for a custom source
--   kind         recent (the person's tasks), git (OpenVibe Git), github, or url (the custom template)
--   url_template the https URL with {q}, for kind = url only
--   position     the order the sections appear in (lowest first)
--   limit_n      the most rows this source may add to one answer (1–20)
--   timeout_ms   how long Codes waits for it (100–5000; a source over it is left out, not reported)
CREATE TABLE IF NOT EXISTS repo_picker_sources (
    id           text COLLATE "C" PRIMARY KEY,
    kind         text COLLATE "C" NOT NULL,
    label        text COLLATE "C" NOT NULL,
    url_template text COLLATE "C",
    enabled      boolean NOT NULL DEFAULT true,
    position     integer NOT NULL DEFAULT 0,
    limit_n      integer NOT NULL DEFAULT 8,
    timeout_ms   integer NOT NULL DEFAULT 1500,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    updated_by   text COLLATE "C",
    CONSTRAINT repo_picker_sources_kind CHECK (kind IN ('recent', 'git', 'github', 'url')),
    CONSTRAINT repo_picker_sources_limit CHECK (limit_n BETWEEN 1 AND 20),
    CONSTRAINT repo_picker_sources_timeout CHECK (timeout_ms BETWEEN 100 AND 5000)
);

-- The three sources Codes already reads, in the order the owner named them: what the person used here, their OpenVibe
-- Git repositories, then GitHub (their linked account, or an exact owner/name for a public repository).
INSERT INTO repo_picker_sources (id, kind, label, enabled, position, limit_n, timeout_ms)
VALUES
    ('recent', 'recent', 'Used here', true, 1, 8, 1500),
    ('git', 'git', 'OpenVibe Git', true, 2, 8, 1500),
    ('github', 'github', 'GitHub', true, 3, 8, 1500)
ON CONFLICT (id) DO NOTHING;
