import { randomUUID } from "node:crypto";
import { setTimeout as waitForTimeout } from "node:timers/promises";

import { z, ZodError } from "zod";

import {
  WorkerAuthenticationError,
  type AuthenticatedWorker,
  type WorkerIdentityService,
} from "./api-key-service.js";
import type {
  ControlPlaneDatabase,
  ControlPlaneQuery,
  OrganizationRole,
  ProjectRecord,
  ProjectScope,
} from "./project-scope.js";
import {
  JobTerminalValidationError,
  JobWorkerAccessDeniedError,
  LeaseFencedError,
  type ControlPlaneJob,
  type ControlPlaneJobService,
  type JobLease,
} from "./project-scope.js";
import {
  type AuditContext,
  authorizeOrganizationWrite,
  JobResultIdempotencyConflictError,
  JobResultLeaseFencedError,
  JobResultValidationError,
  JobResultWorkerAccessDeniedError,
  type JobEvent,
  type JobResultService,
  type JobPublication,
  OrganizationAccessDeniedError,
  PrivateArtifactUploadDeniedError,
  recordAuditEvent,
} from "./organization-authorization.js";
import {
  ArtifactStorageDisabledError,
  ArtifactUploadVerificationError,
  type ArtifactStorageService,
} from "./artifact-storage.js";
import { workerRouteDefinitions } from "./router-contract.js";

export { OrganizationAccessDeniedError } from "./organization-authorization.js";

export type OrganizationMembership = Readonly<{
  organizationId: string;
  userId: string;
  role: OrganizationRole;
}>;

export type AddOrganizationMemberInput = Readonly<{
  userId: string;
  role: OrganizationRole;
}>;

export type CreateProjectInput = Readonly<{
  id: string;
  slug: string;
  name: string;
}>;

type RoleRow = { role: OrganizationRole };
type IdRow = { id: string };
type OwnerCountRow = { owner_count: string | number };
type MembershipRow = {
  organization_id: string;
  user_id: string;
  role: OrganizationRole;
};
type ProjectRow = {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
};

export class OrganizationMemberNotFoundError extends Error {
  readonly code = "ORGANIZATION_MEMBER_NOT_FOUND";

  constructor() {
    super("The organization member does not exist.");
    this.name = "OrganizationMemberNotFoundError";
  }
}

export class OrganizationMembershipConflictError extends Error {
  readonly code = "ORGANIZATION_MEMBERSHIP_CONFLICT";

  constructor() {
    super("The user is already a member of this organization.");
    this.name = "OrganizationMembershipConflictError";
  }
}

export class LastOrganizationOwnerError extends Error {
  readonly code = "LAST_ORGANIZATION_OWNER";

  constructor() {
    super("An organization must retain at least one owner.");
    this.name = "LastOrganizationOwnerError";
  }
}

export class ProjectSlugConflictError extends Error {
  readonly code = "PROJECT_SLUG_CONFLICT";

  constructor() {
    super("A project with this slug already exists in the organization.");
    this.name = "ProjectSlugConflictError";
  }
}

export class UserNotFoundError extends Error {
  readonly code = "USER_NOT_FOUND";

  constructor() {
    super("The user does not exist.");
    this.name = "UserNotFoundError";
  }
}

function requireControlPlaneValue(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
}

function membershipFromRow(row: MembershipRow): OrganizationMembership {
  return {
    organizationId: row.organization_id,
    userId: row.user_id,
    role: row.role,
  };
}

function projectFromRow(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    slug: row.slug,
    name: row.name,
  };
}

async function recordManagementAudit(
  transaction: ControlPlaneQuery,
  scope: ProjectScope,
  context: AuditContext,
  action: string,
  targetType: string,
  targetId: string,
  projectId = scope.projectId,
): Promise<void> {
  await recordAuditEvent(transaction, {
    organizationId: scope.organizationId,
    projectId,
    actorType: "user",
    actorId: scope.userId,
    action,
    targetType,
    targetId,
    outcome: "succeeded",
    correlationId: context.correlationId,
  });
}

