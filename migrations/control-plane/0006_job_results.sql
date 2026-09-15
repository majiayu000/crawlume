BEGIN;

CREATE TABLE artifact_metadata (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL,
  job_id UUID NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  content_hash BYTEA NOT NULL CHECK (octet_length(content_hash) = 32),
  byte_count BIGINT NOT NULL CHECK (byte_count >= 0),
  media_type TEXT NOT NULL CHECK (length(btrim(media_type)) BETWEEN 1 AND 255),
  storage_kind TEXT NOT NULL CHECK (storage_kind IN ('worker_local', 'cloud_object')),
  object_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT artifact_metadata_job_fk
    FOREIGN KEY (job_id, project_id)
    REFERENCES jobs(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT artifact_metadata_submission_identity_unique UNIQUE (id, project_id, job_id),
  CONSTRAINT artifact_metadata_storage_consistent CHECK (
    (storage_kind = 'worker_local' AND object_key IS NULL) OR
    (storage_kind = 'cloud_object' AND length(btrim(object_key)) > 0)
  )
);

CREATE INDEX artifact_metadata_project_created
  ON artifact_metadata(project_id, created_at DESC, id DESC);

CREATE TABLE job_events (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL,
  job_id UUID NOT NULL,
  lease_id UUID NOT NULL,
  worker_id UUID NOT NULL,
  lease_generation BIGINT NOT NULL CHECK (lease_generation > 0),
  local_sequence BIGINT NOT NULL CHECK (local_sequence > 0),
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  payload_hash BYTEA NOT NULL CHECK (octet_length(payload_hash) = 32),
  event_type TEXT NOT NULL CHECK (length(btrim(event_type)) BETWEEN 1 AND 64),
  page_status SMALLINT CHECK (page_status BETWEEN 100 AND 599),
  error_code TEXT CHECK (error_code IS NULL OR length(btrim(error_code)) BETWEEN 1 AND 128),
  provider TEXT CHECK (provider IS NULL OR length(btrim(provider)) BETWEEN 1 AND 128),
  byte_count BIGINT NOT NULL CHECK (byte_count >= 0),
  duration_ms BIGINT NOT NULL CHECK (duration_ms >= 0),
  content_hash BYTEA CHECK (content_hash IS NULL OR octet_length(content_hash) = 32),
  usage JSONB NOT NULL CHECK (jsonb_typeof(usage) = 'object'),
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT job_events_lease_fk
    FOREIGN KEY (lease_id, project_id, job_id, worker_id, lease_generation)
    REFERENCES job_leases(id, project_id, job_id, worker_id, generation) ON DELETE RESTRICT,
  CONSTRAINT job_events_job_sequence_unique UNIQUE (job_id, sequence),
  CONSTRAINT job_events_lease_local_sequence_unique UNIQUE (lease_id, local_sequence)
);

CREATE INDEX job_events_project_job_sequence
  ON job_events(project_id, job_id, sequence);

CREATE TABLE job_publications (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL,
  job_id UUID NOT NULL,
  lease_id UUID NOT NULL,
  worker_id UUID NOT NULL,
  lease_generation BIGINT NOT NULL CHECK (lease_generation > 0),
  local_sequence BIGINT NOT NULL CHECK (local_sequence > 0),
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  publication_hash BYTEA NOT NULL CHECK (octet_length(publication_hash) = 32),
  artifact_id UUID NOT NULL,
  result_completeness TEXT NOT NULL CHECK (result_completeness IN ('complete', 'partial')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT job_publications_lease_fk
    FOREIGN KEY (lease_id, project_id, job_id, worker_id, lease_generation)
    REFERENCES job_leases(id, project_id, job_id, worker_id, generation) ON DELETE RESTRICT,
  CONSTRAINT job_publications_artifact_fk
    FOREIGN KEY (artifact_id, project_id, job_id)
    REFERENCES artifact_metadata(id, project_id, job_id) ON DELETE RESTRICT,
  CONSTRAINT job_publications_job_sequence_unique UNIQUE (job_id, sequence),
  CONSTRAINT job_publications_lease_local_sequence_unique UNIQUE (lease_id, local_sequence)
);

CREATE INDEX job_publications_project_job_sequence
  ON job_publications(project_id, job_id, sequence);

COMMIT;
