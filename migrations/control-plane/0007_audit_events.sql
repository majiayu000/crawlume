BEGIN;

CREATE TABLE audit_events (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  project_id UUID NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'api_key', 'worker')),
  actor_id TEXT NOT NULL CHECK (length(btrim(actor_id)) BETWEEN 1 AND 200),
  action TEXT NOT NULL CHECK (length(btrim(action)) BETWEEN 1 AND 128),
  target_type TEXT NOT NULL CHECK (length(btrim(target_type)) BETWEEN 1 AND 128),
  target_id TEXT NOT NULL CHECK (length(btrim(target_id)) BETWEEN 1 AND 200),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  correlation_id TEXT NOT NULL CHECK (length(btrim(correlation_id)) BETWEEN 1 AND 200),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT audit_events_project_owner_fk
    FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX audit_events_project_occurred
  ON audit_events(project_id, occurred_at DESC, id DESC);

CREATE FUNCTION reject_audit_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER audit_events_reject_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();

CREATE TRIGGER audit_events_reject_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_event_mutation();

COMMIT;