async function requireAnotherOwnerWhenChangingOwner(
  transaction: ControlPlaneQuery,
  organizationId: string,
): Promise<void> {
  const result = await transaction.query<OwnerCountRow>(`
    SELECT count(*) AS owner_count
    FROM organization_memberships
    WHERE organization_id = $1 AND role = 'owner'
  `, [organizationId]);
  const ownerCount = Number(result.rows[0]?.owner_count ?? 0);
  if (!Number.isSafeInteger(ownerCount) || ownerCount <= 1) {
    throw new LastOrganizationOwnerError();
  }
}

export async function addOrganizationMember(
  database: ControlPlaneDatabase,
  scope: ProjectScope,
  input: AddOrganizationMemberInput,
  auditContext: AuditContext,
): Promise<OrganizationMembership> {
  requireControlPlaneValue(input.userId, "input.userId");
  return database.transaction(async (transaction) => {
    await authorizeOrganizationWrite(transaction, scope, ["owner"]);

    const user = await transaction.query<IdRow>(`
      SELECT id FROM users WHERE id = $1 LIMIT 1
    `, [input.userId]);
    if (user.rows[0] === undefined) {
      throw new UserNotFoundError();
    }

    const result = await transaction.query<MembershipRow>(`
      INSERT INTO organization_memberships(organization_id, user_id, role)
      VALUES ($1, $2, $3)
      ON CONFLICT (organization_id, user_id) DO NOTHING
      RETURNING organization_id, user_id, role
    `, [scope.organizationId, input.userId, input.role]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new OrganizationMembershipConflictError();
    }
    await recordManagementAudit(
      transaction, scope, auditContext, "member.added", "organization_membership", row.user_id,
    );
    return membershipFromRow(row);
  });
}

export async function changeOrganizationMemberRole(
  database: ControlPlaneDatabase,
  scope: ProjectScope,
  userId: string,
  role: OrganizationRole,
  auditContext: AuditContext,
): Promise<OrganizationMembership> {
  requireControlPlaneValue(userId, "userId");
  return database.transaction(async (transaction) => {
    await authorizeOrganizationWrite(transaction, scope, ["owner"]);

    const existing = await transaction.query<RoleRow>(`
      SELECT role
      FROM organization_memberships
      WHERE organization_id = $1 AND user_id = $2
      LIMIT 1
    `, [scope.organizationId, userId]);
    const currentRole = existing.rows[0]?.role;
    if (currentRole === undefined) {
      throw new OrganizationMemberNotFoundError();
    }
    if (currentRole === "owner" && role !== "owner") {
      await requireAnotherOwnerWhenChangingOwner(transaction, scope.organizationId);
    }

    const result = await transaction.query<MembershipRow>(`
      UPDATE organization_memberships
      SET role = $3, updated_at = CURRENT_TIMESTAMP
      WHERE organization_id = $1 AND user_id = $2
      RETURNING organization_id, user_id, role
    `, [scope.organizationId, userId, role]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new OrganizationMemberNotFoundError();
    }
    await recordManagementAudit(
      transaction, scope, auditContext, "member.role_changed", "organization_membership", row.user_id,
    );
    return membershipFromRow(row);
  });
}

export async function removeOrganizationMember(
  database: ControlPlaneDatabase,
  scope: ProjectScope,
  userId: string,
  auditContext: AuditContext,
): Promise<OrganizationMembership> {
  requireControlPlaneValue(userId, "userId");
  return database.transaction(async (transaction) => {
    await authorizeOrganizationWrite(transaction, scope, ["owner"]);

    const existing = await transaction.query<RoleRow>(`
      SELECT role
      FROM organization_memberships
      WHERE organization_id = $1 AND user_id = $2
      LIMIT 1
    `, [scope.organizationId, userId]);
    const currentRole = existing.rows[0]?.role;
    if (currentRole === undefined) {
      throw new OrganizationMemberNotFoundError();
    }
    if (currentRole === "owner") {
      await requireAnotherOwnerWhenChangingOwner(transaction, scope.organizationId);
    }

    const result = await transaction.query<MembershipRow>(`
      DELETE FROM organization_memberships
      WHERE organization_id = $1 AND user_id = $2
      RETURNING organization_id, user_id, role
    `, [scope.organizationId, userId]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new OrganizationMemberNotFoundError();
    }
    await recordManagementAudit(
      transaction, scope, auditContext, "member.removed", "organization_membership", row.user_id,
    );
    return membershipFromRow(row);
  });
}

