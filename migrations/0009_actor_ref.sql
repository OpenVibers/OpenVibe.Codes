-- phase: expand
-- CODES-5: Actor back-reference. A first-party service (OpenVibe.Actor) may pass its own task/step ids when it
-- starts a coding task for a person; Codes stores them but does not expose them in codes.task@1 or the events
-- (those need a contract amendment). The column is jsonb so the shape can settle before it is promoted.
ALTER TABLE run_tasks ADD COLUMN IF NOT EXISTS actor_ref jsonb;
CREATE INDEX IF NOT EXISTS run_tasks_actor_ref_task ON run_tasks ((actor_ref ->> 'task_id')) WHERE actor_ref IS NOT NULL;
