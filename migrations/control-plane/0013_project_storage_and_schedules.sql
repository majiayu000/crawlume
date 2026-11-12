BEGIN;

-- Project-scoped generic storage (datasets, key-value stores) and cron Job schedules.
-- Names are unique per Project; every child row carries project_id so lookups stay scoped.

CREATE TABLE datasets (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  item_count BIGINT NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT datasets_project_name_unique UNIQUE (project_id, name),
  CONSTRAINT datasets_id_project_unique UNIQUE (id, project_id)
);

-- Items are append-only; sequence is 1-based and contiguous per dataset (item_count is the last one).
CREATE TABLE dataset_items (
  project_id UUID NOT NULL,
  dataset_id UUID NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  item JSONB NOT NULL CHECK (jsonb_typeof(item) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (dataset_id, sequence),
  CONSTRAINT dataset_items_dataset_fk
    FOREIGN KEY (dataset_id, project_id)
    REFERENCES datasets(id, project_id) ON DELETE CASCADE
);

-- A Job may name an output dataset; completing it appends one result item there.
ALTER TABLE jobs
  ADD COLUMN dataset_id UUID,
  ADD CONSTRAINT jobs_dataset_fk
    FOREIGN KEY (dataset_id, project_id)
    REFERENCES datasets(id, project_id) ON DELETE RESTRICT;

CREATE TABLE key_value_stores (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT key_value_stores_project_name_unique UNIQUE (project_id, name),
  CONSTRAINT key_value_stores_id_project_unique UNIQUE (id, project_id)
);

CREATE TABLE key_value_records (
  project_id UUID NOT NULL,
  store_id UUID NOT NULL,
  key TEXT NOT NULL CHECK (length(key) <= 256 AND key ~ '^[A-Za-z0-9!._''()*-]+$'),
  content_type TEXT NOT NULL CHECK (length(btrim(content_type)) BETWEEN 1 AND 255),
  value BYTEA NOT NULL,
  byte_count BIGINT NOT NULL CHECK (byte_count = octet_length(value)),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (store_id, key),
  CONSTRAINT key_value_records_store_fk
    FOREIGN KEY (store_id, project_id)
    REFERENCES key_value_stores(id, project_id) ON DELETE CASCADE
);

-- next_fire_at is the fence: a firing locks the row, creates the Job with the idempotency key
-- schedule:<id>:<next_fire_at>, and advances next_fire_at in one transaction.
CREATE TABLE job_schedules (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  cron TEXT NOT NULL CHECK (length(btrim(cron)) BETWEEN 1 AND 128),
  job_request JSONB NOT NULL CHECK (jsonb_typeof(job_request) = 'object'),
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  next_fire_at TIMESTAMPTZ NOT NULL,
  last_fired_at TIMESTAMPTZ,
  last_job_id UUID,
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(btrim(last_error_code)) BETWEEN 1 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT job_schedules_project_name_unique UNIQUE (project_id, name),
  CONSTRAINT job_schedules_last_job_fk
    FOREIGN KEY (last_job_id, project_id)
    REFERENCES jobs(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX job_schedules_due
  ON job_schedules(next_fire_at, id)
  WHERE enabled;

COMMIT;
