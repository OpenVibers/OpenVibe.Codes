'use strict';

/**
 * OpenVibe.Codes' own SQLite database (WAL, created on boot, idempotent).
 *
 * Codes owns ONLY what is Codes' by ADR-014: release metadata keyed to Network app ids, trust tiers
 * (metadata, never authority), validated manifests, and playground run logs. Projects, members,
 * apps, credentials, grants and quotas belong to OpenVibe.Network and are never copied here.
 *
 * No table has a column for a secret, token or credential, and nothing written here ever contains
 * one (test/secrets.test.js scans every table).
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { ids } = require('openvibe-contracts');

const TABLES = ['manifests', 'releases', 'release_log', 'trust', 'trust_history', 'playground_runs'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS manifests (
    id           TEXT PRIMARY KEY,               -- mfs_<ULID>
    kind         TEXT NOT NULL CHECK (kind IN ('app', 'mod')),
    app_id       TEXT NOT NULL,                  -- Network app (app_<ULID>) that publishes it
    project_id   TEXT NOT NULL,                  -- Network project (prj_<ULID>) at the time of creation
    subject_id   TEXT NOT NULL,                  -- the manifest's own id (app_… or mod_…)
    version      TEXT NOT NULL,
    body         TEXT NOT NULL,                  -- the manifest JSON exactly as validated
    contracts_version TEXT NOT NULL,             -- openvibe-contracts release it was validated with
    created_by   TEXT NOT NULL,                  -- user:usr_… or app:app_…
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_manifests_app ON manifests(app_id);

CREATE TABLE IF NOT EXISTS releases (
    id            TEXT PRIMARY KEY,              -- rel_<ULID>
    app_id        TEXT NOT NULL,
    project_id    TEXT NOT NULL,
    environment   TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
    kind          TEXT NOT NULL CHECK (kind IN ('app', 'mod')),
    subject_id    TEXT NOT NULL,
    name          TEXT NOT NULL,
    version       TEXT NOT NULL,
    manifest_id   TEXT NOT NULL REFERENCES manifests(id),
    status        TEXT NOT NULL CHECK (status IN ('draft', 'published', 'deprecated', 'revoked')),
    compatibility TEXT NOT NULL DEFAULT '{}',
    notes         TEXT NOT NULL DEFAULT '',
    created_by    TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    published_by  TEXT, published_at TEXT,
    deprecated_by TEXT, deprecated_at TEXT, deprecation_reason TEXT, replacement TEXT,
    revoked_by    TEXT, revoked_at TEXT, revocation_reason TEXT,
    UNIQUE (app_id, kind, subject_id, version)
);
CREATE INDEX IF NOT EXISTS idx_releases_app ON releases(app_id, created_at);

CREATE TABLE IF NOT EXISTS release_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    release_id TEXT NOT NULL,
    action     TEXT NOT NULL,
    actor      TEXT NOT NULL,
    at         TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_release_log_release ON release_log(release_id, id);
CREATE TRIGGER IF NOT EXISTS release_log_append_only_update BEFORE UPDATE ON release_log
    BEGIN SELECT RAISE(ABORT, 'release_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS release_log_append_only_delete BEFORE DELETE ON release_log
    BEGIN SELECT RAISE(ABORT, 'release_log is append-only'); END;

CREATE TABLE IF NOT EXISTS trust (
    app_id  TEXT PRIMARY KEY,
    tier    TEXT NOT NULL CHECK (tier IN ('untrusted', 'verified', 'trusted', 'platform-maintained')),
    note    TEXT NOT NULL DEFAULT '',
    set_by  TEXT NOT NULL,
    set_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trust_history (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id    TEXT NOT NULL,
    from_tier TEXT NOT NULL,
    to_tier   TEXT NOT NULL,
    note      TEXT NOT NULL DEFAULT '',
    set_by    TEXT NOT NULL,
    set_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playground_runs (
    id           TEXT PRIMARY KEY,               -- run_<ULID>
    at           TEXT NOT NULL,
    actor        TEXT NOT NULL,                  -- user:usr_…
    project_id   TEXT NOT NULL,
    app_id       TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('events', 'media')),
    capability   TEXT NOT NULL,
    credential   TEXT NOT NULL CHECK (credential IN ('none', 'client_secret', 'access_token')),
    outcome      TEXT NOT NULL CHECK (outcome IN ('ok', 'refused', 'failed')),
    stage        TEXT NOT NULL,                  -- app | grant | token | call | done
    http_status  INTEGER,
    code         TEXT,
    detail       TEXT NOT NULL DEFAULT '',
    ref          TEXT                            -- event_id or media key on success
);
CREATE INDEX IF NOT EXISTS idx_runs_app ON playground_runs(app_id, at);
CREATE INDEX IF NOT EXISTS idx_runs_actor ON playground_runs(actor, at);
`;

function openStore(dbPath, { now = () => Date.now() } = {}) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    return {
        db,
        now,
        iso: () => new Date(now()).toISOString(),
        newId: (prefix) => `${prefix}_${ids.ulid(now())}`,
        close: () => db.close(),
    };
}

module.exports = { openStore, TABLES };
