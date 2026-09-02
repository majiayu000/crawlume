import { createHash, randomUUID } from "node:crypto";

import type { AuthenticatedProjectApiKey, AuthenticatedWorker } from "./api-key-service.js";
import {
  parseControlPlaneJobCreation,
  type ControlPlaneJobRequest,
  type ControlPlaneJobType,
  type ControlPlaneRequiredCapabilities,
} from "./job-input.js";
import {
  type AuditContext,
  recordAuditEvent,
} from "./organization-authorization.js";
import { recoverExpiredJobLeases } from "./job-lease-recovery.js";

export { controlPlaneJobTypes } from "./job-input.js";
export type {
  ControlPlaneJobInput,
  ControlPlaneJobRequest,
  ControlPlaneJobType,
  ControlPlaneRequiredCapabilities,
} from "./job-input.js";

const projectScopeBrand: unique symbol = Symbol("ProjectScope");

export type OrganizationRole = "owner" | "admin" | "member";

export type AuthenticatedUser = Readonly<{
  userId: string;
}>;

export type ProjectScope = Readonly<{
  userId: string;
  projectId: string;
  organizationId: string;
  role: OrganizationRole;
  [projectScopeBrand]: true;
}>;

export type ProjectRecord = Readonly<{
  id: string;
  organizationId: string;
  slug: string;
  name: string;
}>;

type ProjectScopeRow = {
  project_id: string;
  organization_id: string;
  role: OrganizationRole;
};

type ProjectRow = {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
};

export interface ControlPlaneQuery {
  query<Row>(statement: string, parameters: readonly unknown[]): Promise<{ rows: Row[] }>;
}

export interface ControlPlaneDatabase extends ControlPlaneQuery {
  transaction<Result>(operation: (transaction: ControlPlaneQuery) => Promise<Result>): Promise<Result>;
}

export class ProjectAccessDeniedError extends Error {
  readonly code = "PROJECT_ACCESS_DENIED";

  constructor() {
    super("The authenticated subject cannot access this project.");
    this.name = "ProjectAccessDeniedError";
  }
}

function requireIdentifier(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
}

export async function resolveProjectScope(
  database: ControlPlaneQuery,
  subject: AuthenticatedUser,
  projectId: string,
): Promise<ProjectScope> {
  requireIdentifier(subject.userId, "subject.userId");
  requireIdentifier(projectId, "projectId");

  const result = await database.query<ProjectScopeRow>(`
    SELECT
      projects.id AS project_id,
      projects.organization_id,
      organization_memberships.role
    FROM projects
    INNER JOIN organization_memberships
      ON organization_memberships.organization_id = projects.organization_id
    WHERE projects.id = $1
      AND organization_memberships.user_id = $2
    LIMIT 1
  `, [projectId, subject.userId]);

  const row = result.rows[0];
  if (row === undefined) {
    throw new ProjectAccessDeniedError();
  }

  return Object.freeze({
    userId: subject.userId,
    projectId: row.project_id,
    organizationId: row.organization_id,
    role: row.role,
    [projectScopeBrand]: true as const,
  });
}

export async function getScopedProject(
  database: ControlPlaneQuery,
  scope: ProjectScope,
): Promise<ProjectRecord> {
  const result = await database.query<ProjectRow>(`
    SELECT id, organization_id, slug, name
    FROM projects
    WHERE id = $1 AND organization_id = $2
    LIMIT 1
  `, [scope.projectId, scope.organizationId]);

  const row = result.rows[0];
  if (row === undefined) {
    throw new ProjectAccessDeniedError();
  }

  return {
    id: row.id,
    organizationId: row.organization_id,
    slug: row.slug,
    name: row.name,
  };
}

export type JobDataClass = "public" | "authorized" | "intranet";
export type JobPlacementClass = "public" | "private";
export type JobStatus =
  | "accepted"
  | "queued"
  | "assigned"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";
