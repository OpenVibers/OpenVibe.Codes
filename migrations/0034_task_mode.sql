-- phase: expand
-- The Dock's Code tab (codes.task-summary@1 mode): where the request started — openvibe (one of OpenVibe's own
-- projects) or repo (the person's own repository). Rows from before it read back by their repository instead.
ALTER TABLE run_tasks
    ADD COLUMN IF NOT EXISTS mode text COLLATE "C";
