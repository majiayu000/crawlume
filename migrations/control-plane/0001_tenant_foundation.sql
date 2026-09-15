BEGIN;

CREATE TABLE users (
  id UUID PRIMARY KEY,
  oidc_issuer TEXT NOT NULL CHECK (length(btrim(oidc_issuer)) > 0),
  oidc_subject TEXT NOT NULL CHECK (length(btrim(oidc_subject)) > 0),
  email TEXT,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT users_oidc_identity_unique UNIQUE (oidc_issuer, oidc_subject)
);

CREATE TABLE organizations (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL CHECK (length(btrim(slug)) > 0),
  name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'business')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT organizations_slug_unique UNIQUE (slug)
);

CREATE TABLE organization_memberships (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX organization_memberships_user_id
  ON organization_memberships(user_id, organization_id);

CREATE TABLE projects (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  slug TEXT NOT NULL CHECK (length(btrim(slug)) > 0),
  name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT projects_organization_slug_unique UNIQUE (organization_id, slug),
  CONSTRAINT projects_id_organization_unique UNIQUE (id, organization_id)
);

COMMIT;
