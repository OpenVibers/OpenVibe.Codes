-- phase: expand
-- Race mode (compare-arena-ecosystem.md §5, "Votes where people already work"): one task, two harnesses, one budget.
-- The two sides are ordinary run_tasks rows (actor_ref->'race' names the race and the slot); this table keeps the
-- race itself, the Bench match it records, and the two check jobs that run the repository's own workflow on the
-- branches the sides pushed. SIDES is a JSON array (slot a/b): the harness + model, the entrant id and its settings
-- hash, the pushed branch and pull request, the receipts and the check. A merge arrives later and adds a judgement
-- to the same match id, so MATCH_BODY and MATCH_RECORDED stay here.
CREATE TABLE IF NOT EXISTS codes_races (
    id              text COLLATE "C" PRIMARY KEY,           -- rce_<ULID>
    subject         text COLLATE "C" NOT NULL,              -- usr_… who races
    project_id      text COLLATE "C" NOT NULL,              -- prj_… where both jobs run
    source_task_id  text COLLATE "C",                       -- tsk_… the "Race this task" was pressed on
    repo            text NOT NULL,
    ref             text,
    prompt          text NOT NULL,
    permission      text COLLATE "C" NOT NULL DEFAULT 'edit',
    budget          jsonb,                                  -- { usd, tokens, ms }: the same for both sides
    sides           jsonb NOT NULL,                         -- [{ slot, task_id, agent, model, entrant, ... }]
    shown           jsonb,                                  -- the order the sides are shown in (position bias)
    state           text COLLATE "C" NOT NULL,              -- running, checking, matched, skipped, failed
    match_id        text COLLATE "C",                       -- mat_… the bench.match@1 id; one id, two judgements
    match_body      jsonb,                                  -- the body last recorded (the merge adds to it)
    match_recorded  boolean NOT NULL DEFAULT false,
    merged_slot     text COLLATE "C",                       -- a/b: the side whose pull request was merged
    merged_judged   boolean NOT NULL DEFAULT false,
    error           text,
    created_at      bigint NOT NULL,
    updated_at      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS codes_races_subject ON codes_races (subject, created_at DESC);
CREATE INDEX IF NOT EXISTS codes_races_state ON codes_races (state) WHERE state IN ('running', 'checking');

-- One check job per side: the repository's own workflow, at the branch the side pushed. Its run.job.* events are
-- claimed here (not on run_tasks): a check never appears in a person's task list and never starts a follow-up.
CREATE TABLE IF NOT EXISTS codes_race_checks (
    id          text COLLATE "C" PRIMARY KEY,               -- rch_<ULID>
    race_id     text COLLATE "C" NOT NULL REFERENCES codes_races (id) ON DELETE CASCADE,
    slot        text COLLATE "C" NOT NULL,                  -- a, b
    subject     text COLLATE "C" NOT NULL,
    project_id  text COLLATE "C" NOT NULL,
    repo        text NOT NULL,
    ref         text NOT NULL,                              -- the branch the side pushed
    job_id      text COLLATE "C",                           -- Run's job_<ULID>
    state       text COLLATE "C" NOT NULL,                  -- queued, running, succeeded, failed, cancelled, expired, skipped
    result      jsonb,
    error       text,
    created_at  bigint NOT NULL,
    updated_at  bigint NOT NULL,
    UNIQUE (race_id, slot)
);
CREATE INDEX IF NOT EXISTS codes_race_checks_job ON codes_race_checks (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS codes_race_checks_race ON codes_race_checks (race_id);
