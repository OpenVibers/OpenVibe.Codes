-- phase: expand
-- One-time import links (plan §AD.24, the owner 11-18: "a prompt method they can just send their agent and a manual
-- method"): a signed-in person makes a link on openvibe.codes/import; it lets one upload of one session into their
-- account, within 30 minutes, and nothing else. The agent (or the person) runs the importer with it, so no Network
-- token is copied by hand. Only the token's sha256 is kept. Older releases ignore this table.
CREATE TABLE IF NOT EXISTS codes_session_import_links (
    token_hash  text COLLATE "C" PRIMARY KEY,                -- sha256 hex of the cdi_… token
    subject     text COLLATE "C" NOT NULL,                   -- usr_… whose account the upload goes to
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    import_id   text COLLATE "C"                             -- imp_… the upload made
);
CREATE INDEX IF NOT EXISTS codes_session_import_links_subject ON codes_session_import_links (subject, created_at DESC);
