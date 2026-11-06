-- phase: expand
-- Visibility step 2 (design 2026-11-06): the person's default audience for new run tasks, and one share row for
-- every task that already exists, Only me. New tasks are registered as they are made (server/sharing.js); an old
-- task without a row is still its owner's, because every read asks canView and a missing row answers no.
-- Repeating this file is a no-op. Expand-only.

CREATE TABLE IF NOT EXISTS codes_share_defaults (
    subject    text COLLATE "C" PRIMARY KEY,
    audience   text COLLATE "C" NOT NULL CHECK (audience IN ('public', 'link', 'people', 'private')),
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO shares (service, kind, resource_id, owner_subject, audience)
SELECT 'codes', 'task', id, jsonb_build_object('type', 'user', 'id', subject), 'private'
FROM run_tasks
WHERE subject IS NOT NULL
ON CONFLICT (service, kind, resource_id) DO NOTHING;
