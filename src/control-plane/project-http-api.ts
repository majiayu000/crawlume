import { randomUUID } from "node:crypto";

import { z, ZodError } from "zod";

import {
  ProjectApiKeyAuthenticationError,
  ProjectApiKeyScopeError,
  requireProjectApiKeyScope,
  type AuthenticatedProjectApiKey,
} from "./api-key-service.js";
import type {
  AuditContext,
  AuditCursor,
  AuditEvent,
  JobResultService,
} from "./organization-authorization.js";
import {
  wirePublication,
  wireJob,
  type WorkerHttpRequest,
  type WorkerHttpResponse,
} from "./organization-service.js";
import {
  JobIdempotencyConflictError,
  JobNotFoundError,
  JobTransitionError,
  type ControlPlaneJob,
  type ControlPlaneJobService,
} from "./project-scope.js";
import {
  ArtifactNotFoundError,
  ArtifactStorageDisabledError,
  type ArtifactStorageService,
} from "./artifact-storage.js";
import {
  assertExecutableJob,
  createJobBodySchema,
  jobCreationInput,
  ProjectJobInputError,
} from "./job-request-wire.js";
import { CronExpressionError } from "./cron.js";
import { JobScheduleConflictError, JobScheduleNotFoundError } from "./job-schedules.js";
import {
  DatasetNotFoundError,
  KeyValueRecordNotFoundError,
  KeyValueRecordTooLargeError,
  KeyValueStoreNotFoundError,
  StorageInputError,
} from "./project-storage.js";
import { handleScheduleRoute, matchScheduleRoute, type ScheduleHttpServices } from "./schedule-http.js";
import {
  StorageQueryError,
  handleStorageRoute,
  matchStorageRoute,
  type ProjectSubRouteResult,
  type StorageHttpServices,
} from "./storage-http.js";
import { QuotaExceededError, type ApiRequestRateLimiter } from "./quotas.js";
import {
  WebhookQueryError,
  handleWebhookRoute,
  matchWebhookRoute,
  type WebhookHttpServices,
} from "./webhook-http.js";
import {
  WebhookEndpointInvalidError,
  WebhookNotFoundError,
  WebhooksDisabledError,
} from "./webhooks.js";
import {
  controlPlaneRouterOperations,
  projectJobRouteDefinitions,
} from "./router-contract.js";

type ProjectJobHttpServices = Readonly<{
  authenticate(rawKey: string, context: AuditContext): Promise<AuthenticatedProjectApiKey>;
  createJob: ControlPlaneJobService["createJob"];
  getJob: ControlPlaneJobService["getJob"];
  pauseJob: ControlPlaneJobService["pause"];
  resumeJob: ControlPlaneJobService["resume"];
  cancelJob: ControlPlaneJobService["cancel"];
  listPublications: JobResultService["listPublications"];
  listAuditEvents(
    identity: AuthenticatedProjectApiKey,
    input: Readonly<{ limit: number; before: AuditCursor | null }>,
  ): Promise<readonly AuditEvent[]>;
  webhooks?: WebhookHttpServices;
  artifacts?: Pick<ArtifactStorageService, "downloadUrl">;
  storage?: StorageHttpServices;
  schedules?: ScheduleHttpServices;
}>;

type SubRouteMatch =
  | Readonly<{ allow: string; projectId: string }>
  | Readonly<{
    projectId: string;
    json: boolean;
    run(identity: AuthenticatedProjectApiKey): Promise<ProjectSubRouteResult>;
  }>;

/** Project responses add the output dataset, which Worker claims do not carry. */
function wireProjectJob(job: ControlPlaneJob): Record<string, unknown> {
  return { ...wireJob(job), dataset_id: job.datasetId };
}

type ProjectJobHttpDependencies = Readonly<{
  requestId?: () => string;
  rateLimiter?: ApiRequestRateLimiter;
}>;

type ProjectProblem = Readonly<{
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

class ProjectPathIdentityMismatchError extends Error {
  readonly code = "PROJECT_PATH_IDENTITY_MISMATCH";
  constructor() {
    super("The Project path does not match the authenticated API Key.");
    this.name = "ProjectPathIdentityMismatchError";
  }
}

class IdempotencyKeyRequiredError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REQUIRED";
  constructor() {
    super("A single Idempotency-Key header is required.");
    this.name = "IdempotencyKeyRequiredError";
  }
}

