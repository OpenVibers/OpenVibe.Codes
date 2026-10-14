-- phase: expand
-- Contracts 0.162 codes.task.start: a first-party service (OpenVibe.Actor) starts a coding task for a person. VIA is
-- that service (service:<id>; null for a task the person started on /run), and only it reads or cancels the task
-- through the API; IDEMPOTENCY_KEY makes its retry answer the first task.
ALTER TABLE run_tasks ADD COLUMN via text COLLATE "C";
ALTER TABLE run_tasks ADD COLUMN idempotency_key text COLLATE "C";
CREATE UNIQUE INDEX run_tasks_service_key ON run_tasks (subject, via, idempotency_key) WHERE idempotency_key IS NOT NULL;
