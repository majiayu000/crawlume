BEGIN;

CREATE TABLE oidc_login_attempts (
  id UUID PRIMARY KEY,
  state_hash BYTEA NOT NULL CHECK (octet_length(state_hash) = 32),
  issuer TEXT NOT NULL CHECK (length(btrim(issuer)) > 0),
  client_id TEXT NOT NULL CHECK (length(btrim(client_id)) > 0),
  redirect_uri TEXT NOT NULL CHECK (length(btrim(redirect_uri)) > 0),
  code_verifier TEXT NOT NULL CHECK (length(code_verifier) BETWEEN 43 AND 128),
  nonce TEXT NOT NULL CHECK (length(btrim(nonce)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CONSTRAINT oidc_login_attempts_state_hash_unique UNIQUE (state_hash),
  CONSTRAINT oidc_login_attempts_expiration_after_creation CHECK (expires_at > created_at),
  CONSTRAINT oidc_login_attempts_consumption_after_creation CHECK (
    consumed_at IS NULL OR consumed_at >= created_at
  )
);

CREATE INDEX oidc_login_attempts_expiration
  ON oidc_login_attempts(expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL CHECK (octet_length(token_hash) = 32),
  previous_token_id UUID REFERENCES refresh_tokens(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT refresh_tokens_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT refresh_tokens_expiration_after_creation CHECK (expires_at > created_at),
  CONSTRAINT refresh_tokens_use_after_creation CHECK (used_at IS NULL OR used_at >= created_at),
  CONSTRAINT refresh_tokens_revocation_after_creation CHECK (
    revoked_at IS NULL OR revoked_at >= created_at
  )
);

CREATE INDEX refresh_tokens_family_active
  ON refresh_tokens(family_id, user_id, expires_at)
  WHERE revoked_at IS NULL AND used_at IS NULL;

CREATE INDEX refresh_tokens_user_active
  ON refresh_tokens(user_id, expires_at)
  WHERE revoked_at IS NULL;

COMMIT;
