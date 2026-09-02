import { createHash, randomUUID } from "node:crypto";

import type { AuthenticatedProjectApiKey, AuthenticatedWorker } from "./api-key-service.js";
import type {
  ControlPlaneDatabase,
  ControlPlaneQuery,
  JobDataClass,
  OrganizationRole,
  ProjectScope,
} from "./project-scope.js";

type IdRow = { id: string };
type RoleRow = { role: OrganizationRole };

export class OrganizationAccessDeniedError extends Error {
  readonly code = "ORGANIZATION_ACCESS_DENIED";

  constructor() {
    super("The authenticated subject cannot perform this organization operation.");
    this.name = "OrganizationAccessDeniedError";
  }
}

export async function authorizeOrganizationWrite(
  transaction: ControlPlaneQuery,
  scope: ProjectScope,
  allowedRoles: readonly OrganizationRole[],
): Promise<OrganizationRole> {
  const organization = await transaction.query<IdRow>(`
    SELECT id
    FROM organizations
    WHERE id = $1
    FOR UPDATE
  `, [scope.organizationId]);
  if (organization.rows[0] === undefined) {
    throw new OrganizationAccessDeniedError();
  }

  const membership = await transaction.query<RoleRow>(`
    SELECT role
    FROM organization_memberships
    WHERE organization_id = $1 AND user_id = $2
    LIMIT 1
  `, [scope.organizationId, scope.userId]);
  const currentRole = membership.rows[0]?.role;
  if (currentRole === undefined || !allowedRoles.includes(currentRole)) {
    throw new OrganizationAccessDeniedError();
  }
  return currentRole;
}

export type JobEventInput = Readonly<{
  localSequence: number;
  eventType: string;
  pageStatus: number | null;
  errorCode: string | null;
  provider: string | null;
  byteCount: number;
  durationMs: number;
  contentHash: string | null;
  usage: Readonly<Record<string, number>>;
  occurredAt: Date;
}>;

export type JobEvent = Readonly<{
  id: string;
  projectId: string;
  jobId: string;
  leaseId: string;
  workerId: string;
  leaseGeneration: number;
  localSequence: number;
  sequence: number;
  eventType: string;
  pageStatus: number | null;
  errorCode: string | null;
  provider: string | null;
  byteCount: number;
  durationMs: number;
  contentHash: string | null;
  usage: Readonly<Record<string, number>>;
  occurredAt: Date;
  recordedAt: Date;
}>;

export type PublishJobResultInput = Readonly<{
  localSequence: number;
  contentHash: string;
  byteCount: number;
  mediaType: string;
  completeness: "complete" | "partial";
  storage: "worker_local" | "cloud_object";
}>;

export type ArtifactMetadata = Readonly<{
  id: string;
  projectId: string;
  jobId: string;
  version: number;
  contentHash: string;
  byteCount: number;
  mediaType: string;
  storage: "worker_local" | "cloud_object";
  objectKey: string | null;
  createdAt: Date;
}>;

export type JobPublication = Readonly<{
  id: string;
  projectId: string;
  jobId: string;
  leaseId: string;
  workerId: string;
  leaseGeneration: number;
  localSequence: number;
  sequence: number;
  completeness: "complete" | "partial";
  recordedAt: Date;
  artifact: ArtifactMetadata;
}>;

export type JobPublicationPage = Readonly<{
  items: readonly JobPublication[];
  hasMore: boolean;
  nextSequence: number | null;
}>;

type SubmissionLeaseRow = {
  job_id: string;
  organization_id: string;
  data_class: JobDataClass;
  upload_private_artifact: boolean;
};

type JobEventRow = {
  id: string;
  project_id: string;
  job_id: string;
  lease_id: string;
  worker_id: string;
  lease_generation: number | string;
  local_sequence: number | string;
  sequence: number | string;
  payload_hash: Buffer;
  event_type: string;
  page_status: number | null;
  error_code: string | null;
  provider: string | null;
  byte_count: number | string;
  duration_ms: number | string;
  content_hash: Buffer | null;
  usage: Record<string, number>;
  occurred_at: Date;
  recorded_at: Date;
};