class ProjectQueryError extends Error {
  readonly code = "PROJECT_QUERY_INVALID";
  constructor() {
    super("The Project query parameters are invalid or unsupported.");
    this.name = "ProjectQueryError";
  }
}

type ProjectJobRoute =
  | Readonly<{ kind: "create"; method: "POST"; projectId: string }>
  | Readonly<{ kind: "get"; method: "GET"; projectId: string; jobId: string }>
  | Readonly<{ kind: "pause"; method: "POST"; projectId: string; jobId: string }>
  | Readonly<{ kind: "resume"; method: "POST"; projectId: string; jobId: string }>
  | Readonly<{ kind: "cancel"; method: "POST"; projectId: string; jobId: string }>
  | Readonly<{ kind: "publications"; method: "GET"; projectId: string; jobId: string }>
  | Readonly<{ kind: "artifact-download"; method: "GET"; projectId: string; artifactId: string }>
  | Readonly<{ kind: "audit"; method: "GET"; projectId: string }>;
const controlJobBodySchema = z.object({}).strict();

const auditCursorSchema = z.object({
  occurred_at: z.string().datetime({ offset: true }),
  id: z.uuid(),
}).strict();

function matchProjectJobRoute(path: string): ProjectJobRoute | null {
  for (const definition of projectJobRouteDefinitions) {
    const matched = definition.pattern.exec(path);
    const projectId = matched?.[1];
    if (projectId === undefined) continue;
    if (definition.kind === "create") {
      return { kind: definition.kind, method: definition.method, projectId };
    }
    if (definition.kind === "audit") {
      return { kind: definition.kind, method: definition.method, projectId };
    }
    const jobId = matched?.[2];
    if (jobId === undefined) continue;
    if (definition.kind === "artifact-download") {
      return { kind: definition.kind, method: definition.method, projectId, artifactId: jobId };
    }
    if (definition.kind === "get") {
      return { kind: definition.kind, method: definition.method, projectId, jobId };
    }
    if (definition.kind === "pause" || definition.kind === "resume" ||
        definition.kind === "cancel") {
      return { kind: definition.kind, method: definition.method, projectId, jobId };
    }
    return { kind: definition.kind, method: definition.method, projectId, jobId };
  }
  return null;
}

function singlePositiveQueryInteger(parameters: URLSearchParams, name: string): number | null {
  const values = parameters.getAll(name);
  if (values.length === 0) return null;
  if (values.length !== 1 || !/^[1-9][0-9]*$/u.test(values[0] ?? "")) {
    throw new ProjectQueryError();
  }
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value)) throw new ProjectQueryError();
  return value;
}

function publicationQuery(query: string): { afterSequence: number | null; limit: number } {
  const parameters = new URLSearchParams(query);
  for (const key of parameters.keys()) {
    if (key !== "after_sequence" && key !== "limit") throw new ProjectQueryError();
  }
  const afterSequence = singlePositiveQueryInteger(parameters, "after_sequence");
  const limit = singlePositiveQueryInteger(parameters, "limit") ?? 50;
  if (limit > 100) throw new ProjectQueryError();
  return { afterSequence, limit };
}

function auditQuery(query: string): { before: AuditCursor | null; limit: number } {
  const parameters = new URLSearchParams(query);
  for (const key of parameters.keys()) {
    if (key !== "cursor" && key !== "limit") throw new ProjectQueryError();
  }
  const limit = singlePositiveQueryInteger(parameters, "limit") ?? 50;
  const cursors = parameters.getAll("cursor");
  if (limit > 100 || cursors.length > 1) throw new ProjectQueryError();
  if (cursors.length === 0) return { before: null, limit };
  const encoded = cursors[0] ?? "";
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || encoded.length > 512) throw new ProjectQueryError();
  try {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) throw new ProjectQueryError();
    const cursor = auditCursorSchema.parse(JSON.parse(decoded.toString("utf8")) as unknown);
    return { before: { occurredAt: new Date(cursor.occurred_at), id: cursor.id }, limit };
  } catch (error) {
    if (error instanceof ProjectQueryError) throw error;
    throw new ProjectQueryError();
  }
}

function auditCursor(event: AuditEvent): string {
  return Buffer.from(JSON.stringify({
    occurred_at: event.occurredAt.toISOString(), id: event.id,
  })).toString("base64url");
}

