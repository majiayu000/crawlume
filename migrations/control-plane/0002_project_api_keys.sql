BEGIN;

CREATE TABLE api_keys (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  display_prefix TEXT NOT NULL CHECK (length(btrim(display_prefix)) > 0),
  key_hash BYTEA NOT NULL CHECK (octet_length(key_hash) = 32),
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  tasks_write BOOLEAN NOT NULL DEFAULT FALSE,
  results_read BOOLEAN NOT NULL DEFAULT FALSE,
  project_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT api_keys_key_hash_unique UNIQUE (key_hash),
  CONSTRAINT api_keys_at_least_one_scope CHECK (
    tasks_write OR results_read OR project_admin
  ),
  CONSTRAINT api_keys_expiration_after_creation CHECK (
    expires_at IS NULL OR expires_at > created_at
  ),
  CONSTRAINT api_keys_last_use_after_creation CHECK (
    last_used_at IS NULL OR last_used_at >= created_at
  ),
  CONSTRAINT api_keys_revocation_after_creation CHECK (
    revoked_at IS NULL OR revoked_at >= created_at
  )
);

CREATE INDEX api_keys_project_created
  ON api_keys(project_id, created_at DESC, id DESC);

COMMIT;
