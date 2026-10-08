-- phase: contract
-- after: 0001
-- The developer console moved to OpenVibe.Services on 2026-10-08 (openvibe-contracts 0.113.0). Its rows — 16 manifests,
-- 16 releases and 64 release-log entries, all from the daily developer-path probe, every release revoked — were copied
-- into ov_services column for column before this release, and the sent outbox rows (48, codes.app.* events Events
-- already has) are history Events keeps. Codes reads none of these tables any more, so they go; the harness's own tables
-- arrive with its runs.
DROP TABLE IF EXISTS release_log;
DROP TABLE IF EXISTS releases;
DROP TABLE IF EXISTS manifests;
DROP TABLE IF EXISTS trust_history;
DROP TABLE IF EXISTS trust;
DROP TABLE IF EXISTS playground_runs;
DROP TABLE IF EXISTS event_outbox;
