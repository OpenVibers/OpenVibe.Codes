-- phase: expand
-- OpenVibe.Codes on PostgreSQL (ADR-035, roadmap WS-X2): the tables as they were on SQLite (converted by openvibe-sdk
-- tools/asyncify/sqlite-schema-to-pg: text COLLATE "C" compares like SQLite, integers are bigint, identities keep their ids),
-- then the openvibe-publishing stores and the openvibe-sdk inbox and outbox. Generated once on 2026-09-28; never edited after it runs.

CREATE TABLE manifests (
    id           text COLLATE "C" PRIMARY KEY,               -- mfs_<ULID>
    kind         text COLLATE "C" NOT NULL CHECK (kind IN ('app', 'mod')),
    app_id       text COLLATE "C" NOT NULL,                  -- Network app (app_<ULID>) that publishes it
    project_id   text COLLATE "C" NOT NULL,                  -- Network project (prj_<ULID>) at the time of creation
    subject_id   text COLLATE "C" NOT NULL,                  -- the manifest's own id (app_… or mod_…)
    version      text COLLATE "C" NOT NULL,
    body         text COLLATE "C" NOT NULL,                  -- the manifest JSON exactly as validated
    contracts_version text COLLATE "C" NOT NULL,             -- openvibe-contracts release it was validated with
    created_by   text COLLATE "C" NOT NULL,                  -- user:usr_… or app:app_…
    created_at   text COLLATE "C" NOT NULL
);
CREATE INDEX idx_manifests_app ON manifests(app_id);

CREATE TABLE releases (
    id            text COLLATE "C" PRIMARY KEY,              -- rel_<ULID>
    app_id        text COLLATE "C" NOT NULL,
    project_id    text COLLATE "C" NOT NULL,
    environment   text COLLATE "C" NOT NULL CHECK (environment IN ('sandbox', 'production')),
    kind          text COLLATE "C" NOT NULL CHECK (kind IN ('app', 'mod')),
    subject_id    text COLLATE "C" NOT NULL,
    name          text COLLATE "C" NOT NULL,
    version       text COLLATE "C" NOT NULL,
    manifest_id   text COLLATE "C" NOT NULL REFERENCES manifests(id),
    status        text COLLATE "C" NOT NULL CHECK (status IN ('draft', 'published', 'deprecated', 'revoked')),
    compatibility text COLLATE "C" NOT NULL DEFAULT '{}',
    notes         text COLLATE "C" NOT NULL DEFAULT '',
    created_by    text COLLATE "C" NOT NULL,
    created_at    text COLLATE "C" NOT NULL,
    published_by  text COLLATE "C", published_at TEXT,
    deprecated_by text COLLATE "C", deprecated_at TEXT, deprecation_reason TEXT, replacement TEXT,
    revoked_by    text COLLATE "C", revoked_at TEXT, revocation_reason TEXT,
    UNIQUE (app_id, kind, subject_id, version)
);
CREATE INDEX idx_releases_app ON releases(app_id, created_at);

CREATE TABLE release_log (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    release_id text COLLATE "C" NOT NULL,
    action     text COLLATE "C" NOT NULL,
    actor      text COLLATE "C" NOT NULL,
    at         text COLLATE "C" NOT NULL,
    detail     text COLLATE "C" NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_release_log_release ON release_log(release_id, id);
CREATE FUNCTION release_log_append_only_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'release_log is append-only'; END $$;
CREATE TRIGGER release_log_append_only_update BEFORE UPDATE ON release_log FOR EACH ROW EXECUTE FUNCTION release_log_append_only_update();
CREATE FUNCTION release_log_append_only_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'release_log is append-only'; END $$;
CREATE TRIGGER release_log_append_only_delete BEFORE DELETE ON release_log FOR EACH ROW EXECUTE FUNCTION release_log_append_only_delete();

CREATE TABLE trust (
    app_id  text COLLATE "C" PRIMARY KEY,
    tier    text COLLATE "C" NOT NULL CHECK (tier IN ('unreviewed', 'reviewed', 'first-party')),
    note    text COLLATE "C" NOT NULL DEFAULT '',
    set_by  text COLLATE "C" NOT NULL,
    set_at  text COLLATE "C" NOT NULL
);
CREATE TABLE trust_history (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    app_id    text COLLATE "C" NOT NULL,
    from_tier text COLLATE "C" NOT NULL,
    to_tier   text COLLATE "C" NOT NULL,
    note      text COLLATE "C" NOT NULL DEFAULT '',
    set_by    text COLLATE "C" NOT NULL,
    set_at    text COLLATE "C" NOT NULL
);

CREATE TABLE playground_runs (
    id           text COLLATE "C" PRIMARY KEY,               -- run_<ULID>
    at           text COLLATE "C" NOT NULL,
    actor        text COLLATE "C" NOT NULL,                  -- user:usr_…
    project_id   text COLLATE "C" NOT NULL,
    app_id       text COLLATE "C" NOT NULL,
    kind         text COLLATE "C" NOT NULL CHECK (kind IN ('events', 'media')),
    capability   text COLLATE "C" NOT NULL,
    credential   text COLLATE "C" NOT NULL CHECK (credential IN ('none', 'client_secret', 'access_token')),
    outcome      text COLLATE "C" NOT NULL CHECK (outcome IN ('ok', 'refused', 'failed')),
    stage        text COLLATE "C" NOT NULL,                  -- app | grant | token | call | done
    http_status  bigint,
    code         text COLLATE "C",
    detail       text COLLATE "C" NOT NULL DEFAULT '',
    ref          text COLLATE "C"                            -- event_id or media key on success
);
CREATE INDEX idx_runs_app ON playground_runs(app_id, at);
CREATE INDEX idx_runs_actor ON playground_runs(actor, at);

-- openvibe-sdk/events PostgreSQL outbox
CREATE TABLE IF NOT EXISTS event_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX IF NOT EXISTS event_outbox_due ON event_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS event_outbox_sent ON event_outbox (sent_at) WHERE sent_at IS NOT NULL;
