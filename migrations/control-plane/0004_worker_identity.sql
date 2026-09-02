BEGIN;

CREATE TABLE workers (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 128),
  kind TEXT NOT NULL DEFAULT 'private' CHECK (kind IN ('public', 'private')),
  version TEXT NOT NULL CHECK (length(btrim(version)) BETWEEN 1 AND 128),
  capability_manifest JSONB NOT NULL CHECK (jsonb_typeof(capability_manifest) = 'object'),
  capability_hash BYTEA NOT NULL CHECK (octet_length(capability_hash) = 32),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  CONSTRAINT workers_project_name_unique UNIQUE (project_id, name),
  CONSTRAINT workers_id_project_unique UNIQUE (id, project_id),
  CONSTRAINT workers_status_consistent CHECK (
    (status = 'active' AND disabled_at IS NULL) OR
    (status = 'disabled' AND disabled_at IS NOT NULL)
  ),
  CONSTRAINT workers_last_seen_after_creation CHECK (
    last_seen_at IS NULL OR last_seen_at >= created_at
  )
);

CREATE INDEX workers_project_status
  ON workers(project_id, status, created_at DESC, id DESC);

CREATE TABLE worker_public_keys (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL,
  worker_id UUID NOT NULL,
  algorithm TEXT NOT NULL CHECK (algorithm = 'Ed25519'),
  public_key_spki BYTEA NOT NULL,
  fingerprint BYTEA NOT NULL CHECK (octet_length(fingerprint) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT worker_public_keys_worker_fk
    FOREIGN KEY (worker_id, project_id)
    REFERENCES workers(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT worker_public_keys_project_fingerprint_unique UNIQUE (project_id, fingerprint),
  CONSTRAINT worker_public_keys_identity_unique UNIQUE (id, worker_id, project_id),
  CONSTRAINT worker_public_keys_revocation_after_creation CHECK (
    revoked_at IS NULL OR revoked_at >= created_at
  )
);

CREATE UNIQUE INDEX worker_public_keys_one_active
  ON worker_public_keys(worker_id)
  WHERE revoked_at IS NULL;

CREATE TABLE worker_enrollments (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  worker_name TEXT NOT NULL CHECK (length(btrim(worker_name)) BETWEEN 1 AND 128),
  token_hash BYTEA NOT NULL CHECK (octet_length(token_hash) = 32),
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CONSTRAINT worker_enrollments_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT worker_enrollments_expiration_after_creation CHECK (expires_at > created_at),
  CONSTRAINT worker_enrollments_consumption_after_creation CHECK (
    consumed_at IS NULL OR consumed_at >= created_at
  )
);

CREATE INDEX worker_enrollments_project_open
  ON worker_enrollments(project_id, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE worker_session_challenges (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL,
  worker_id UUID NOT NULL,
  public_key_id UUID NOT NULL,
  challenge_hash BYTEA NOT NULL CHECK (octet_length(challenge_hash) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CONSTRAINT worker_session_challenges_hash_unique UNIQUE (challenge_hash),
  CONSTRAINT worker_session_challenges_worker_fk
    FOREIGN KEY (worker_id, project_id)
    REFERENCES workers(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT worker_session_challenges_key_fk
    FOREIGN KEY (public_key_id, worker_id, project_id)
    REFERENCES worker_public_keys(id, worker_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT worker_session_challenges_expiration_after_creation CHECK (expires_at > created_at),
  CONSTRAINT worker_session_challenges_consumption_after_creation CHECK (
    consumed_at IS NULL OR consumed_at >= created_at
  )
);

CREATE INDEX worker_session_challenges_worker_open
  ON worker_session_challenges(worker_id, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE worker_sessions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL,
  worker_id UUID NOT NULL,
  public_key_id UUID NOT NULL,
  capability_hash BYTEA NOT NULL CHECK (octet_length(capability_hash) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT worker_sessions_worker_fk
    FOREIGN KEY (worker_id, project_id)
    REFERENCES workers(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT worker_sessions_key_fk
    FOREIGN KEY (public_key_id, worker_id, project_id)
    REFERENCES worker_public_keys(id, worker_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT worker_sessions_expiration_after_creation CHECK (expires_at > created_at),
  CONSTRAINT worker_sessions_revocation_after_creation CHECK (
    revoked_at IS NULL OR revoked_at >= created_at
  )
);

CREATE INDEX worker_sessions_worker_active
  ON worker_sessions(worker_id, expires_at)
  WHERE revoked_at IS NULL;

COMMIT;