export type JobResultCompleteness = "complete" | "partial";
export type JobBudget = Readonly<{
  deadlineMs: number;
  maxProviderAttempts: number;
  maxDocumentBytes: number;
  maxBrowserMs: number;
  maxBrowserContexts: number;
}>;
type ControlPlaneJobCreationEnvelope = Readonly<{
  dataClass: JobDataClass;
  placement: Readonly<{ class: JobPlacementClass; pinnedWorkerId: string | null }>;
  budget: JobBudget;
  policyVersion: string;
  uploadPrivateArtifact: boolean;
  priority?: number | undefined;
  notBefore?: Date | undefined;
}>;
export type CreateControlPlaneJobInput = ControlPlaneJobCreationEnvelope &
  ControlPlaneJobRequest & Readonly<{
    requiredCapabilities: ControlPlaneRequiredCapabilities;
  }>;
type ControlPlaneJobProjection = Readonly<{
  id: string;
  projectId: string;
  idempotencyKey: string;
  dataClass: JobDataClass;
  placement: Readonly<{ class: JobPlacementClass; pinnedWorkerId: string | null }>;
  requiredCapabilities: ControlPlaneRequiredCapabilities;
  budget: JobBudget;
  policyVersion: string;
  uploadPrivateArtifact: boolean;
  priority: number;
  notBefore: Date;
  deadlineAt: Date;
  envelopeHash: string;
  status: JobStatus;
  resultCompleteness: JobResultCompleteness | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}>;
export type ControlPlaneJob = ControlPlaneJobProjection & ControlPlaneJobRequest;
export type JobLease = Readonly<{
  id: string;
  jobId: string;
  workerId: string;
  projectId: string;
  generation: number;
  heartbeatDeadline: Date;
  leaseDeadline: Date;
}>;
export type ClaimedJob = Readonly<{ job: ControlPlaneJob; lease: JobLease }>;

type ControlPlaneJobRow = {
  id: string;
  project_id: string;
  idempotency_key: string;
  type: ControlPlaneJobType;
  input: Record<string, unknown>;
  data_class: JobDataClass;
  placement_class: JobPlacementClass;
  pinned_worker_id: string | null;
  required_capabilities: Record<string, unknown>;
  budget_deadline_ms: number | string;
  budget_max_provider_attempts: number;
  budget_max_document_bytes: number | string;
  budget_max_browser_ms: number | string;
  budget_max_browser_contexts: number;
  policy_version: string;
  upload_private_artifact: boolean;
  priority: number;
  not_before: Date;
  deadline_at: Date;
  envelope_hash: Buffer;
  status: JobStatus;
  result_completeness: JobResultCompleteness | null;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
};
type JobLeaseRow = {
  id: string;
  project_id: string;
  job_id: string;
  worker_id: string;
  generation: number | string;
  heartbeat_deadline: Date;
  lease_deadline: Date;
};

export class JobIdempotencyConflictError extends Error {
  readonly code = "JOB_IDEMPOTENCY_CONFLICT";
  constructor() {
    super("The idempotency key is already bound to a different Job request.");
    this.name = "JobIdempotencyConflictError";
  }
}

export class JobNotFoundError extends Error {
  readonly code = "JOB_NOT_FOUND";
  constructor() {
    super("The Job does not exist in this project.");
    this.name = "JobNotFoundError";
  }
}

export class JobTransitionError extends Error {
  readonly code = "JOB_TRANSITION_INVALID";
  constructor() {
    super("The requested Job state transition is not valid.");
    this.name = "JobTransitionError";
  }
}

export class JobWorkerAccessDeniedError extends Error {
  readonly code = "JOB_WORKER_ACCESS_DENIED";
  constructor() {
    super("The Worker session cannot access this Project Job queue.");
    this.name = "JobWorkerAccessDeniedError";
  }
}

