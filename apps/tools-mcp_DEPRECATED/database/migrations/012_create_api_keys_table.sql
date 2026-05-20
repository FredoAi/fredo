-- Migration 012: Create api_keys table
-- API keys for authenticating requests to the API server and MCP server.
-- Raw keys are NEVER stored — only a SHA-256 hex digest (key_hash) is persisted.
-- The first 16 chars of the raw key (key_prefix) are stored for display/identification.
-- New keys are generated via: pnpm --filter tools-mcp create-api-key <email> [name]

CREATE TABLE IF NOT EXISTS api_keys (
  id           BIGSERIAL       PRIMARY KEY,
  email        VARCHAR(255)    NOT NULL,
  name         VARCHAR(255)    NOT NULL DEFAULT '',
  key_hash     CHAR(64)        NOT NULL UNIQUE,   -- SHA-256 hex digest of the raw key
  key_prefix   VARCHAR(16)     NOT NULL,           -- First 16 chars of raw key (display only)
  is_active    BOOLEAN         NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ     NULL,
  expires_at   TIMESTAMPTZ     NULL
);

COMMENT ON TABLE  api_keys                IS 'API keys used to authenticate requests to the API and MCP servers';
COMMENT ON COLUMN api_keys.email          IS 'Email address of the key owner';
COMMENT ON COLUMN api_keys.name           IS 'Human-readable label for the key';
COMMENT ON COLUMN api_keys.key_hash       IS 'SHA-256 hex digest of the raw API key — raw key is never stored';
COMMENT ON COLUMN api_keys.key_prefix     IS 'First 16 characters of the raw key, used for identification';
COMMENT ON COLUMN api_keys.is_active      IS 'Set to false to revoke a key without deleting it';
COMMENT ON COLUMN api_keys.last_used_at   IS 'Updated on each successful authentication';
COMMENT ON COLUMN api_keys.expires_at     IS 'NULL means the key never expires';

CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_email    ON api_keys (email);
CREATE INDEX IF NOT EXISTS idx_api_keys_active   ON api_keys (is_active);
