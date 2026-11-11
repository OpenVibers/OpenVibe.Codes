-- phase: expand
-- Saved account and project choices. The repository's .openvibe/codes.yml and a task override take precedence.
CREATE TABLE IF NOT EXISTS codes_model_plans (
    subject text COLLATE "C" NOT NULL,
    scope text COLLATE "C" NOT NULL,
    plan jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (subject, scope)
);

CREATE TABLE IF NOT EXISTS codes_model_preset_defaults (
    name text COLLATE "C" PRIMARY KEY,
    plan jsonb NOT NULL,
    tuned_at timestamptz NOT NULL DEFAULT now(),
    owner_subject text COLLATE "C" NOT NULL
);

ALTER TABLE run_tasks
    ADD COLUMN IF NOT EXISTS model_plan jsonb,
    ADD COLUMN IF NOT EXISTS plan_source text COLLATE "C",
    ADD COLUMN IF NOT EXISTS preset text COLLATE "C",
    ADD COLUMN IF NOT EXISTS role_runs jsonb;
