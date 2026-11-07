-- phase: expand
-- Agent Streams S6 (design 2026-11-06 §1, §6): the chat plays sandbox workers. A worker (bin/openvibe-sandbox-worker.js)
-- checks in every 30 s with a signed heartbeat (POST /internal/sandbox-workers/heartbeat) carrying what its self-test
-- found: its isolation and every check. Codes reads this to say whether any healthy worker exists
-- (GET /internal/sandbox-workers/health) and, later, to pick one for a chat plays session.
--
-- No secret, path, address or person is stored: a worker's own name, version, the facts it reported and when.
-- Expand-only: a new table nothing older reads. Repeating this file is a no-op.

CREATE TABLE IF NOT EXISTS codes_sandbox_workers (
    id             text COLLATE "C" PRIMARY KEY,                 -- the worker's own name (sbw-<host>)
    version        text NOT NULL DEFAULT '',
    ready          boolean NOT NULL DEFAULT false,               -- the worker's own verdict
    checks         jsonb NOT NULL DEFAULT '{}'::jsonb,           -- the self-test, check by check
    isolation      jsonb NOT NULL DEFAULT '{}'::jsonb,           -- namespaces, egress, credentials, limits
    capacity       integer NOT NULL DEFAULT 0,
    active         integer NOT NULL DEFAULT 0,
    last_signed_at bigint NOT NULL DEFAULT 0,                    -- the heartbeat's signed time: a replay is refused
    last_seen_at   timestamptz NOT NULL DEFAULT now(),
    created_at     timestamptz NOT NULL DEFAULT now()
);