type ArtifactMetadataRow = {
  id: string;
  project_id: string;
  job_id: string;
  version: number;
  content_hash: Buffer;
  byte_count: number | string;
  media_type: string;
  storage_kind: "worker_local" | "cloud_object";
  object_key: string | null;
  created_at: Date;
};

type JobPublicationRow = {
  id: string;
  project_id: string;
  job_id: string;
  lease_id: string;
  worker_id: string;
  lease_generation: number | string;
  local_sequence: number | string;
  sequence: number | string;
  publication_hash: Buffer;
  result_completeness: "complete" | "partial";
  recorded_at: Date;
};

type ExistingPublicationRow = JobPublicationRow & {
  artifact_id: string;
  artifact_version: number;
  artifact_content_hash: Buffer;
  artifact_byte_count: number | string;
  artifact_media_type: string;
  artifact_storage_kind: "worker_local" | "cloud_object";
  artifact_object_key: string | null;
  artifact_created_at: Date;
};

export class JobResultValidationError extends Error {
  readonly code = "JOB_RESULT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "JobResultValidationError";
  }
}

export class JobResultWorkerAccessDeniedError extends Error {
  readonly code = "JOB_RESULT_WORKER_ACCESS_DENIED";
  constructor() {
    super("The Worker session cannot submit Job results.");
    this.name = "JobResultWorkerAccessDeniedError";
  }
}

export class JobResultLeaseFencedError extends Error {
  readonly code = "JOB_RESULT_LEASE_FENCED";
  constructor() {
    super("The Job result lease is expired, inactive, or fenced by another generation.");
    this.name = "JobResultLeaseFencedError";
  }
}

export class JobResultIdempotencyConflictError extends Error {
  readonly code = "JOB_RESULT_IDEMPOTENCY_CONFLICT";
  constructor() {
    super("The local sequence is already bound to different result metadata.");
    this.name = "JobResultIdempotencyConflictError";
  }
}

