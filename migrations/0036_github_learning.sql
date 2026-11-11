-- phase: expand
CREATE TABLE IF NOT EXISTS github_learning_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  topics jsonb NOT NULL DEFAULT '["agent-harness","coding-agent","agent-ui-protocol","browser-automation","streaming","design-system"]'::jsonb,
  repos_per_day integer NOT NULL DEFAULT 5 CHECK (repos_per_day BETWEEN 1 AND 20),
  weekly_proposal boolean NOT NULL DEFAULT false,
  cost_cap numeric(10,4) NOT NULL DEFAULT 1 CHECK (cost_cap BETWEEN 0 AND 100),
  next_due timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS github_learning_snapshots (
  full_name text NOT NULL,
  stars integer NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (full_name, observed_at)
);
CREATE TABLE IF NOT EXISTS github_learning_notes (
  id bigserial PRIMARY KEY,
  finding_date date NOT NULL DEFAULT CURRENT_DATE,
  full_name text NOT NULL,
  url text NOT NULL,
  license text,
  stars integer NOT NULL DEFAULT 0,
  star_growth integer NOT NULL DEFAULT 0,
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (finding_date, full_name)
);
