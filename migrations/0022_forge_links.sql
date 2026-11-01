-- phase: expand
-- A person's link to their OpenVibe Git account (git.openvibe.codes, Forgejo): the forge's OAuth2 tokens Codes uses to
-- create repositories in their name and to let their own machine clone and push them. The tokens are sealed
-- (AES-256-GCM, CODES_SEAL_KEY) and never exported, shown or logged; the person unlinks here or revokes on the forge.
CREATE TABLE IF NOT EXISTS codes_forge_links (
    subject        text COLLATE "C" PRIMARY KEY,         -- usr_… the person
    forge_user     text COLLATE "C" NOT NULL,            -- their login on the forge
    token_sealed   text NOT NULL,                        -- the access token, sealed
    refresh_sealed text,                                 -- the refresh token, sealed
    expires_at     timestamptz,                          -- when the access token ends
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
