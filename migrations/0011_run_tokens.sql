-- phase: expand
-- Stage C3 (openvibe.codes v1): the run tokens. A run token is the short-lived Network token an attempt's harness
-- carries, so that OpenVibe.AI knows whose own key and whose budget a request is. It is bound to one task and lives
-- at most two hours.
--
-- Codes keeps no copy of the token: this table holds its jti and its expiry, so a run can be traced and a token can
-- be matched with the attempt that carried it. The token itself is in the harness's environment and nowhere else.
--
--   id          the row's id (rtk_<ULID>)
--   task_id     the task the token was minted for
--   attempt_id  the attempt that carried it
--   subject     the person it acts for
--   provider    the provider whose key it names (null when the run used AI's own providers)
--   jti         the token's id (its hash, never the token)
--   expires_at  when the token stops working

CREATE TABLE IF NOT EXISTS codes_run_tokens (
    id          text COLLATE "C" PRIMARY KEY,             -- rtk_<ULID>
    task_id     text COLLATE "C",                        -- tsk_<ULID>
    attempt_id  text COLLATE "C",                        -- att_<ULID>
    subject     text COLLATE "C",                        -- usr_<ULID>: the person the token acts for
    provider    text COLLATE "C",                        -- anthropic, openai, deepseek, …
    jti         text COLLATE "C",                        -- the token's id, never the token
    expires_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS codes_run_tokens_task ON codes_run_tokens (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS codes_run_tokens_attempt ON codes_run_tokens (attempt_id) WHERE attempt_id IS NOT NULL;
