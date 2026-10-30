-- phase: expand
-- Stage C2 (openvibe.codes v1): a task's attempts. A continue, a switch to another agent and a wrap-up are attempts on
-- one task's timeline, never new tasks with cryptic names (the portal's "-c1"/"-r2" confusion of 10-30). Every Run job
-- is one attempt: the attempt carries the job, the agent, the machine and the harness session a resume needs.
--
--   n           the attempt's place on the timeline (1, 2, …)
--   state       queued | running | done | failed | stopped | budget-stopped | interrupted
--   reason      limit | auth | capacity | refused | error | budget | stopped | hung | context (why it ended)
--   why         one sentence in plain words: why this attempt happened (for the timeline)
--   kind        first | continue | switch | wrap-up | manual: how this attempt came to be
--   follow_up_of the attempt whose end started this one. It is unique, so one ending can start only one follow-up:
--               the fence against the portal's 10-30 bug, where two racing ticks carried one job on twice.
--
-- run_tasks grows the task's own verdict: outcome ('done' | 'unfinished' | 'stopped', NULL while it runs), outcome_note
-- (what is left, in plain words) and attempts_count. codes_session_lines grows attempt_n, so every line of the session
-- says which attempt it belongs to.
--
-- Every task that exists now becomes attempt 1 of itself: the timeline of an old task is not empty.

CREATE TABLE IF NOT EXISTS codes_attempts (
    id           text COLLATE "C" PRIMARY KEY,             -- att_<ULID>
    task_id      text COLLATE "C" NOT NULL,                -- tsk_<ULID>
    n            integer NOT NULL,                         -- 1, 2, … the attempt's place on the timeline
    agent        text COLLATE "C",                         -- the harness (claude-code, codex, …) or 'auto'
    model        text COLLATE "C",
    machine      text COLLATE "C",                         -- the node's id, or 'sandbox'
    job_id       text COLLATE "C",                         -- Run's job_<ULID> for this attempt
    session      text COLLATE "C",                         -- the harness session id, for a resume
    state        text COLLATE "C" NOT NULL,                -- queued, running, done, failed, stopped, budget-stopped, interrupted
    reason       text COLLATE "C",                         -- limit, auth, capacity, refused, error, budget, stopped, hung, context
    why          text COLLATE "C",                         -- one sentence in plain words
    kind         text COLLATE "C" NOT NULL DEFAULT 'first',-- first | continue | switch | wrap-up | manual
    cost_usd     numeric(14,6),
    tokens       bigint,
    steps        integer,
    started_at   timestamptz,
    finished_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    follow_up_of text COLLATE "C"                         -- the attempt whose end started this one
);
CREATE UNIQUE INDEX IF NOT EXISTS codes_attempts_task_n ON codes_attempts (task_id, n);
-- One ending, one follow-up: the unique index is the fence (the second insert is a no-op).
CREATE UNIQUE INDEX IF NOT EXISTS codes_attempts_follow_up ON codes_attempts (follow_up_of) WHERE follow_up_of IS NOT NULL;
-- A Run job is one attempt: the job of an attempt is found by it.
CREATE INDEX IF NOT EXISTS codes_attempts_job ON codes_attempts (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS codes_attempts_task ON codes_attempts (task_id, n);

ALTER TABLE run_tasks ADD COLUMN IF NOT EXISTS outcome text COLLATE "C";            -- done | unfinished | stopped
ALTER TABLE run_tasks ADD COLUMN IF NOT EXISTS outcome_note text COLLATE "C";        -- what is left, in plain words
ALTER TABLE run_tasks ADD COLUMN IF NOT EXISTS attempts_count integer NOT NULL DEFAULT 0;
ALTER TABLE codes_session_lines ADD COLUMN IF NOT EXISTS attempt_n integer;

-- Every task that exists becomes attempt 1 of itself. The id is the task's own id hashed into the ULID alphabet
-- (26 characters of Crockford base32), so the same task always gets the same attempt and a rerun of the migration
-- changes nothing.
INSERT INTO codes_attempts (id, task_id, n, agent, job_id, state, reason, why, kind, started_at, finished_at, created_at)
SELECT 'att_' || upper(substr(md5(t.id), 1, 26)),
       t.id,
       1,
       t.agent,
       t.job_id,
       CASE t.state
            WHEN 'queued' THEN 'queued'
            WHEN 'placed' THEN 'queued'
            WHEN 'running' THEN 'running'
            WHEN 'succeeded' THEN 'done'
            WHEN 'cancelled' THEN 'stopped'
            ELSE 'failed'
       END,
       CASE t.state
            WHEN 'cancelled' THEN 'stopped'
            WHEN 'expired' THEN 'capacity'
            WHEN 'failed' THEN 'error'
            ELSE NULL
       END,
       CASE t.state
            WHEN 'succeeded' THEN 'the first attempt of this task finished the work'
            WHEN 'cancelled' THEN 'the first attempt of this task was stopped on purpose'
            WHEN 'expired' THEN 'no machine took the first attempt in time'
            WHEN 'failed' THEN 'the first attempt of this task failed'
            WHEN 'running' THEN 'the first attempt of this task is running'
            ELSE 'the first attempt of this task is waiting for a machine'
       END,
       'first',
       t.started_at,
       t.finished_at,
       to_timestamp(GREATEST(t.created_at, 0) / 1000.0)
FROM run_tasks t
WHERE NOT EXISTS (SELECT 1 FROM codes_attempts a WHERE a.task_id = t.id);

UPDATE run_tasks t
SET outcome = CASE t.state
                  WHEN 'succeeded' THEN 'done'
                  WHEN 'cancelled' THEN 'stopped'
                  WHEN 'failed' THEN 'unfinished'
                  WHEN 'expired' THEN 'unfinished'
                  ELSE NULL
              END,
    outcome_note = CASE t.state
                       WHEN 'succeeded' THEN 'the task finished before attempts were counted'
                       WHEN 'cancelled' THEN 'the task was stopped on purpose'
                       WHEN 'failed' THEN 'the attempt failed; what it left is in the session'
                       WHEN 'expired' THEN 'no machine took the task in time'
                       ELSE NULL
                   END,
    attempts_count = 1
WHERE t.attempts_count = 0;

UPDATE codes_session_lines SET attempt_n = 1 WHERE attempt_n IS NULL;