export async function createProject(
  database: ControlPlaneDatabase,
  scope: ProjectScope,
  input: CreateProjectInput,
  auditContext: AuditContext,
): Promise<ProjectRecord> {
  requireControlPlaneValue(input.id, "input.id");
  requireControlPlaneValue(input.slug, "input.slug");
  requireControlPlaneValue(input.name, "input.name");
  return database.transaction(async (transaction) => {
    await authorizeOrganizationWrite(transaction, scope, ["owner", "admin"]);

    const result = await transaction.query<ProjectRow>(`
      INSERT INTO projects(id, organization_id, slug, name)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (organization_id, slug) DO NOTHING
      RETURNING id, organization_id, slug, name
    `, [input.id, scope.organizationId, input.slug, input.name]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ProjectSlugConflictError();
    }
    await recordManagementAudit(
      transaction, scope, auditContext, "project.created", "project", row.id, row.id,
    );
    return projectFromRow(row);
  });
}

export type WorkerHttpRequest = Readonly<{
  method: string;
  path: string;
  query?: string;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: unknown;
  /** Exact JSON body bytes, for routes that verify a signature over the payload. */
  rawBody?: Buffer;
  signal?: AbortSignal;
}>;

export type WorkerHttpResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string | string[]>>;
  body: unknown | null;
}>;

type WorkerHttpServices = Readonly<{
  identity: Pick<WorkerIdentityService, "verifySession">;
  jobs: Pick<ControlPlaneJobService, "claimNext" | "heartbeat" | "complete">;
  results: Pick<JobResultService, "appendEvent" | "publishResult">;
  artifacts?: Pick<ArtifactStorageService, "requestUpload" | "confirmUpload">;
}>;

type WorkerHttpDependencies = Readonly<{
  now?: () => Date;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  requestId?: () => string;
}>;

type WorkerRoute =
  | Readonly<{ kind: "claim"; identifier: string; method: "POST" }>
  | Readonly<{ kind: "heartbeat"; identifier: string; method: "PATCH" }>
  | Readonly<{ kind: "event"; identifier: string; method: "POST" }>
  | Readonly<{ kind: "publication"; identifier: string; method: "POST" }>
  | Readonly<{ kind: "complete"; identifier: string; method: "POST" }>
  | Readonly<{ kind: "artifact-upload" | "artifact-confirm"; identifier: string; method: "POST" }>;

type WorkerProblem = Readonly<{
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  request_id: string;
  retryable: boolean;
  errors?: readonly Readonly<{ field: string; message: string }>[];
}>;

class WorkerPathIdentityMismatchError extends Error {
  readonly code = "WORKER_PATH_IDENTITY_MISMATCH";
  constructor() {
    super("The Worker path does not match the authenticated Worker identity.");
    this.name = "WorkerPathIdentityMismatchError";
  }
}

const generationSchema = z.number().int().positive().safe();
const localSequenceSchema = z.number().int().positive().safe();
const contentHashSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const claimBodySchema = z.object({
  wait_ms: z.number().int().min(0).max(30_000).optional().default(0),
}).strict();
const heartbeatBodySchema = z.object({ generation: generationSchema }).strict();
const eventBodySchema = z.object({
  generation: generationSchema,
  local_sequence: localSequenceSchema,
  event_type: z.string().min(1).max(64),
  page_status: z.number().int().min(100).max(599).nullable(),
  error_code: z.string().min(1).max(128).nullable(),
  provider: z.string().min(1).max(128).nullable(),
  byte_count: z.number().int().nonnegative().safe(),
  duration_ms: z.number().int().nonnegative().safe(),
  content_hash: contentHashSchema.nullable(),
  usage: z.record(z.string(), z.number().finite().nonnegative()),
  occurred_at: z.string().datetime({ offset: true }),
}).strict();
const publicationBodySchema = z.object({
  generation: generationSchema,
  local_sequence: localSequenceSchema,
  content_hash: contentHashSchema,
  byte_count: z.number().int().nonnegative().safe(),
  media_type: z.string().min(1).max(255),
  completeness: z.enum(["complete", "partial"]),
  storage: z.enum(["worker_local", "cloud_object"]),
}).strict();
const artifactUploadBodySchema = z.object({ generation: generationSchema, artifact_id: z.uuid() }).strict();
const completeBodySchema = z.discriminatedUnion("status", [
  z.object({
    generation: generationSchema,
    status: z.literal("completed"),
    result_completeness: z.enum(["complete", "partial"]),
    error_code: z.null(),
  }).strict(),
  z.object({
    generation: generationSchema,
    status: z.literal("failed"),
    result_completeness: z.null(),
    error_code: z.string().trim().min(1).max(128),
  }).strict(),
]);