export class LeaseFencedError extends Error {
  readonly code = "JOB_LEASE_FENCED";
  constructor() {
    super("The Job lease is expired, revoked, or superseded by a newer generation.");
    this.name = "LeaseFencedError";
  }
}

export class JobTerminalValidationError extends Error {
  readonly code = "JOB_TERMINAL_INVALID";
  constructor() {
    super("The Job terminal payload is inconsistent with its status.");
    this.name = "JobTerminalValidationError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Job JSON values must contain finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Job values must be valid JSON.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Job JSON objects must be plain objects.");
  }
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
  ).join(",")}}`;
}

function jobJsonObject(
  value: Readonly<Record<string, unknown>>,
  name: string,
  maximumBytes: number,
): { json: string; value: Readonly<Record<string, unknown>> } {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${name} must be a JSON object.`);
  }
  const json = canonicalJson(value);
  if (Buffer.byteLength(json) > maximumBytes) {
    throw new TypeError(`${name} exceeds its maximum encoded size.`);
  }
  return { json, value: Object.freeze(JSON.parse(json) as Record<string, unknown>) };
}

function jobHash(value: unknown): Buffer {
  return createHash("sha256").update(canonicalJson(value)).digest();
}

function requireJobInteger(
  value: number, name: string, allowZero = false, maximum = Number.MAX_SAFE_INTEGER,
): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > maximum) {
    throw new TypeError(`${name} must be a safe ${allowZero ? "non-negative" : "positive"} integer.`);
  }
}

function controlPlaneJob(row: ControlPlaneJobRow): ControlPlaneJob {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    idempotencyKey: row.idempotency_key,
    type: row.type,
    input: Object.freeze(row.input),
    dataClass: row.data_class,
    placement: Object.freeze({
      class: row.placement_class,
      pinnedWorkerId: row.pinned_worker_id,
    }),
    requiredCapabilities: Object.freeze(row.required_capabilities),
    budget: Object.freeze({
      deadlineMs: Number(row.budget_deadline_ms),
      maxProviderAttempts: row.budget_max_provider_attempts,
      maxDocumentBytes: Number(row.budget_max_document_bytes),
      maxBrowserMs: Number(row.budget_max_browser_ms),
      maxBrowserContexts: row.budget_max_browser_contexts,
    }),
    policyVersion: row.policy_version,
    uploadPrivateArtifact: row.upload_private_artifact,
    priority: row.priority,
    notBefore: row.not_before,
    deadlineAt: row.deadline_at,
    envelopeHash: row.envelope_hash.toString("base64url"),
    status: row.status,
    resultCompleteness: row.result_completeness,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }) as ControlPlaneJob;
}

function jobLease(row: JobLeaseRow): JobLease {
  const generation = Number(row.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("The database returned an invalid lease generation.");
  }
  return Object.freeze({
    id: row.id,
    jobId: row.job_id,
    workerId: row.worker_id,
    projectId: row.project_id,
    generation,
    heartbeatDeadline: row.heartbeat_deadline,
    leaseDeadline: row.lease_deadline,
  });
}

export class ControlPlaneJobService {
  private readonly now: () => Date;

