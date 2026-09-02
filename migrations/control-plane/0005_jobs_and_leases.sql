BEGIN;

CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type IN (
    'read', 'inspect', 'map', 'crawl', 'search'
  )),
  input JSONB NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  data_class TEXT NOT NULL CHECK (data_class IN ('public', 'authorized', 'intranet')),
  placement_class TEXT NOT NULL CHECK (placement_class IN ('public', 'private')),
  pinned_worker_id UUID,
  required_capabilities JSONB NOT NULL CHECK (jsonb_typeof(required_capabilities) = 'object'),
  budget_deadline_ms BIGINT NOT NULL CHECK (budget_deadline_ms > 0),
  budget_max_provider_attempts INTEGER NOT NULL CHECK (budget_max_provider_attempts > 0),
  budget_max_document_bytes BIGINT NOT NULL CHECK (budget_max_document_bytes > 0),
  budget_max_browser_ms BIGINT NOT NULL CHECK (budget_max_browser_ms >= 0),
  budget_max_browser_contexts INTEGER NOT NULL CHECK (budget_max_browser_contexts >= 0),
  policy_version TEXT NOT NULL CHECK (length(btrim(policy_version)) BETWEEN 1 AND 256),
  upload_private_artifact BOOLEAN NOT NULL DEFAULT FALSE,
  priority SMALLINT NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  not_before TIMESTAMPTZ NOT NULL,
  deadline_at TIMESTAMPTZ NOT NULL,
  envelope_hash BYTEA NOT NULL CHECK (octet_length(envelope_hash) = 32),
  status TEXT NOT NULL CHECK (status IN (
    'accepted', 'queued', 'assigned', 'running', 'paused',
    'completed', 'failed', 'cancelled'
  )),
  result_completeness TEXT CHECK (result_completeness IN ('complete', 'partial')),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  CONSTRAINT jobs_project_idempotency_unique UNIQUE (project_id, idempotency_key),
  CONSTRAINT jobs_id_project_unique UNIQUE (id, project_id),
  CONSTRAINT jobs_pinned_worker_fk
    FOREIGN KEY (pinned_worker_id, project_id)
    REFERENCES workers(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT jobs_private_data_placement CHECK (
    data_class = 'public' OR placement_class = 'private'
  ),
  CONSTRAINT jobs_pinned_worker_placement CHECK (
    pinned_worker_id IS NULL OR placement_class = 'private'
  ),
  CONSTRAINT jobs_schedule_consistent CHECK (
    not_before >= created_at AND deadline_at > created_at AND deadline_at > not_before
  ),
  CONSTRAINT jobs_terminal_consistent CHECK (
    (
      status = 'completed' AND result_completeness IS NOT NULL
      AND error_code IS NULL AND completed_at IS NOT NULL
    ) OR (
      status = 'failed' AND result_completeness IS NULL
      AND error_code IS NOT NULL AND length(btrim(error_code)) > 0
      AND completed_at IS NOT NULL
    ) OR (
      status = 'cancelled' AND result_completeness IS NULL
      AND error_code IS NULL AND completed_at IS NOT NULL
    ) OR (
      status NOT IN ('completed', 'failed', 'cancelled')
      AND result_completeness IS NULL AND error_code IS NULL AND completed_at IS NULL
    )
  )
);

CREATE INDEX jobs_project_created
  ON jobs(project_id, created_at DESC, id DESC);

CREATE INDEX jobs_claim_ready
  ON jobs(project_id, priority DESC, not_before, created_at, id)
  WHERE status = 'queued';

CREATE INDEX jobs_pinned_ready
  ON jobs(pinned_worker_id, project_id, not_before)
  WHERE status = 'queued' AND pinned_worker_id IS NOT NULL;

CREATE TABLE job_leases (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL,
  job_id UUID NOT NULL,
  worker_id UUID NOT NULL,
  generation BIGINT NOT NULL CHECK (generation > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'completed', 'cancelled')),
  claimed_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  heartbeat_deadline TIMESTAMPTZ NOT NULL,
  lease_deadline TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  CONSTRAINT job_leases_job_fk
    FOREIGN KEY (job_id, project_id)
    REFERENCES jobs(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT job_leases_worker_fk
    FOREIGN KEY (worker_id, project_id)
    REFERENCES workers(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT job_leases_submission_identity_unique
    UNIQUE (id, project_id, job_id, worker_id, generation),
  CONSTRAINT job_leases_job_generation_unique UNIQUE (job_id, generation),
  CONSTRAINT job_leases_deadlines_consistent CHECK (
    heartbeat_deadline > claimed_at
    AND lease_deadline > claimed_at
    AND heartbeat_deadline <= lease_deadline
  ),
  CONSTRAINT job_leases_status_consistent CHECK (
    (status = 'active' AND finished_at IS NULL) OR
    (status <> 'active' AND finished_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX job_leases_one_active
  ON job_leases(job_id)
  WHERE status = 'active';

CREATE INDEX job_leases_worker_heartbeat
  ON job_leases(worker_id, heartbeat_deadline)
  WHERE status = 'active';

CREATE INDEX job_leases_job_generation
  ON job_leases(job_id, generation DESC);

COMMIT;