function matchWorkerRoute(path: string): WorkerRoute | null {
  for (const { pattern, kind, method } of workerRouteDefinitions) {
    const identifier = pattern.exec(path)?.[1];
    if (identifier !== undefined) return { kind, identifier, method } as WorkerRoute;
  }
  return null;
}

function workerHeader(
  headers: WorkerHttpRequest["headers"],
  name: string,
): string | null {
  const found = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
  return found.length === 1 && typeof found[0]?.[1] === "string" ? found[0][1] : null;
}

function workerBearerToken(headers: WorkerHttpRequest["headers"]): string {
  const authorization = workerHeader(headers, "authorization");
  if (authorization === null || authorization.length > 4103) throw new WorkerAuthenticationError();
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u);
  if (match?.[1] === undefined) throw new WorkerAuthenticationError();
  return match[1];
}

function isJsonRequest(headers: WorkerHttpRequest["headers"]): boolean {
  return workerHeader(headers, "content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json";
}

function wireLease(lease: JobLease): Record<string, unknown> {
  return {
    id: lease.id,
    job_id: lease.jobId,
    generation: lease.generation,
    heartbeat_deadline: lease.heartbeatDeadline.toISOString(),
    lease_deadline: lease.leaseDeadline.toISOString(),
  };
}

export function wireJob(job: ControlPlaneJob): Record<string, unknown> {
  return {
    id: job.id,
    type: job.type,
    input: job.input,
    data_class: job.dataClass,
    placement: { class: job.placement.class, pinned_worker_id: job.placement.pinnedWorkerId },
    required_capabilities: job.requiredCapabilities,
    budget: {
      deadline_ms: job.budget.deadlineMs,
      max_provider_attempts: job.budget.maxProviderAttempts,
      max_document_bytes: job.budget.maxDocumentBytes,
      max_browser_ms: job.budget.maxBrowserMs,
      max_browser_contexts: job.budget.maxBrowserContexts,
    },
    policy_version: job.policyVersion,
    upload_private_artifact: job.uploadPrivateArtifact,
    priority: job.priority,
    not_before: job.notBefore.toISOString(),
    deadline_at: job.deadlineAt.toISOString(),
    status: job.status,
    result_completeness: job.resultCompleteness,
    error_code: job.errorCode,
  };
}

function wireEvent(event: JobEvent): Record<string, unknown> {
  return {
    id: event.id,
    job_id: event.jobId,
    lease_id: event.leaseId,
    lease_generation: event.leaseGeneration,
    local_sequence: event.localSequence,
    sequence: event.sequence,
    event_type: event.eventType,
    page_status: event.pageStatus,
    error_code: event.errorCode,
    provider: event.provider,
    byte_count: event.byteCount,
    duration_ms: event.durationMs,
    content_hash: event.contentHash,
    usage: event.usage,
    occurred_at: event.occurredAt.toISOString(),
    recorded_at: event.recordedAt.toISOString(),
  };
}

export function wirePublication(publication: JobPublication): Record<string, unknown> {
  return {
    id: publication.id,
    job_id: publication.jobId,
    lease_id: publication.leaseId,
    lease_generation: publication.leaseGeneration,
    local_sequence: publication.localSequence,
    sequence: publication.sequence,
    completeness: publication.completeness,
    recorded_at: publication.recordedAt.toISOString(),
    artifact: {
      id: publication.artifact.id,
      version: publication.artifact.version,
      content_hash: publication.artifact.contentHash,
      byte_count: publication.artifact.byteCount,
      media_type: publication.artifact.mediaType,
      storage: publication.artifact.storage,
      object_key: publication.artifact.objectKey,
      created_at: publication.artifact.createdAt.toISOString(),
    },
  };
}

function workerResponse(status: number, requestId: string, body: unknown | null): WorkerHttpResponse {
  return {
    status,
    headers: Object.freeze({
      "x-request-id": requestId,
      ...(body === null ? {} : { "content-type": "application/json" }),
    }),
    body,
  };
}

function workerProblem(
  request: WorkerHttpRequest,
  requestId: string,
  status: number,
  code: string,
  title: string,
  detail: string,
  retryable: boolean,
  errors?: WorkerProblem["errors"],
): WorkerHttpResponse {
  const slug = code.toLowerCase().replaceAll("_", "-");
  const body: WorkerProblem = {
    type: `https://api.diaoyan.example/errors/${slug}`,
    title,
    status,
    detail,
    instance: request.path,
    code,
    request_id: requestId,
    retryable,
    ...(errors === undefined ? {} : { errors }),
  };
  return {
    status,
    headers: Object.freeze({
      "content-type": "application/problem+json",
      "x-request-id": requestId,
      ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
    }),
    body,
  };
}

export class WorkerHttpApi {
  private readonly now: () => Date;
  private readonly wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly requestId: () => string;

  constructor(
    private readonly services: WorkerHttpServices,
    dependencies: WorkerHttpDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.wait = dependencies.wait ?? ((milliseconds, signal) =>
      waitForTimeout(milliseconds, undefined, signal === undefined ? {} : { signal }));
    this.requestId = dependencies.requestId ?? randomUUID;
  }

  async handle(request: WorkerHttpRequest): Promise<WorkerHttpResponse> {
    const requestId = this.requestId();
    if ((request.query ?? "") !== "") {
      return workerProblem(request, requestId, 400, "QUERY_UNSUPPORTED", "Bad Request",
        "Worker API routes do not accept query parameters.", false);
    }
    const route = matchWorkerRoute(request.path);
    if (route === null) {
      return workerProblem(request, requestId, 404, "WORKER_ROUTE_NOT_FOUND", "Not Found",
        "The Worker API route does not exist.", false);
    }
    if (request.method.toUpperCase() !== route.method) {
      const response = workerProblem(request, requestId, 405, "WORKER_METHOD_NOT_ALLOWED",
        "Method Not Allowed", "The Worker API route does not accept this method.", false);
      return { ...response, headers: { ...response.headers, allow: route.method } };
    }

    try {
      const identity = await this.services.identity.verifySession(workerBearerToken(request.headers));
      if (!isJsonRequest(request.headers)) {
        return workerProblem(request, requestId, 415, "WORKER_MEDIA_TYPE_UNSUPPORTED",
          "Unsupported Media Type", "Worker requests must use application/json.", false);
      }
      return await this.dispatch(request, route, identity, requestId);
    } catch (error) {
      return this.errorResponse(request, requestId, error);
    }
  }

  private async dispatch(
    request: WorkerHttpRequest,
    route: WorkerRoute,
    identity: AuthenticatedWorker,
    requestId: string,
  ): Promise<WorkerHttpResponse> {
    if (route.kind === "claim") {
      if (route.identifier.toLowerCase() !== identity.workerId.toLowerCase()) {
        throw new WorkerPathIdentityMismatchError();
      }
      const { wait_ms: waitMs } = claimBodySchema.parse(request.body);
      const deadline = this.now().getTime() + waitMs;
      while (true) {
        request.signal?.throwIfAborted();
        const claimed = await this.services.jobs.claimNext(identity);
        if (claimed !== null) {
          return workerResponse(200, requestId, {
            request_id: requestId,
            job: wireJob(claimed.job),
            lease: wireLease(claimed.lease),
          });
        }
        const remaining = deadline - this.now().getTime();
        if (remaining <= 0) return workerResponse(204, requestId, null);
        await this.wait(Math.min(1_000, remaining), request.signal);
      }
    }
    if (route.kind === "heartbeat") {
      const body = heartbeatBodySchema.parse(request.body);
      const lease = await this.services.jobs.heartbeat(
        identity, route.identifier, body.generation,
      );
      return workerResponse(200, requestId, { request_id: requestId, lease: wireLease(lease) });
    }
    if (route.kind === "event") {
      const body = eventBodySchema.parse(request.body);
      const event = await this.services.results.appendEvent(
        identity,
        route.identifier,
        body.generation,
        {
          localSequence: body.local_sequence,
          eventType: body.event_type,
          pageStatus: body.page_status,
          errorCode: body.error_code,
          provider: body.provider,
          byteCount: body.byte_count,
          durationMs: body.duration_ms,
          contentHash: body.content_hash,
          usage: body.usage,
          occurredAt: new Date(body.occurred_at),
        },
      );
      return workerResponse(200, requestId, { request_id: requestId, event: wireEvent(event) });
    }
    if (route.kind === "publication") {
      const body = publicationBodySchema.parse(request.body);
      const publication = await this.services.results.publishResult(
        identity,
        route.identifier,
        body.generation,
        {
          localSequence: body.local_sequence,
          contentHash: body.content_hash,
          byteCount: body.byte_count,
          mediaType: body.media_type,
          completeness: body.completeness,
          storage: body.storage,
        },
      );
      return workerResponse(200, requestId, {
        request_id: requestId,
        publication: wirePublication(publication),
      });
    }
    if (route.kind === "artifact-upload" || route.kind === "artifact-confirm") {
      const body = artifactUploadBodySchema.parse(request.body);
      if (this.services.artifacts === undefined) throw new ArtifactStorageDisabledError();
      if (route.kind === "artifact-confirm") {
        const uploadedAt = await this.services.artifacts.confirmUpload(
          identity, route.identifier, body.generation, body.artifact_id,
        );
        return workerResponse(200, requestId, { request_id: requestId, uploaded_at: uploadedAt.toISOString() });
      }
      const upload = await this.services.artifacts.requestUpload(
        identity, route.identifier, body.generation, body.artifact_id,
      );
      return workerResponse(201, requestId, { request_id: requestId, upload: {
        url: upload.url, method: upload.method, headers: upload.headers, expires_at: upload.expiresAt.toISOString(),
      } });
    }
    const body = completeBodySchema.parse(request.body);
    const job = await this.services.jobs.complete(identity, route.identifier, body.generation, {
      status: body.status,
      resultCompleteness: body.result_completeness,
      errorCode: body.error_code,
    });
    return workerResponse(200, requestId, { request_id: requestId, job: wireJob(job) });
  }

  private errorResponse(
    request: WorkerHttpRequest,
    requestId: string,
    error: unknown,
  ): WorkerHttpResponse {
    if (error instanceof WorkerAuthenticationError ||
        error instanceof JobWorkerAccessDeniedError ||
        error instanceof JobResultWorkerAccessDeniedError) {
      return workerProblem(request, requestId, 401, "WORKER_AUTHENTICATION_FAILED",
        "Worker Authentication Failed", "The Worker Session is invalid or no longer active.", false);
    }
    if (error instanceof WorkerPathIdentityMismatchError) {
      return workerProblem(request, requestId, 403, error.code, "Worker Identity Mismatch",
        error.message, false);
    }
    if (error instanceof PrivateArtifactUploadDeniedError) {
      return workerProblem(request, requestId, 403, error.code, "Private Artifact Upload Denied",
        error.message, false);
    }
    if (error instanceof LeaseFencedError || error instanceof JobResultLeaseFencedError) {
      return workerProblem(request, requestId, 409, "JOB_LEASE_FENCED", "Job Lease Fenced",
        "The Job Lease is inactive, expired, or superseded.", false);
    }
    if (error instanceof ArtifactStorageDisabledError) {
      return workerProblem(request, requestId, 503, error.code, "Artifact Storage Disabled", error.message, false);
    }
    if (error instanceof ArtifactUploadVerificationError) {
      return workerProblem(request, requestId, 409, error.code, "Artifact Upload Unverified", error.message, true);
    }
    if (error instanceof JobResultIdempotencyConflictError) {
      return workerProblem(request, requestId, 409, error.code, "Idempotency Conflict",
        error.message, false);
    }
    if (error instanceof ZodError) {
      return workerProblem(
        request,
        requestId,
        422,
        "WORKER_REQUEST_INVALID",
        "Worker Request Invalid",
        "The Worker request body failed validation.",
        false,
        error.issues.map((issue) => ({
          field: issue.path.length === 0 ? "body" : issue.path.join("."),
          message: issue.message,
        })),
      );
    }
    if (error instanceof JobResultValidationError || error instanceof JobTerminalValidationError) {
      return workerProblem(request, requestId, 422, error.code, "Worker Request Invalid",
        error.message, false);
    }
    return workerProblem(request, requestId, 500, "INTERNAL_ERROR", "Internal Server Error",
      "The Worker request could not be completed.", true);
  }
}
