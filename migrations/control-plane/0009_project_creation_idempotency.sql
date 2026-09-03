BEGIN;

CREATE TABLE project_creation_idempotency (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (
    length(btrim(idempotency_key)) BETWEEN 1 AND 200
  ),
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
  project_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, idempotency_key),
  CONSTRAINT project_creation_idempotency_project_owner_fk
    FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id)
    ON DELETE RESTRICT
);

COMMIT;