export class PrivateArtifactUploadDeniedError extends Error {
  readonly code = "PRIVATE_ARTIFACT_UPLOAD_DENIED";
  constructor() {
    super("This private Job did not authorize a cloud Artifact upload.");
    this.name = "PrivateArtifactUploadDeniedError";
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new JobResultValidationError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new JobResultValidationError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function boundedText(value: string, name: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new JobResultValidationError(`${name} must contain 1 to ${maximum} characters.`);
  }
  return normalized;
}

function optionalText(value: string | null, name: string, maximum: number): string | null {
  return value === null ? null : boundedText(value, name, maximum);
}

function contentHash(value: string, name: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new JobResultValidationError(`${name} must be a canonical 32-byte base64url value.`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    throw new JobResultValidationError(`${name} must be a canonical 32-byte base64url value.`);
  }
  return decoded;
}

function resultUsage(value: Readonly<Record<string, number>>): Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new JobResultValidationError("usage must be an object of non-negative finite numbers.");
  }
  const entries = Object.entries(value);
  if (entries.length > 32) {
    throw new JobResultValidationError("usage cannot contain more than 32 metrics.");
  }
  for (const [key, amount] of entries) {
    if (key.trim().length === 0 || key.length > 64 || !Number.isFinite(amount) || amount < 0) {
      throw new JobResultValidationError("usage must contain bounded keys and non-negative finite numbers.");
    }
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function payloadHash(value: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

function eventFromRow(row: JobEventRow): JobEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    jobId: row.job_id,
    leaseId: row.lease_id,
    workerId: row.worker_id,
    leaseGeneration: Number(row.lease_generation),
    localSequence: Number(row.local_sequence),
    sequence: Number(row.sequence),
    eventType: row.event_type,
    pageStatus: row.page_status,
    errorCode: row.error_code,
    provider: row.provider,
    byteCount: Number(row.byte_count),
    durationMs: Number(row.duration_ms),
    contentHash: row.content_hash?.toString("base64url") ?? null,
    usage: row.usage,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
}

function artifactFromRow(row: ArtifactMetadataRow): ArtifactMetadata {
  return {
    id: row.id,
    projectId: row.project_id,
    jobId: row.job_id,
    version: row.version,
    contentHash: row.content_hash.toString("base64url"),
    byteCount: Number(row.byte_count),
    mediaType: row.media_type,
    storage: row.storage_kind,
    objectKey: row.object_key,
    createdAt: row.created_at,
  };
}

function publicationFromRows(
  row: JobPublicationRow,
  artifact: ArtifactMetadataRow,
): JobPublication {
  return {
    id: row.id,
    projectId: row.project_id,
    jobId: row.job_id,
    leaseId: row.lease_id,
    workerId: row.worker_id,
    leaseGeneration: Number(row.lease_generation),
    localSequence: Number(row.local_sequence),
    sequence: Number(row.sequence),
    completeness: row.result_completeness,
    recordedAt: row.recorded_at,
    artifact: artifactFromRow(artifact),
  };
}

function artifactFromExisting(row: ExistingPublicationRow): ArtifactMetadataRow {
  return {
    id: row.artifact_id,
    project_id: row.project_id,
    job_id: row.job_id,
    version: row.artifact_version,
    content_hash: row.artifact_content_hash,
    byte_count: row.artifact_byte_count,
    media_type: row.artifact_media_type,
    storage_kind: row.artifact_storage_kind,
    object_key: row.artifact_object_key,
    created_at: row.artifact_created_at,
  };
}

export class JobResultService {
  constructor(private readonly database: ControlPlaneDatabase) {}

  async appendEvent(
    identity: AuthenticatedWorker,
    leaseId: string,
    leaseGeneration: number,
    input: JobEventInput,
  ): Promise<JobEvent> {
    const normalized = this.validateEvent(leaseId, leaseGeneration, input);
    const hash = payloadHash(normalized);
    return this.database.transaction(async (transaction) => {
      await this.requireActiveWorkerSession(transaction, identity);
      const lease = await this.lockSubmissionLease(
        transaction, identity, leaseId, leaseGeneration,
      );
      const existing = await transaction.query<JobEventRow>(`
        SELECT * FROM job_events
        WHERE lease_id = $1 AND local_sequence = $2 AND project_id = $3
        LIMIT 1
      `, [leaseId, normalized.localSequence, identity.projectId]);
      if (existing.rows[0] !== undefined) {
        if (!existing.rows[0].payload_hash.equals(hash)) {
          throw new JobResultIdempotencyConflictError();
        }
        return eventFromRow(existing.rows[0]);
      }
      const next = await transaction.query<{ sequence: number | string }>(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM job_events WHERE job_id = $1 AND project_id = $2
      `, [lease.job_id, identity.projectId]);
      const sequence = Number(next.rows[0]?.sequence ?? 1);
      const inserted = await transaction.query<JobEventRow>(`
        INSERT INTO job_events(
          id, project_id, job_id, lease_id, worker_id, lease_generation,
          local_sequence, sequence, payload_hash, event_type, page_status,
          error_code, provider, byte_count, duration_ms, content_hash, usage, occurred_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16, $17::jsonb, $18
        ) RETURNING *
      `, [
        randomUUID(), identity.projectId, lease.job_id, leaseId, identity.workerId,
        leaseGeneration, normalized.localSequence, sequence, hash, normalized.eventType,
        normalized.pageStatus, normalized.errorCode, normalized.provider, normalized.byteCount,
        normalized.durationMs, normalized.contentHash, JSON.stringify(normalized.usage),
        normalized.occurredAt,
      ]);
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("The Job event insert returned no row.");
      return eventFromRow(row);
    });
  }

  async publishResult(
    identity: AuthenticatedWorker,
    leaseId: string,
    leaseGeneration: number,
    input: PublishJobResultInput,
  ): Promise<JobPublication> {
    const normalized = this.validatePublication(leaseId, leaseGeneration, input);
    const hash = payloadHash(normalized);
    return this.database.transaction(async (transaction) => {
      await this.requireActiveWorkerSession(transaction, identity);
      const lease = await this.lockSubmissionLease(
        transaction, identity, leaseId, leaseGeneration,
      );
      if (normalized.storage === "cloud_object" && lease.data_class !== "public" &&
          !lease.upload_private_artifact) {
        throw new PrivateArtifactUploadDeniedError();
      }
      const existing = await transaction.query<ExistingPublicationRow>(`
        SELECT job_publications.*,
          artifact_metadata.id AS artifact_id,
          artifact_metadata.version AS artifact_version,
          artifact_metadata.content_hash AS artifact_content_hash,
          artifact_metadata.byte_count AS artifact_byte_count,
          artifact_metadata.media_type AS artifact_media_type,
          artifact_metadata.storage_kind AS artifact_storage_kind,
          artifact_metadata.object_key AS artifact_object_key,
          artifact_metadata.created_at AS artifact_created_at
        FROM job_publications
        INNER JOIN artifact_metadata ON artifact_metadata.id = job_publications.artifact_id
          AND artifact_metadata.project_id = job_publications.project_id
          AND artifact_metadata.job_id = job_publications.job_id
        WHERE job_publications.lease_id = $1 AND job_publications.local_sequence = $2
          AND job_publications.project_id = $3
        LIMIT 1
      `, [leaseId, normalized.localSequence, identity.projectId]);
      if (existing.rows[0] !== undefined) {
        if (!existing.rows[0].publication_hash.equals(hash)) {
          throw new JobResultIdempotencyConflictError();
        }
        return publicationFromRows(existing.rows[0], artifactFromExisting(existing.rows[0]));
      }
      const next = await transaction.query<{ sequence: number | string }>(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM job_publications WHERE job_id = $1 AND project_id = $2
      `, [lease.job_id, identity.projectId]);
      const sequence = Number(next.rows[0]?.sequence ?? 1);
      const artifactId = randomUUID();
      const version = 1;
      const objectKey = normalized.storage === "cloud_object"
        ? `organization/${lease.organization_id}/project/${identity.projectId}/artifact/${artifactId}/${version}`
        : null;
      const artifactResult = await transaction.query<ArtifactMetadataRow>(`
        INSERT INTO artifact_metadata(
          id, project_id, job_id, version, content_hash, byte_count,
          media_type, storage_kind, object_key
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `, [
        artifactId, identity.projectId, lease.job_id, version, normalized.contentHash,
        normalized.byteCount, normalized.mediaType, normalized.storage, objectKey,
      ]);
      const artifact = artifactResult.rows[0];
      if (artifact === undefined) throw new Error("The Artifact metadata insert returned no row.");
      const publicationResult = await transaction.query<JobPublicationRow>(`
        INSERT INTO job_publications(
          id, project_id, job_id, lease_id, worker_id, lease_generation,
          local_sequence, sequence, publication_hash, artifact_id, result_completeness
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
      `, [
        randomUUID(), identity.projectId, lease.job_id, leaseId, identity.workerId,
        leaseGeneration, normalized.localSequence, sequence, hash, artifactId,
        normalized.completeness,
      ]);
      const publication = publicationResult.rows[0];
      if (publication === undefined) throw new Error("The Job publication insert returned no row.");
      return publicationFromRows(publication, artifact);
    });
  }

  async listPublications(
    scope: Readonly<{ projectId: string }>,
    jobId: string,
    input: Readonly<{ afterSequence: number | null; limit: number }>,
  ): Promise<JobPublicationPage | null> {
    boundedText(jobId, "jobId", 128);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new JobResultValidationError("limit must be an integer from 1 to 100.");
    }
    if (input.afterSequence !== null) positiveInteger(input.afterSequence, "afterSequence");
    return this.database.transaction(async (transaction) => {
      const existing = await transaction.query<IdRow>(`
        SELECT id FROM jobs WHERE id = $1 AND project_id = $2 LIMIT 1
      `, [jobId, scope.projectId]);
      if (existing.rows[0] === undefined) return null;
      const result = await transaction.query<ExistingPublicationRow>(`
        SELECT job_publications.*,
          artifact_metadata.id AS artifact_id,
          artifact_metadata.version AS artifact_version,
          artifact_metadata.content_hash AS artifact_content_hash,
          artifact_metadata.byte_count AS artifact_byte_count,
          artifact_metadata.media_type AS artifact_media_type,
          artifact_metadata.storage_kind AS artifact_storage_kind,
          artifact_metadata.object_key AS artifact_object_key,
          artifact_metadata.created_at AS artifact_created_at
        FROM job_publications
        INNER JOIN artifact_metadata ON artifact_metadata.id = job_publications.artifact_id
          AND artifact_metadata.project_id = job_publications.project_id
          AND artifact_metadata.job_id = job_publications.job_id
        WHERE job_publications.project_id = $1 AND job_publications.job_id = $2
          AND ($3::bigint IS NULL OR job_publications.sequence > $3)
        ORDER BY job_publications.sequence LIMIT $4
      `, [scope.projectId, jobId, input.afterSequence, input.limit + 1]);
      const hasMore = result.rows.length > input.limit;
      const items = result.rows.slice(0, input.limit).map((row) =>
        publicationFromRows(row, artifactFromExisting(row))
      );
      return Object.freeze({
        items: Object.freeze(items), hasMore, nextSequence: items.at(-1)?.sequence ?? null,
      });
    });
  }

  private validateEvent(
    leaseId: string,
    leaseGeneration: number,
    input: JobEventInput,
  ): Readonly<{
    localSequence: number;
    eventType: string;
    pageStatus: number | null;
    errorCode: string | null;
    provider: string | null;
    byteCount: number;
    durationMs: number;
    contentHash: Buffer | null;
    usage: Record<string, number>;
    occurredAt: string;
  }> {
    boundedText(leaseId, "leaseId", 128);
    positiveInteger(leaseGeneration, "leaseGeneration");
    if (input.pageStatus !== null &&
        (!Number.isInteger(input.pageStatus) || input.pageStatus < 100 || input.pageStatus > 599)) {
      throw new JobResultValidationError("pageStatus must be null or an HTTP status from 100 to 599.");
    }
    if (!(input.occurredAt instanceof Date) || !Number.isFinite(input.occurredAt.getTime())) {
      throw new JobResultValidationError("occurredAt must be a valid Date.");
    }
    return {
      localSequence: positiveInteger(input.localSequence, "localSequence"),
      eventType: boundedText(input.eventType, "eventType", 64),
      pageStatus: input.pageStatus,
      errorCode: optionalText(input.errorCode, "errorCode", 128),
      provider: optionalText(input.provider, "provider", 128),
      byteCount: nonnegativeInteger(input.byteCount, "byteCount"),
      durationMs: nonnegativeInteger(input.durationMs, "durationMs"),
      contentHash: input.contentHash === null ? null : contentHash(input.contentHash, "contentHash"),
      usage: resultUsage(input.usage),
      occurredAt: input.occurredAt.toISOString(),
    };
  }

  private validatePublication(
    leaseId: string,
    leaseGeneration: number,
    input: PublishJobResultInput,
  ): Readonly<{
    localSequence: number;
    contentHash: Buffer;
    byteCount: number;
    mediaType: string;
    completeness: "complete" | "partial";
    storage: "worker_local" | "cloud_object";
  }> {
    boundedText(leaseId, "leaseId", 128);
    positiveInteger(leaseGeneration, "leaseGeneration");
    if (input.completeness !== "complete" && input.completeness !== "partial") {
      throw new JobResultValidationError("completeness must be complete or partial.");
    }
    if (input.storage !== "worker_local" && input.storage !== "cloud_object") {
      throw new JobResultValidationError("storage must be worker_local or cloud_object.");
    }
    return {
      localSequence: positiveInteger(input.localSequence, "localSequence"),
      contentHash: contentHash(input.contentHash, "contentHash"),
      byteCount: nonnegativeInteger(input.byteCount, "byteCount"),
      mediaType: boundedText(input.mediaType, "mediaType", 255),
      completeness: input.completeness,
      storage: input.storage,
    };
  }

  private async requireActiveWorkerSession(
    transaction: ControlPlaneQuery,
    identity: AuthenticatedWorker,
  ): Promise<void> {
    const active = await transaction.query<{ id: string }>(`
      SELECT worker_sessions.id
      FROM worker_sessions
      INNER JOIN workers ON workers.id = worker_sessions.worker_id
        AND workers.project_id = worker_sessions.project_id
      INNER JOIN worker_public_keys ON worker_public_keys.id = worker_sessions.public_key_id
        AND worker_public_keys.worker_id = worker_sessions.worker_id
        AND worker_public_keys.project_id = worker_sessions.project_id
      WHERE worker_sessions.id = $1 AND worker_sessions.worker_id = $2
        AND worker_sessions.project_id = $3 AND worker_sessions.capability_hash = $4
        AND workers.capability_hash = $4 AND worker_sessions.revoked_at IS NULL
        AND worker_sessions.expires_at > CURRENT_TIMESTAMP AND workers.status = 'active'
        AND worker_public_keys.revoked_at IS NULL
      FOR SHARE OF worker_sessions, workers, worker_public_keys
    `, [
      identity.sessionId,
      identity.workerId,
      identity.projectId,
      Buffer.from(identity.capabilityHash, "base64url"),
    ]);
    if (active.rows[0] === undefined) throw new JobResultWorkerAccessDeniedError();
  }

  private async lockSubmissionLease(
    transaction: ControlPlaneQuery,
    identity: AuthenticatedWorker,
    leaseId: string,
    leaseGeneration: number,
  ): Promise<SubmissionLeaseRow> {
    const locked = await transaction.query<{ job_id: string }>(`
      SELECT job_id FROM job_leases
      WHERE id = $1 AND worker_id = $2 AND project_id = $3 AND generation = $4
        AND status = 'active'
      FOR UPDATE
    `, [leaseId, identity.workerId, identity.projectId, leaseGeneration]);
    const jobId = locked.rows[0]?.job_id;
    if (jobId === undefined) throw new JobResultLeaseFencedError();
    const result = await transaction.query<SubmissionLeaseRow>(`
      SELECT jobs.id AS job_id, projects.organization_id, jobs.data_class,
        jobs.upload_private_artifact
      FROM job_leases
      INNER JOIN jobs ON jobs.id = job_leases.job_id
        AND jobs.project_id = job_leases.project_id
      INNER JOIN projects ON projects.id = jobs.project_id
      WHERE jobs.id = $1 AND jobs.project_id = $2 AND job_leases.id = $3
        AND job_leases.heartbeat_deadline > clock_timestamp()
        AND job_leases.lease_deadline > clock_timestamp() AND jobs.status = 'running'
      FOR UPDATE OF jobs
    `, [jobId, identity.projectId, leaseId]);
    const lease = result.rows[0];
    if (lease === undefined) throw new JobResultLeaseFencedError();
    return lease;
  }
}

