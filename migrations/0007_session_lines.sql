-- phase: expand
-- OpenVibe.Codes: a coding task's session, line by line, so a finished task replays from any device instead of only
-- from the 240 KB log the machine returned in run_tasks.result. A line is the job line the session view understands
-- (openvibe-shared/agent-session.js: agent, text, tool, tool_progress, tool_result, handoff, note, usage, done, step)
-- or the stream's own state/end line. seq is the stream's order, so a reconnect that replays an event is a no-op on
-- (task_id, seq). Bodies are clipped to 64 KB each; there is no total cap (session retention removes old lines).
CREATE TABLE IF NOT EXISTS codes_session_lines (
    task_id text COLLATE "C" NOT NULL,                       -- tsk_<ULID>
    seq     bigint NOT NULL,                                  -- the stream's order (event seq × 250 000 + line), never renumbered
    at      timestamptz NOT NULL,
    kind    text COLLATE "C" NOT NULL,                        -- the line type the session view reads
    body    jsonb NOT NULL,
    PRIMARY KEY (task_id, seq)
);

-- Set once the machine's final result has been reconciled with the stream and any missing lines were back-filled.
ALTER TABLE run_tasks ADD COLUMN IF NOT EXISTS session_complete_at timestamptz;
