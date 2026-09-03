import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { recordAuditEvent, type AuditContext } from "./organization-authorization.js";
import type {
  AuthenticatedUser,
  ControlPlaneDatabase,
  ControlPlaneQuery,
  OrganizationRole,
} from "./project-scope.js";

export type OrganizationKind = "personal" | "business";

export type OrganizationSummary = Readonly<{
  id: string;
  slug: string;
  name: string;
  kind: OrganizationKind;
  role: OrganizationRole;
  createdAt: Date;
}>;

export type OrganizationProject = Readonly<{
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  createdAt: Date;
}>;

export type ProjectAdminCursor = Readonly<{
  createdAt: Date;
  id: string;
}>;

export type ProjectAdminPageInput = Readonly<{
  limit: number;
  before: ProjectAdminCursor | null;
}>;

export type CreateOrganizationProjectInput = Readonly<{
  slug: string;
  name: string;
}>;

type OrganizationRow = {
  id: string;
  slug: string;
  name: string;
  kind: OrganizationKind;
  role: OrganizationRole;
  created_at: Date;
};

type ProjectRow = {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  created_at: Date;
};

type OrganizationMembershipRow = { id: string; role: OrganizationRole | null };
type MembershipRow = { role: OrganizationRole };
type IdempotencyRow = { request_hash: Buffer; project_id: string };

export class ProjectAdminOrganizationNotFoundError extends Error {
  readonly code = "ORGANIZATION_NOT_FOUND";

  constructor() {
    super("The Organization is unavailable to the authenticated user.");
    this.name = "ProjectAdminOrganizationNotFoundError";
  }
}

export class ProjectAdminAccessDeniedError extends Error {
  readonly code = "PROJECT_ADMIN_FORBIDDEN";

  constructor() {
    super("The authenticated user cannot create Projects in this Organization.");
    this.name = "ProjectAdminAccessDeniedError";
  }
}

export class ProjectCreationIdempotencyConflictError extends Error {
  readonly code = "PROJECT_IDEMPOTENCY_CONFLICT";

  constructor() {
    super("The Idempotency-Key is already bound to a different Project request.");
    this.name = "ProjectCreationIdempotencyConflictError";
  }
}

export class ProjectAdminSlugConflictError extends Error {
  readonly code = "PROJECT_SLUG_CONFLICT";

  constructor() {
    super("A Project with this slug already exists in the Organization.");
    this.name = "ProjectAdminSlugConflictError";
  }
}

function requireValue(value: string, name: string): void {
  if (value.trim().length === 0) throw new Error(`${name} must be a non-empty string.`);
}

function requirePageInput(input: ProjectAdminPageInput): void {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 101) {
    throw new Error("input.limit must be an integer from 1 to 101.");
  }
  if (
    input.before !== null &&
    (!(input.before.createdAt instanceof Date) ||
      !Number.isFinite(input.before.createdAt.getTime()) ||
      input.before.id.trim().length === 0)
  ) {
    throw new Error("input.before must contain a valid creation time and ID.");
  }
}

function organizationFromRow(row: OrganizationRow): OrganizationSummary {
  return Object.freeze({
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    role: row.role,
    createdAt: row.created_at,
  });
}

function adminProjectFromRow(row: ProjectRow): OrganizationProject {
  return Object.freeze({
    id: row.id,
    organizationId: row.organization_id,
    slug: row.slug,
    name: row.name,
    createdAt: row.created_at,
  });
}

function projectRequestHash(input: CreateOrganizationProjectInput): Buffer {
  return createHash("sha256").update(JSON.stringify({ slug: input.slug, name: input.name })).digest();
}

async function accessibleOrganizationRole(
  transaction: ControlPlaneQuery,
  subject: AuthenticatedUser,
  organizationId: string,
  lock: boolean,
): Promise<OrganizationRole> {
  const result = lock
    ? await transaction.query<OrganizationMembershipRow>(`
        SELECT organizations.id, organization_memberships.role
        FROM organizations
        LEFT JOIN organization_memberships
          ON organization_memberships.organization_id = organizations.id
          AND organization_memberships.user_id = $2
        WHERE organizations.id = $1
        FOR UPDATE OF organizations
      `, [organizationId, subject.userId])
    : await transaction.query<MembershipRow>(`
        SELECT role
        FROM organization_memberships
        WHERE organization_id = $1 AND user_id = $2
        LIMIT 1
      `, [organizationId, subject.userId]);
  const role = result.rows[0]?.role;
  if (role === undefined || role === null) throw new ProjectAdminOrganizationNotFoundError();
  return role;
}