export type AuditActorType = "user" | "api_key" | "worker";
export type AuditOutcome = "succeeded" | "failed";
export type AuditContext = Readonly<{ correlationId: string }>;
export type AuditEvent = Readonly<{
  id: string;
  organizationId: string;
  projectId: string;
  actorType: AuditActorType;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  outcome: AuditOutcome;
  correlationId: string;
  occurredAt: Date;
}>;
export type RecordAuditEventInput = Readonly<{
  organizationId: string;
  projectId: string;
  actorType: AuditActorType;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  outcome: AuditOutcome;
  correlationId: string;
}>;
export type AuditCursor = Readonly<{ occurredAt: Date; id: string }>;

type AuditEventRow = {
  id: string;
  organization_id: string;
  project_id: string;
  actor_type: AuditActorType;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  outcome: AuditOutcome;
  correlation_id: string;
  occurred_at: Date;
};

export class AuditAccessDeniedError extends Error {
  readonly code = "AUDIT_ACCESS_DENIED";
  constructor() {
    super("The authenticated subject cannot read this Project audit log.");
    this.name = "AuditAccessDeniedError";
  }
}

function auditText(value: string, name: string, maximumLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new Error(`${name} must contain between 1 and ${maximumLength} characters.`);
  }
  return normalized;
}