function wireAuditEvent(event: AuditEvent): Record<string, unknown> {
  return {
    id: event.id, actor_type: event.actorType, actor_id: event.actorId,
    action: event.action, target_type: event.targetType, target_id: event.targetId,
    outcome: event.outcome, correlation_id: event.correlationId,
    occurred_at: event.occurredAt.toISOString(),
  };
}

export function controlPlaneHeader(request: WorkerHttpRequest, name: string): string | null {
  const found = Object.entries(request.headers).filter(([key]) => key.toLowerCase() === name);
  return found.length === 1 && typeof found[0]?.[1] === "string" ? found[0][1] : null;
}

function projectBearerKey(request: WorkerHttpRequest): string {
  const authorization = controlPlaneHeader(request, "authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/iu);
  if (match?.[1] === undefined) throw new ProjectApiKeyAuthenticationError();
  return match[1];
}

function idempotencyKey(request: WorkerHttpRequest): string {
  const key = controlPlaneHeader(request, "idempotency-key");
  if (key === null || key.trim().length === 0 || key.trim().length > 200) {
    throw new IdempotencyKeyRequiredError();
  }
  return key;
}

export function isJsonControlPlaneRequest(request: WorkerHttpRequest): boolean {
  return controlPlaneHeader(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json";
}

function projectResponse(
  status: number,
  requestId: string,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): WorkerHttpResponse {
  return {
    status,
    headers: Object.freeze({
      "content-type": "application/json",
      "x-request-id": requestId,
      ...headers,
    }),
    body,
  };
}

function projectProblem(
  request: WorkerHttpRequest,
  requestId: string,
  status: number,
  code: string,
  title: string,
  detail: string,
  errors?: ProjectProblem["errors"],
): WorkerHttpResponse {
  const body: ProjectProblem = {
    type: `https://api.diaoyan.example/errors/${code.toLowerCase().replaceAll("_", "-")}`,
    title,
    status,
    detail,
    instance: request.path,
    code,
    request_id: requestId,
    retryable: status === 500,
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

export class ProjectJobHttpApi {
  private readonly requestId: () => string;
  private readonly rateLimiter: ApiRequestRateLimiter | null;

  constructor(
    private readonly services: ProjectJobHttpServices,
    dependencies: ProjectJobHttpDependencies = {},
  ) {
    this.requestId = dependencies.requestId ?? randomUUID;
    this.rateLimiter = dependencies.rateLimiter ?? null;
  }

  async handle(request: WorkerHttpRequest): Promise<WorkerHttpResponse> {
    const requestId = this.requestId();
    const webhookMatch = this.services.webhooks === undefined
      ? null
      : matchWebhookRoute(request.path, request.method);
    const subRoute = webhookMatch === null ? this.matchSubRoute(request) : null;
    if (subRoute !== null) return this.handleSubRoute(request, requestId, subRoute);
    const route = webhookMatch === null ? matchProjectJobRoute(request.path) : null;
    if (webhookMatch === null && route === null) {
      return projectProblem(request, requestId, 404, "PROJECT_ROUTE_NOT_FOUND", "Not Found",
        "The Project API route does not exist.");
    }
    const allow = webhookMatch !== null && "allow" in webhookMatch
      ? webhookMatch.allow
      : route !== null && request.method.toUpperCase() !== route.method ? route.method : null;
    if (allow !== null) {
      const response = projectProblem(request, requestId, 405, "PROJECT_METHOD_NOT_ALLOWED",
        "Method Not Allowed", "The Project API route does not accept this method.");
      return { ...response, headers: { ...response.headers, allow } };
    }

    try {
      const context = { correlationId: requestId };
      const identity = await this.services.authenticate(projectBearerKey(request), context);
      this.rateLimiter?.take(identity.apiKeyId);
      const pathProjectId = webhookMatch !== null && "route" in webhookMatch
        ? webhookMatch.route.projectId
        : (route as ProjectJobRoute).projectId;
      if (pathProjectId.toLowerCase() !== identity.projectId.toLowerCase()) {
        throw new ProjectPathIdentityMismatchError();
      }
      if (webhookMatch !== null && "route" in webhookMatch && this.services.webhooks !== undefined) {
        if (request.body !== undefined && request.body !== null && !isJsonControlPlaneRequest(request)) {
          return projectProblem(request, requestId, 415, "PROJECT_MEDIA_TYPE_UNSUPPORTED",
            "Unsupported Media Type", "Project requests must use application/json.");
        }
        const handled = await handleWebhookRoute(this.services.webhooks, webhookMatch.route, identity, request);
        return projectResponse(
          handled.status,
          requestId,
          handled.status === 204 ? null : { request_id: requestId, ...(handled.body as object) },
        );
      }
      if (route === null) throw new Error("Project route resolution failed.");
      if (route.kind !== "publications" && route.kind !== "audit" &&
          (request.query ?? "") !== "") {
        throw new ProjectQueryError();
      }
      if (route.kind === "get") {
        requireProjectApiKeyScope(identity, "results:read");
        const found = await this.services.getJob(identity, route.jobId);
        return projectResponse(200, requestId, {
          request_id: requestId,
          job: wireProjectJob(found),
        });
      }
      if (route.kind === "artifact-download") {
        requireProjectApiKeyScope(identity, "results:read");
        if (this.services.artifacts === undefined) throw new ArtifactStorageDisabledError();
        const download = await this.services.artifacts.downloadUrl(identity, route.artifactId, context);
        return projectResponse(200, requestId, {
          request_id: requestId, url: download.url, expires_at: download.expiresAt.toISOString(),
        }, { "cache-control": "no-store" });
      }
      if (route.kind === "publications") {
        requireProjectApiKeyScope(identity, "results:read");
        const query = publicationQuery(request.query ?? "");
        const page = await this.services.listPublications(identity, route.jobId, query);
        if (page === null) throw new JobNotFoundError();
        return projectResponse(200, requestId, {
          request_id: requestId,
          publications: page.items.map(wirePublication),
          pagination: {
            next_sequence: page.nextSequence,
            has_more: page.hasMore,
            limit: query.limit,
          },
        });
      }
      if (route.kind === "audit") {
        requireProjectApiKeyScope(identity, "project:admin");
        const query = auditQuery(request.query ?? "");
        const events = await this.services.listAuditEvents(identity, {
          before: query.before, limit: query.limit + 1,
        });
        const hasMore = events.length > query.limit;
        const items = events.slice(0, query.limit);
        return projectResponse(200, requestId, {
          request_id: requestId,
          audit_events: items.map(wireAuditEvent),
          pagination: {
            next_cursor: hasMore && items.at(-1) !== undefined
              ? auditCursor(items.at(-1)!) : null,
            has_more: hasMore,
            limit: query.limit,
          },
        });
      }
      if (route.kind === "pause" || route.kind === "resume" || route.kind === "cancel") {
        requireProjectApiKeyScope(identity, "tasks:write");
        if (!isJsonControlPlaneRequest(request)) {
          return projectProblem(request, requestId, 415, "PROJECT_MEDIA_TYPE_UNSUPPORTED",
            "Unsupported Media Type", "Project requests must use application/json.");
        }
        controlJobBodySchema.parse(request.body);
        const controlled = route.kind === "pause"
          ? await this.services.pauseJob(identity, route.jobId)
          : route.kind === "resume"
            ? await this.services.resumeJob(identity, route.jobId)
            : await this.services.cancelJob(identity, route.jobId);
        return projectResponse(200, requestId, {
          request_id: requestId,
          job: wireProjectJob(controlled),
        });
      }
      requireProjectApiKeyScope(identity, "tasks:write");
      if (!isJsonControlPlaneRequest(request)) {
        return projectProblem(request, requestId, 415, "PROJECT_MEDIA_TYPE_UNSUPPORTED",
          "Unsupported Media Type", "Project requests must use application/json.");
      }
      const key = idempotencyKey(request);
      const parsed = createJobBodySchema.parse(request.body);
      assertExecutableJob(parsed);
      const creationInput = jobCreationInput(parsed);
      let created;
      try {
        created = await this.services.createJob(identity, key, creationInput, context);
      } catch (error) {
        if (error instanceof TypeError) throw new ProjectJobInputError(error.message);
        throw error;
      }
      const location = `/v1/projects/${identity.projectId}/jobs/${created.id}`;
      return projectResponse(201, requestId, {
        request_id: requestId,
        job: wireProjectJob(created),
      }, { location });
    } catch (error) {
      return this.errorResponse(request, requestId, error);
    }
  }

  private matchSubRoute(request: WorkerHttpRequest): SubRouteMatch | null {
    const { storage, schedules } = this.services;
    const storageMatch = storage === undefined ? null : matchStorageRoute(request.path, request.method);
    if (storageMatch !== null && storage !== undefined) {
      return "allow" in storageMatch ? storageMatch : {
        projectId: storageMatch.route.projectId,
        json: storageMatch.route.kind !== "put-record",
        run: (identity) => handleStorageRoute(storage, storageMatch.route, identity, request),
      };
    }
    const scheduleMatch = schedules === undefined ? null : matchScheduleRoute(request.path, request.method);
    if (scheduleMatch !== null && schedules !== undefined) {
      return "allow" in scheduleMatch ? scheduleMatch : {
        projectId: scheduleMatch.route.projectId,
        json: true,
        run: (identity) => handleScheduleRoute(schedules, scheduleMatch.route, identity, request),
      };
    }
    return null;
  }

  /** Storage and schedule routes share authentication, rate limiting and error mapping with Jobs. */
  private async handleSubRoute(
    request: WorkerHttpRequest,
    requestId: string,
    match: SubRouteMatch,
  ): Promise<WorkerHttpResponse> {
    if ("allow" in match) {
      const response = projectProblem(request, requestId, 405, "PROJECT_METHOD_NOT_ALLOWED",
        "Method Not Allowed", "The Project API route does not accept this method.");
      return { ...response, headers: { ...response.headers, allow: match.allow } };
    }
    try {
      const context = { correlationId: requestId };
      const identity = await this.services.authenticate(projectBearerKey(request), context);
      this.rateLimiter?.take(identity.apiKeyId);
      if (match.projectId.toLowerCase() !== identity.projectId.toLowerCase()) {
        throw new ProjectPathIdentityMismatchError();
      }
      if (match.json && request.body !== undefined && request.body !== null &&
          !isJsonControlPlaneRequest(request)) {
        return projectProblem(request, requestId, 415, "PROJECT_MEDIA_TYPE_UNSUPPORTED",
          "Unsupported Media Type", "Project requests must use application/json.");
      }
      const handled = await match.run(identity);
      if (Buffer.isBuffer(handled.body)) {
        return {
          status: handled.status,
          headers: Object.freeze({ ...handled.headers, "x-request-id": requestId }),
          body: handled.body,
        };
      }
      return projectResponse(
        handled.status,
        requestId,
        handled.status === 204 ? null : { request_id: requestId, ...(handled.body as object) },
        handled.headers,
      );
    } catch (error) {
      return this.errorResponse(request, requestId, error);
    }
  }

  private errorResponse(
    request: WorkerHttpRequest,
    requestId: string,
    error: unknown,
  ): WorkerHttpResponse {
    if (error instanceof ProjectApiKeyAuthenticationError) {
      return projectProblem(request, requestId, 401, "API_KEY_AUTHENTICATION_FAILED",
        "API Key Authentication Failed", "The Project API Key is invalid or no longer active.");
    }
    if (error instanceof ProjectPathIdentityMismatchError) {
      return projectProblem(request, requestId, 403, error.code, "Project Identity Mismatch",
        error.message);
    }
    if (error instanceof ProjectApiKeyScopeError) {
      return projectProblem(request, requestId, 403, error.code, "API Key Scope Denied", error.message);
    }
    if (error instanceof IdempotencyKeyRequiredError) {
      return projectProblem(request, requestId, 400, error.code, "Idempotency Key Required",
        error.message);
    }
    if (error instanceof ProjectQueryError) {
      return projectProblem(request, requestId, 400, error.code, "Project Query Invalid",
        error.message);
    }
    if (error instanceof JobIdempotencyConflictError) {
      return projectProblem(request, requestId, 409, error.code, "Idempotency Conflict", error.message);
    }
    if (error instanceof JobNotFoundError) {
      return projectProblem(request, requestId, 404, error.code, "Job Not Found", error.message);
    }
    if (error instanceof JobTransitionError) {
      return projectProblem(request, requestId, 409, error.code, "Job Transition Invalid",
        error.message);
    }
    if (error instanceof ArtifactStorageDisabledError) {
      return projectProblem(request, requestId, 503, error.code, "Artifact Storage Disabled", error.message);
    }
    if (error instanceof ArtifactNotFoundError) {
      return projectProblem(request, requestId, 404, error.code, "Artifact Not Found", error.message);
    }
    if (error instanceof WebhooksDisabledError) {
      return projectProblem(request, requestId, 503, error.code, "Webhooks Disabled", error.message);
    }
    if (error instanceof WebhookEndpointInvalidError) {
      return projectProblem(request, requestId, 422, error.code, "Webhook Endpoint Invalid", error.message);
    }
    if (error instanceof WebhookNotFoundError) {
      return projectProblem(request, requestId, 404, error.code, "Webhook Not Found", error.message);
    }
    if (error instanceof WebhookQueryError) {
      return projectProblem(request, requestId, 400, error.code, "Webhook Query Invalid", error.message);
    }
    if (error instanceof StorageQueryError) {
      return projectProblem(request, requestId, 400, error.code, "Project Query Invalid", error.message);
    }
    if (error instanceof DatasetNotFoundError) {
      return projectProblem(request, requestId, 404, error.code, "Dataset Not Found", error.message);
    }
    if (error instanceof KeyValueStoreNotFoundError) {
      return projectProblem(request, requestId, 404, error.code, "Key-Value Store Not Found", error.message);
    }
    if (error instanceof KeyValueRecordNotFoundError) {
      return projectProblem(request, requestId, 404, error.code, "Key-Value Record Not Found", error.message);
    }
    if (error instanceof KeyValueRecordTooLargeError) {
      return projectProblem(request, requestId, 413, error.code, "Key-Value Record Too Large", error.message);
    }
    if (error instanceof StorageInputError || error instanceof CronExpressionError) {
      return projectProblem(request, requestId, 422, error.code, "Storage Request Invalid", error.message);
    }
    if (error instanceof JobScheduleNotFoundError) {
      return projectProblem(request, requestId, 404, error.code, "Job Schedule Not Found", error.message);
    }
    if (error instanceof JobScheduleConflictError) {
      return projectProblem(request, requestId, 409, error.code, "Job Schedule Conflict", error.message);
    }
    if (error instanceof QuotaExceededError) {
      const response = projectProblem(request, requestId, 429, error.code, "Quota Exceeded",
        error.message);
      return {
        ...response,
        headers: {
          ...response.headers,
          ...(error.retryAfterSeconds === null ? {} : { "retry-after": String(error.retryAfterSeconds) }),
        },
        body: { ...(response.body as ProjectProblem), retryable: error.retryAfterSeconds !== null },
      };
    }
    if (error instanceof ZodError) {
      return projectProblem(request, requestId, 422, "JOB_REQUEST_INVALID", "Job Request Invalid",
        "The Job request body failed validation.", error.issues.map((issue) => ({
          field: issue.path.length === 0 ? "body" : issue.path.join("."),
          message: issue.message,
        })));
    }
    if (error instanceof ProjectJobInputError) {
      return projectProblem(request, requestId, 422, error.code, "Job Request Invalid",
        error.message);
    }
    return projectProblem(request, requestId, 500, "INTERNAL_ERROR", "Internal Server Error",
      "The Project request could not be completed.");
  }
}

export class ControlPlaneHttpApi {
  static readonly routerOperations = controlPlaneRouterOperations;

  constructor(
    private readonly humanAuth: Readonly<{
      handle(request: WorkerHttpRequest): Promise<WorkerHttpResponse>;
    }>,
    private readonly projectAdmin: Readonly<{
      handle(request: WorkerHttpRequest): Promise<WorkerHttpResponse>;
    }>,
    private readonly workerBootstrap: Readonly<{
      handle(request: WorkerHttpRequest): Promise<WorkerHttpResponse>;
    }>,
    private readonly projects: Pick<ProjectJobHttpApi, "handle">,
    private readonly workers: Readonly<{
      handle(request: WorkerHttpRequest): Promise<WorkerHttpResponse>;
    }>,
  ) {}

  handle(request: WorkerHttpRequest): Promise<WorkerHttpResponse> {
    const { path } = request;
    if (path === "/v1/auth" || path.startsWith("/v1/auth/")) {
      return this.humanAuth.handle(request);
    }
    if (
      path === "/v1/organizations" || path.startsWith("/v1/organizations/") ||
      /^\/v1\/projects\/[^/]+\/api-keys(?:\/[^/]+)?$/u.test(path)
    ) {
      return this.projectAdmin.handle(request);
    }
    if (
      path === "/v1/worker-enrollments" || path === "/v1/worker-sessions" ||
      path.startsWith("/v1/worker-sessions/") ||
      /^\/v1\/projects\/[^/]+\/(?:worker-enrollments|workers\/[^/]+\/disable)$/u.test(path)
    ) {
      return this.workerBootstrap.handle(request);
    }
    return path.startsWith("/v1/projects/")
      ? this.projects.handle(request)
      : this.workers.handle(request);
  }
}