async function idempotentProject(
  transaction: ControlPlaneQuery,
  organizationId: string,
  idempotencyKey: string,
  requestHash: Buffer,
): Promise<OrganizationProject | null> {
  const existing = await transaction.query<IdempotencyRow>(`
    SELECT request_hash, project_id
    FROM project_creation_idempotency
    WHERE organization_id = $1 AND idempotency_key = $2
    LIMIT 1
  `, [organizationId, idempotencyKey]);
  const record = existing.rows[0];
  if (record === undefined) return null;
  if (record.request_hash.byteLength !== requestHash.byteLength ||
      !timingSafeEqual(record.request_hash, requestHash)) {
    throw new ProjectCreationIdempotencyConflictError();
  }
  const replay = await transaction.query<ProjectRow>(`
    SELECT id, organization_id, slug, name, created_at
    FROM projects
    WHERE id = $1 AND organization_id = $2
    LIMIT 1
  `, [record.project_id, organizationId]);
  const row = replay.rows[0];
  if (row === undefined) {
    throw new Error("Project creation idempotency record references a missing Project.");
  }
  return adminProjectFromRow(row);
}

export async function listOrganizations(
  database: ControlPlaneQuery,
  subject: AuthenticatedUser,
  input: ProjectAdminPageInput,
): Promise<readonly OrganizationSummary[]> {
  requireValue(subject.userId, "subject.userId");
  requirePageInput(input);
  const result = await database.query<OrganizationRow>(`
    SELECT
      organizations.id,
      organizations.slug,
      organizations.name,
      organizations.kind,
      organization_memberships.role,
      organizations.created_at
    FROM organizations
    INNER JOIN organization_memberships
      ON organization_memberships.organization_id = organizations.id
    WHERE organization_memberships.user_id = $1
      AND ($2::timestamptz IS NULL OR (organizations.created_at, organizations.id) < ($2, $3::uuid))
    ORDER BY organizations.created_at DESC, organizations.id DESC
    LIMIT $4
  `, [subject.userId, input.before?.createdAt ?? null, input.before?.id ?? null, input.limit]);
  return Object.freeze(result.rows.map(organizationFromRow));
}

export async function listOrganizationProjects(
  database: ControlPlaneDatabase,
  subject: AuthenticatedUser,
  organizationId: string,
  input: ProjectAdminPageInput,
): Promise<readonly OrganizationProject[]> {
  requireValue(subject.userId, "subject.userId");
  requireValue(organizationId, "organizationId");
  requirePageInput(input);
  return database.transaction(async (transaction) => {
    await accessibleOrganizationRole(transaction, subject, organizationId, false);
    const result = await transaction.query<ProjectRow>(`
      SELECT projects.id, projects.organization_id, projects.slug, projects.name, projects.created_at
      FROM projects
      INNER JOIN organization_memberships
        ON organization_memberships.organization_id = projects.organization_id
        AND organization_memberships.user_id = $2
      WHERE projects.organization_id = $1
        AND ($3::timestamptz IS NULL OR (projects.created_at, projects.id) < ($3, $4::uuid))
      ORDER BY projects.created_at DESC, projects.id DESC
      LIMIT $5
    `, [
      organizationId,
      subject.userId,
      input.before?.createdAt ?? null,
      input.before?.id ?? null,
      input.limit,
    ]);
    return Object.freeze(result.rows.map(adminProjectFromRow));
  });
}

export async function createOrganizationProject(
  database: ControlPlaneDatabase,
  subject: AuthenticatedUser,
  organizationId: string,
  idempotencyKey: string,
  input: CreateOrganizationProjectInput,
  auditContext: AuditContext,
): Promise<OrganizationProject> {
  requireValue(subject.userId, "subject.userId");
  requireValue(organizationId, "organizationId");
  const normalizedIdempotencyKey = idempotencyKey.trim();
  requireValue(normalizedIdempotencyKey, "idempotencyKey");
  if (normalizedIdempotencyKey.length > 200) {
    throw new Error("idempotencyKey must not exceed 200 characters.");
  }
  requireValue(input.slug, "input.slug");
  requireValue(input.name, "input.name");
  const requestHash = projectRequestHash(input);

  return database.transaction(async (transaction) => {
    const role = await accessibleOrganizationRole(transaction, subject, organizationId, true);
    if (role !== "owner" && role !== "admin") throw new ProjectAdminAccessDeniedError();

    const replay = await idempotentProject(
      transaction,
      organizationId,
      normalizedIdempotencyKey,
      requestHash,
    );
    if (replay !== null) return replay;

    const projectId = randomUUID();
    const inserted = await transaction.query<ProjectRow>(`
      INSERT INTO projects(id, organization_id, slug, name)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (organization_id, slug) DO NOTHING
      RETURNING id, organization_id, slug, name, created_at
    `, [projectId, organizationId, input.slug, input.name]);
    const row = inserted.rows[0];
    if (row === undefined) throw new ProjectAdminSlugConflictError();

    await recordAuditEvent(transaction, {
      organizationId,
      projectId: row.id,
      actorType: "user",
      actorId: subject.userId,
      action: "project.created",
      targetType: "project",
      targetId: row.id,
      outcome: "succeeded",
      correlationId: auditContext.correlationId,
    });
    await transaction.query(`
      INSERT INTO project_creation_idempotency(
        organization_id, idempotency_key, request_hash, project_id
      ) VALUES ($1, $2, $3, $4)
    `, [organizationId, normalizedIdempotencyKey, requestHash, row.id]);
    return adminProjectFromRow(row);
  });
}