function auditEventFromRow(row: AuditEventRow): AuditEvent {
  return Object.freeze({
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    outcome: row.outcome,
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at,
  });
}

export async function recordAuditEvent(
  transaction: ControlPlaneQuery,
  input: RecordAuditEventInput,
): Promise<void> {
  const organizationId = auditText(input.organizationId, "input.organizationId", 200);
  const projectId = auditText(input.projectId, "input.projectId", 200);
  const actorId = auditText(input.actorId, "input.actorId", 200);
  const action = auditText(input.action, "input.action", 128);
  const targetType = auditText(input.targetType, "input.targetType", 128);
  const targetId = auditText(input.targetId, "input.targetId", 200);
  const correlationId = auditText(input.correlationId, "input.correlationId", 200);
  const result = await transaction.query<{ id: string }>(`
    INSERT INTO audit_events(
      id, organization_id, project_id, actor_type, actor_id, action,
      target_type, target_id, outcome, correlation_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING id
  `, [
    randomUUID(), organizationId, projectId, input.actorType, actorId, action,
    targetType, targetId, input.outcome, correlationId,
  ]);
  if (result.rows[0] === undefined) throw new Error("The audit event insert returned no record.");
}

export async function listProjectAuditEvents(
  database: ControlPlaneDatabase,
  scope: ProjectScope | AuthenticatedProjectApiKey,
  input: Readonly<{ limit: number; before: AuditCursor | null }>,
): Promise<readonly AuditEvent[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 101) {
    throw new Error("input.limit must be an integer from 1 to 101.");
  }
  if (input.before !== null && !Number.isFinite(input.before.occurredAt.getTime())) {
    throw new Error("input.before.occurredAt must be a valid date.");
  }
  return database.transaction(async (transaction) => {
    if (!("apiKeyId" in scope)) {
      const authorization = await transaction.query<{ role: string }>(`
      SELECT role FROM organization_memberships
      WHERE organization_id = $1 AND user_id = $2 AND role IN ('owner', 'admin')
      FOR SHARE
    `, [scope.organizationId, scope.userId]);
      if (authorization.rows[0] === undefined) throw new AuditAccessDeniedError();
    }
    const result = await transaction.query<AuditEventRow>(`
      SELECT id, organization_id, project_id, actor_type, actor_id, action,
        target_type, target_id, outcome, correlation_id, occurred_at
      FROM audit_events
      WHERE project_id = $1 AND organization_id = $2
        AND ($3::timestamptz IS NULL OR (occurred_at, id) < ($3, $4::uuid))
      ORDER BY occurred_at DESC, id DESC LIMIT $5
    `, [scope.projectId, scope.organizationId, input.before?.occurredAt ?? null,
      input.before?.id ?? null, input.limit]);
    return Object.freeze(result.rows.map(auditEventFromRow));
  });
}
