BEGIN;

CREATE TABLE webhook_endpoints (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  url TEXT NOT NULL CHECK (url LIKE 'https://%' AND length(url) <= 2048),
  event_types TEXT[] NOT NULL CHECK (
    cardinality(event_types) > 0 AND
    event_types <@ ARRAY['job.completed', 'job.failed', 'job.cancelled']::text[]
  ),
  secret_ciphertext BYTEA NOT NULL,
  previous_secret_ciphertext BYTEA,
  previous_secret_expires_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT webhook_endpoints_id_project_unique UNIQUE (id, project_id),
  CONSTRAINT webhook_endpoints_previous_secret_consistent CHECK (
    (previous_secret_ciphertext IS NULL) = (previous_secret_expires_at IS NULL)
  )
);

CREATE INDEX webhook_endpoints_project_active
  ON webhook_endpoints(project_id) WHERE status = 'active';

CREATE TABLE webhook_events (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('job.completed', 'job.failed', 'job.cancelled')),
  job_id UUID NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT webhook_events_job_fk
    FOREIGN KEY (job_id, project_id) REFERENCES jobs(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT webhook_events_id_project_unique UNIQUE (id, project_id)
);

CREATE INDEX webhook_events_project_occurred
  ON webhook_events(project_id, occurred_at DESC, id DESC);

CREATE TABLE webhook_deliveries (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL,
  event_id UUID NOT NULL,
  endpoint_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL,
  locked_until TIMESTAMPTZ,
  last_status_code SMALLINT,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 1024),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT webhook_deliveries_event_fk
    FOREIGN KEY (event_id, project_id) REFERENCES webhook_events(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT webhook_deliveries_endpoint_fk
    FOREIGN KEY (endpoint_id, project_id) REFERENCES webhook_endpoints(id, project_id)
    ON DELETE RESTRICT
);

CREATE INDEX webhook_deliveries_due
  ON webhook_deliveries(next_attempt_at, id) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_project_created
  ON webhook_deliveries(project_id, created_at DESC, id DESC);

CREATE TABLE webhook_delivery_attempts (
  delivery_id UUID NOT NULL REFERENCES webhook_deliveries(id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status_code SMALLINT,
  error TEXT CHECK (error IS NULL OR length(error) <= 1024),
  started_at TIMESTAMPTZ NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  PRIMARY KEY (delivery_id, attempt)
);

-- Every terminal Job transition, from any code path, records one event and fans it out to the
-- Project's active endpoints in the same transaction.
CREATE FUNCTION record_job_webhook_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  event_id UUID := gen_random_uuid();
  event_type TEXT := 'job.' || NEW.status;
  occurred TIMESTAMPTZ := clock_timestamp();
BEGIN
  INSERT INTO webhook_events(id, project_id, event_type, job_id, payload, occurred_at)
  VALUES (
    event_id, NEW.project_id, event_type, NEW.id,
    jsonb_build_object(
      'job_id', NEW.id,
      'project_id', NEW.project_id,
      'status', NEW.status,
      'result_completeness', NEW.result_completeness,
      'error_code', NEW.error_code
    ),
    occurred
  );
  INSERT INTO webhook_deliveries(id, project_id, event_id, endpoint_id, status, next_attempt_at)
  SELECT gen_random_uuid(), NEW.project_id, event_id, endpoints.id, 'pending', occurred
  FROM webhook_endpoints AS endpoints
  WHERE endpoints.project_id = NEW.project_id AND endpoints.status = 'active'
    AND event_type = ANY(endpoints.event_types);
  RETURN NULL;
END;
$$;

CREATE TRIGGER jobs_terminal_webhook_event
  AFTER UPDATE OF status ON jobs
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('completed', 'failed', 'cancelled'))
  EXECUTE FUNCTION record_job_webhook_event();

COMMIT;