  constructor(
    private readonly database: ControlPlaneDatabase,
    dependencies: Readonly<{ now?: () => Date }> = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async createJob(
    scope: ProjectScope | AuthenticatedProjectApiKey,
    idempotencyKey: string,
    input: CreateControlPlaneJobInput,
    auditContext: AuditContext,
  ): Promise<ControlPlaneJob> {
    const apiKeyId = "apiKeyId" in scope ? scope.apiKeyId : null;
    const createdByUserId = "apiKeyId" in scope ? scope.createdByUserId : scope.userId;
    const normalizedKey = idempotencyKey.trim();
    if (normalizedKey.length === 0 || normalizedKey.length > 200) {
      throw new TypeError("idempotencyKey must contain between 1 and 200 characters.");
    }
    const parsedCreation = parseControlPlaneJobCreation(
      input.type,
      input.input,
      input.requiredCapabilities,
    );
    if (!(input.dataClass === "public" || input.dataClass === "authorized" ||
      input.dataClass === "intranet")) {
      throw new TypeError("input.dataClass is not supported.");
    }
    if (!(input.placement.class === "public" || input.placement.class === "private")) {
      throw new TypeError("input.placement.class is not supported.");
    }
    const jobInput = jobJsonObject(parsedCreation.input, "input.input", 256 * 1_024);
    const capabilities = jobJsonObject(
      parsedCreation.requiredCapabilities,
      "input.requiredCapabilities",
      16 * 1_024,
    );
    requireJobInteger(input.budget.deadlineMs, "input.budget.deadlineMs", false, 86_400_000);
    requireJobInteger(
      input.budget.maxProviderAttempts, "input.budget.maxProviderAttempts", false, 1_000_000,
    );
    requireJobInteger(input.budget.maxDocumentBytes, "input.budget.maxDocumentBytes");
    requireJobInteger(input.budget.maxBrowserMs, "input.budget.maxBrowserMs", true, 86_400_000);
    requireJobInteger(
      input.budget.maxBrowserContexts, "input.budget.maxBrowserContexts", true, 100_000,
    );
    const policyVersion = input.policyVersion.trim();
    if (policyVersion.length === 0 || policyVersion.length > 256) {
      throw new TypeError("input.policyVersion must contain between 1 and 256 characters.");
    }
    const priority = input.priority ?? 0;
    if (!Number.isInteger(priority) || priority < -100 || priority > 100) {
      throw new TypeError("input.priority must be an integer between -100 and 100.");
    }
    if (input.dataClass !== "public" && input.placement.class !== "private") {
      throw new TypeError("Private data classifications require private placement.");
    }
    if (input.placement.pinnedWorkerId !== null && input.placement.class !== "private") {
      throw new TypeError("A pinned Worker requires private placement.");
    }
    if (input.placement.pinnedWorkerId !== null) {
      requireIdentifier(input.placement.pinnedWorkerId, "input.placement.pinnedWorkerId");
    }

    const now = this.now();
    const notBefore = input.notBefore ?? now;
    if (!(notBefore instanceof Date) || !Number.isFinite(notBefore.getTime()) || notBefore < now) {
      throw new TypeError("input.notBefore must be a valid date at or after creation.");
    }
    const deadlineAt = new Date(now.getTime() + input.budget.deadlineMs);
    if (!Number.isFinite(deadlineAt.getTime()) || deadlineAt <= notBefore) {
      throw new TypeError("The Job deadline must be after notBefore.");
    }

    const request = {
      type: parsedCreation.type,
      input: jobInput.value,
      dataClass: input.dataClass,
      placement: input.placement,
      requiredCapabilities: capabilities.value,
      budget: input.budget,
      policyVersion,
      uploadPrivateArtifact: input.uploadPrivateArtifact,
      priority,
      notBefore: input.notBefore?.toISOString() ?? null,
    };
    const requestHash = jobHash(request);
    const id = randomUUID();
    const envelopeHash = jobHash({
      id,
      projectId: scope.projectId,
      requestHash: requestHash.toString("base64url"),
      createdAt: now.toISOString(),
    });
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query<ControlPlaneJobRow>(`
      INSERT INTO jobs(
        id, project_id, idempotency_key, request_hash, created_by_user_id,
        type, input, data_class, placement_class, pinned_worker_id,
        required_capabilities, budget_deadline_ms, budget_max_provider_attempts,
        budget_max_document_bytes, budget_max_browser_ms, budget_max_browser_contexts,
        policy_version, upload_private_artifact, priority, not_before, deadline_at,
        envelope_hash, status, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10,
        $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
        $22, 'queued', $23, $23
      )
      ON CONFLICT (project_id, idempotency_key) DO UPDATE
        SET idempotency_key = EXCLUDED.idempotency_key
        WHERE jobs.request_hash = EXCLUDED.request_hash
      RETURNING *
    `, [
      id, scope.projectId, normalizedKey, requestHash, createdByUserId, parsedCreation.type,
      jobInput.json, input.dataClass, input.placement.class, input.placement.pinnedWorkerId,
      capabilities.json, input.budget.deadlineMs, input.budget.maxProviderAttempts,
      input.budget.maxDocumentBytes, input.budget.maxBrowserMs,
      input.budget.maxBrowserContexts, policyVersion, input.uploadPrivateArtifact,
      priority, notBefore, deadlineAt, envelopeHash, now,
    ]);
      const row = result.rows[0];
      if (row === undefined) throw new JobIdempotencyConflictError();
      if (row.id === id && input.dataClass !== "public") {
        await recordAuditEvent(transaction, {
          organizationId: scope.organizationId, projectId: scope.projectId,
          actorType: apiKeyId === null ? "user" : "api_key",
          actorId: apiKeyId ?? createdByUserId, action: "private_job.created",
          targetType: "job", targetId: row.id, outcome: "succeeded",
          correlationId: auditContext.correlationId,
        });
      }
      if (row.id === id && input.uploadPrivateArtifact) {
        await recordAuditEvent(transaction, {
          organizationId: scope.organizationId, projectId: scope.projectId,
          actorType: apiKeyId === null ? "user" : "api_key",
          actorId: apiKeyId ?? createdByUserId,
          action: "private_artifact_upload.approved", targetType: "job",
          targetId: row.id, outcome: "succeeded", correlationId: auditContext.correlationId,
        });
      }
      return controlPlaneJob(row);
    });
  }

  async getJob(scope: Pick<ProjectScope, "projectId">, jobId: string): Promise<ControlPlaneJob> {
    requireIdentifier(jobId, "jobId");
    const result = await this.database.query<ControlPlaneJobRow>(`
      SELECT * FROM jobs WHERE id = $1 AND project_id = $2 LIMIT 1
    `, [jobId, scope.projectId]);
    const row = result.rows[0];
    if (row === undefined) throw new JobNotFoundError();
    return controlPlaneJob(row);
  }

  async claimNext(identity: AuthenticatedWorker): Promise<ClaimedJob | null> {
    const now = this.now();
    return this.database.transaction(async (transaction) => {
      await this.requireActiveWorkerSession(transaction, identity);
      await recoverExpiredJobLeases(transaction, identity.projectId, now);

      const selected = await transaction.query<ControlPlaneJobRow>(`
        SELECT jobs.*
        FROM jobs
        INNER JOIN workers
          ON workers.id = $1 AND workers.project_id = jobs.project_id
          AND workers.status = 'active' AND workers.capability_hash = $3
        WHERE jobs.project_id = $2 AND jobs.status = 'queued'
          AND jobs.not_before <= $4 AND jobs.deadline_at > $4
          AND (jobs.pinned_worker_id IS NULL OR jobs.pinned_worker_id = workers.id)
          AND (jobs.placement_class = 'public' OR workers.kind = 'private')
          AND workers.capability_manifest @> jobs.required_capabilities
        ORDER BY jobs.priority DESC, jobs.not_before, jobs.created_at, jobs.id
        FOR UPDATE OF jobs SKIP LOCKED
        LIMIT 1
      `, [
        identity.workerId,
        identity.projectId,
        Buffer.from(identity.capabilityHash, "base64url"),
        now,
      ]);
      const job = selected.rows[0];
      if (job === undefined) return null;

      const generations = await transaction.query<{ generation: number | string }>(`
        SELECT COALESCE(MAX(generation), 0) + 1 AS generation
        FROM job_leases WHERE job_id = $1 AND project_id = $2
      `, [job.id, identity.projectId]);
      const generation = Number(generations.rows[0]?.generation);
      if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new Error("The next Job lease generation is invalid.");
      }
      const heartbeatDeadline = new Date(Math.min(
        now.getTime() + 30_000,
        job.deadline_at.getTime(),
      ));
      const leaseId = randomUUID();
      const insertedLease = await transaction.query<JobLeaseRow>(`
        INSERT INTO job_leases(
          id, project_id, job_id, worker_id, generation, status,
          claimed_at, heartbeat_at, heartbeat_deadline, lease_deadline
        ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $6, $7, $8)
        RETURNING id, project_id, job_id, worker_id, generation,
          heartbeat_deadline, lease_deadline
      `, [
        leaseId, identity.projectId, job.id, identity.workerId, generation,
        now, heartbeatDeadline, job.deadline_at,
      ]);
      const lease = insertedLease.rows[0];
      if (lease === undefined) throw new Error("The Job lease insert returned no record.");
      const running = await transaction.query<ControlPlaneJobRow>(`
        UPDATE jobs SET status = 'running', updated_at = $3
        WHERE id = $1 AND project_id = $2 AND status = 'queued'
        RETURNING *
      `, [job.id, identity.projectId, now]);
      const runningJob = running.rows[0];
      if (runningJob === undefined) throw new Error("The claimed Job could not start running.");
      return Object.freeze({ job: controlPlaneJob(runningJob), lease: jobLease(lease) });
    });
  }

  async heartbeat(
    identity: AuthenticatedWorker,
    leaseId: string,
    generation: number,
  ): Promise<JobLease> {
    requireIdentifier(leaseId, "leaseId");
    requireJobInteger(generation, "generation");
    const now = this.now();
    const nextHeartbeat = new Date(now.getTime() + 30_000);
    return this.database.transaction(async (transaction) => {
      await this.requireActiveWorkerSession(transaction, identity);
      const updated = await transaction.query<JobLeaseRow>(`
        UPDATE job_leases AS leases
        SET heartbeat_at = $5,
          heartbeat_deadline = LEAST($6, leases.lease_deadline)
        FROM jobs
        WHERE leases.id = $1 AND leases.worker_id = $2
          AND leases.project_id = $3 AND leases.generation = $4
          AND leases.status = 'active' AND leases.heartbeat_deadline > $5
          AND leases.lease_deadline > $5
          AND jobs.id = leases.job_id AND jobs.project_id = leases.project_id
          AND jobs.status IN ('assigned', 'running')
        RETURNING leases.id, leases.project_id, leases.job_id, leases.worker_id,
          leases.generation, leases.heartbeat_deadline, leases.lease_deadline
      `, [leaseId, identity.workerId, identity.projectId, generation, now, nextHeartbeat]);
      const lease = updated.rows[0];
      if (lease === undefined) throw new LeaseFencedError();
      const running = await transaction.query<{ id: string }>(`
        UPDATE jobs SET status = 'running', updated_at = $3
        WHERE id = $1 AND project_id = $2 AND status IN ('assigned', 'running')
        RETURNING id
      `, [lease.job_id, identity.projectId, now]);
      if (running.rows[0] === undefined) throw new LeaseFencedError();
      return jobLease(lease);
    });
  }

  async complete(
    identity: AuthenticatedWorker,
    leaseId: string,
    generation: number,
    terminal: Readonly<{
      status: "completed" | "failed";
      resultCompleteness: JobResultCompleteness | null;
      errorCode: string | null;
    }>,
  ): Promise<ControlPlaneJob> {
    requireIdentifier(leaseId, "leaseId");
    requireJobInteger(generation, "generation");
    const validCompleted = terminal.status === "completed" &&
      (terminal.resultCompleteness === "complete" || terminal.resultCompleteness === "partial") &&
      terminal.errorCode === null;
    const validFailed = terminal.status === "failed" && terminal.resultCompleteness === null &&
      typeof terminal.errorCode === "string" && terminal.errorCode.trim().length > 0;
    if (!validCompleted && !validFailed) {
      throw new JobTerminalValidationError();
    }

    const now = this.now();
    return this.database.transaction(async (transaction) => {
      await this.requireActiveWorkerSession(transaction, identity);
      const finishedLease = await transaction.query<JobLeaseRow>(`
        UPDATE job_leases SET status = 'completed', finished_at = $5
        WHERE id = $1 AND worker_id = $2 AND project_id = $3 AND generation = $4
          AND status = 'active' AND heartbeat_deadline > $5 AND lease_deadline > $5
        RETURNING id, project_id, job_id, worker_id, generation,
          heartbeat_deadline, lease_deadline
      `, [leaseId, identity.workerId, identity.projectId, generation, now]);
      const lease = finishedLease.rows[0];
      if (lease === undefined) throw new LeaseFencedError();
      const finishedJob = await transaction.query<ControlPlaneJobRow>(`
        UPDATE jobs SET status = $3, result_completeness = $4, error_code = $5,
          completed_at = $6, updated_at = $6
        WHERE id = $1 AND project_id = $2 AND status = 'running'
        RETURNING *
      `, [
        lease.job_id, identity.projectId, terminal.status,
        terminal.resultCompleteness, terminal.errorCode, now,
      ]);
      const job = finishedJob.rows[0];
      if (job === undefined) throw new LeaseFencedError();
      return controlPlaneJob(job);
    });
  }

  async pause(scope: Pick<ProjectScope, "projectId">, jobId: string): Promise<ControlPlaneJob> {
    return this.controlTransition(scope, jobId, "paused", [
      "queued", "assigned", "running", "paused",
    ]);
  }

  async resume(scope: Pick<ProjectScope, "projectId">, jobId: string): Promise<ControlPlaneJob> {
    return this.controlTransition(scope, jobId, "queued", ["paused", "queued"]);
  }

  async cancel(scope: Pick<ProjectScope, "projectId">, jobId: string): Promise<ControlPlaneJob> {
    return this.controlTransition(scope, jobId, "cancelled", [
      "accepted", "queued", "assigned", "running", "paused", "cancelled",
    ]);
  }

  private async requireActiveWorkerSession(
    transaction: ControlPlaneQuery,
    identity: AuthenticatedWorker,
  ): Promise<void> {
    const active = await transaction.query<{ active: boolean }>(`
      SELECT EXISTS(
        SELECT 1 FROM worker_sessions
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
      ) AS active
    `, [
      identity.sessionId,
      identity.workerId,
      identity.projectId,
      Buffer.from(identity.capabilityHash, "base64url"),
    ]);
    if (active.rows[0]?.active !== true) throw new JobWorkerAccessDeniedError();
  }

  private async controlTransition(
    scope: Pick<ProjectScope, "projectId">,
    jobId: string,
    target: "paused" | "queued" | "cancelled",
    sources: readonly JobStatus[],
  ): Promise<ControlPlaneJob> {
    requireIdentifier(jobId, "jobId");
    const now = this.now();
    return this.database.transaction(async (transaction) => {
      const changed = await transaction.query<ControlPlaneJobRow>(`
        UPDATE jobs SET status = $3, updated_at = $4,
          completed_at = CASE WHEN $3 = 'cancelled' THEN COALESCE(completed_at, $4)
            ELSE completed_at END
        WHERE id = $1 AND project_id = $2 AND status = ANY($5::text[])
          AND ($3 <> 'queued' OR deadline_at > $4)
        RETURNING *
      `, [jobId, scope.projectId, target, now, sources]);
      const job = changed.rows[0];
      if (job === undefined) throw new JobTransitionError();
      if (target === "paused" || target === "cancelled") {
        await transaction.query<{ id: string }>(`
          UPDATE job_leases SET status = 'cancelled', finished_at = $3
          WHERE job_id = $1 AND project_id = $2 AND status = 'active'
          RETURNING id
        `, [jobId, scope.projectId, now]);
      }
      return controlPlaneJob(job);
    });
  }
}
