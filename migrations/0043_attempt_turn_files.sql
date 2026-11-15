-- phase: expand
-- Per-turn diffs (plan §AD.6, Codes next (4)): what each attempt of a task changed by itself, kept on the attempt when
-- it ends, so the Changes panel shows the task turn by turn and not only the sum. The harness measures it (its
-- checkpoints' turn_diff: the clone after the earlier turns' changes were applied, against the clone at the end; a
-- path is authored when the turn's own tools wrote it). An older harness without checkpoints is compared file by file
-- with the turn before. { source: 'checkpoints' | 'files', files: [{ path, status, added, removed, authored? }],
-- truncated? }; NULL for attempts that ended before this or that changed nothing measurable.
ALTER TABLE codes_attempts ADD COLUMN IF NOT EXISTS turn_files jsonb;
