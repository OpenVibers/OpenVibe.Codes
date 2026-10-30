-- phase: expand
-- Codes C9c: the fleet, and the notices a task sends once.
--
-- codes_machine_fleet is the latest state each of a person's machines reported with its heartbeat: per agent, whether
-- it is installed and signed in, and the limit windows it can read. It holds no key, token or account name (the Node
-- reports numbers and labels only), and a machine that reports again replaces its own rows.
CREATE TABLE IF NOT EXISTS codes_machine_fleet (
    subject      text COLLATE "C" NOT NULL,              -- usr_… the machines' owner
    machine      text COLLATE "C" NOT NULL,              -- the device id Run places a job on (dev_…)
    node_id      text COLLATE "C",                       -- the Network principal (nod_…), when the machine has one
    name         text COLLATE "C",                       -- the machine's name, as its owner gave it
    agent        text COLLATE "C" NOT NULL,              -- a harness id: codex, opencode, command-code, minimax-code, claude-code
    installed    boolean NOT NULL DEFAULT false,
    signed_in    boolean NOT NULL DEFAULT false,
    windows      jsonb NOT NULL DEFAULT '[]'::jsonb,      -- [{name, used, limit, pct, resets_at}], numbers and labels only
    online       boolean NOT NULL DEFAULT false,
    reported_at  timestamptz,                             -- when the machine last reported this fleet
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (subject, machine, agent)
);
CREATE INDEX IF NOT EXISTS codes_machine_fleet_subject ON codes_machine_fleet (subject, agent);

-- codes_notices: one notification per task and state ('done', 'needs'). The unique row is what makes a notice once:
-- a task's state can be recorded again (a redelivery, a fallback read), and the person is not told twice.
CREATE TABLE IF NOT EXISTS codes_notices (
    task_id   text COLLATE "C" NOT NULL,
    kind      text COLLATE "C" NOT NULL,                 -- done | needs
    sent_at   timestamptz NOT NULL DEFAULT now(),
    result    text COLLATE "C",
    PRIMARY KEY (task_id, kind)
);

-- A conductor's chosen machine, pinned on Run by its OpenVibe.Bot device id (`dev_…`, the id codes_machine_fleet stores
-- as `machine`): every turn of the session runs there, where its folder and its memory are (Run's job `node`, contracts
-- 0.249.0). NULL: not a conductor, or a conductor created without a machine — Run places the job where it fits, as before.
ALTER TABLE run_tasks ADD COLUMN IF NOT EXISTS pin text COLLATE "C";
