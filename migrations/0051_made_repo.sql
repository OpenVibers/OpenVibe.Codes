-- phase: expand
-- The repository Codes made for a task (plan §AD.28 item 3): a Code-mode task that named no repository runs on a new
-- private one in the person's name on OpenVibe Git (Codes #555). Its owner/name and page are kept here, so the task's
-- summary (codes.task-summary@1 1.1.0 made_repo) and the session can say "Codes made ada/<name> on OpenVibe Git" with
-- its link for as long as the task is shown. Null for every other task; older releases ignore the column.
ALTER TABLE run_tasks ADD COLUMN IF NOT EXISTS made_repo jsonb;
