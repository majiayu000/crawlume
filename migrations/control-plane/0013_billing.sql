BEGIN;

-- Prepaid credits per Organization. A missing row is a zero balance. Usage debits recorded when a
-- Job completes may take the balance below zero; Job creation refuses new work until it is topped up.
CREATE TABLE organization_credit_balances (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
  balance_credits BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE credit_ledger_entries (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('purchase', 'usage')),
  credits BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  source_key TEXT NOT NULL CHECK (length(btrim(source_key)) BETWEEN 1 AND 256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT credit_ledger_entries_source_unique UNIQUE (source_key),
  CONSTRAINT credit_ledger_entries_sign CHECK (
    (kind = 'purchase' AND credits > 0) OR (kind = 'usage' AND credits < 0)
  )
);

CREATE INDEX credit_ledger_entries_organization_created
  ON credit_ledger_entries(organization_id, created_at DESC, id DESC);

-- One row per billable meter of a completed Job, priced at completion time.
CREATE TABLE usage_events (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  project_id UUID NOT NULL,
  job_id UUID NOT NULL,
  meter TEXT NOT NULL CHECK (meter IN ('page_read', 'browser_read', 'crawl_page', 'search_query')),
  quantity BIGINT NOT NULL CHECK (quantity > 0),
  unit_credits BIGINT NOT NULL CHECK (unit_credits >= 0),
  credits BIGINT NOT NULL CHECK (credits >= 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT usage_events_project_fk
    FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT usage_events_job_fk
    FOREIGN KEY (job_id, project_id) REFERENCES jobs(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT usage_events_job_meter_unique UNIQUE (job_id, meter)
);

CREATE INDEX usage_events_project_occurred
  ON usage_events(project_id, occurred_at);

CREATE TABLE billing_checkout_sessions (
  id TEXT PRIMARY KEY CHECK (id ~ '^cs_[A-Za-z0-9_]{1,250}$'),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  pack_id TEXT NOT NULL CHECK (length(btrim(pack_id)) BETWEEN 1 AND 64),
  credits BIGINT NOT NULL CHECK (credits > 0),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  status TEXT NOT NULL CHECK (status IN ('open', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  CONSTRAINT billing_checkout_sessions_status_consistent CHECK (
    (status = 'open') = (completed_at IS NULL)
  )
);

CREATE INDEX billing_checkout_sessions_organization_created
  ON billing_checkout_sessions(organization_id, created_at DESC);

-- Processed Stripe event ids; a redelivered event is acknowledged without side effects.
CREATE TABLE stripe_webhook_events (
  id TEXT PRIMARY KEY CHECK (id ~ '^evt_[A-Za-z0-9_]{1,250}$'),
  type TEXT NOT NULL CHECK (length(btrim(type)) BETWEEN 1 AND 128),
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMIT;
