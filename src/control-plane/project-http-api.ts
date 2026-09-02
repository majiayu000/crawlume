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
  controlPlaneJobTypes,
  type CreateControlPlaneJobInput,
  type ControlPlaneJobService,
} from "./project-scope.js";
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
}>;

type ProjectJobHttpDependencies = Readonly<{ requestId?: () => string }>;

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

class ProjectJobInputError extends Error {
  readonly code = "JOB_REQUEST_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "ProjectJobInputError";
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
  | Readonly<{ kind: "audit"; method: "GET"; projectId: string }>;
const jsonObjectSchema = z.record(z.string(), z.unknown());
const safePositiveInteger = z.number().int().positive().safe();
const safeNonnegativeInteger = z.number().int().nonnegative().safe();
const createJobBodySchema = z.object({
  type: z.enum(controlPlaneJobTypes),
  input: jsonObjectSchema,
  data_class: z.enum(["public", "authorized", "intranet"]),
  placement: z.object({
    class: z.enum(["public", "private"]),
    pinned_worker_id: z.uuid().nullable(),
  }).strict(),
  required_capabilities: jsonObjectSchema,
  budget: z.object({
    deadline_ms: safePositiveInteger.max(86_400_000),
    max_provider_attempts: safePositiveInteger.max(1_000_000),
    max_document_bytes: safePositiveInteger.max(Number.MAX_SAFE_INTEGER),
    max_browser_ms: safeNonnegativeInteger.max(86_400_000),
    max_browser_contexts: safeNonnegativeInteger.max(100_000),
  }).strict(),
  policy_version: z.string().trim().min(1).max(256),
  upload_private_artifact: z.boolean(),
  priority: z.number().int().min(-100).max(100).optional(),
  not_before: z.string().datetime({ offset: true }).optional(),
}).strict();
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

  constructor(
    private readonly services: ProjectJobHttpServices,
    dependencies: ProjectJobHttpDependencies = {},
  ) {
    this.requestId = dependencies.requestId ?? randomUUID;
  }

  async handle(request: WorkerHttpRequest): Promise<WorkerHttpResponse> {
    const requestId = this.requestId();
    const route = matchProjectJobRoute(request.path);
    if (route === null) {
      return projectProblem(request, requestId, 404, "PROJECT_ROUTE_NOT_FOUND", "Not Found",
        "The Project API route does not exist.");
    }
    if (request.method.toUpperCase() !== route.method) {
      const response = projectProblem(request, requestId, 405, "PROJECT_METHOD_NOT_ALLOWED",
        "Method Not Allowed", "The Project API route does not accept this method.");
      return { ...response, headers: { ...response.headers, allow: route.method } };
    }

    try {
      const context = { correlationId: requestId };
      const identity = await this.services.authenticate(projectBearerKey(request), context);
      if (route.projectId.toLowerCase() !== identity.projectId.toLowerCase()) {
        throw new ProjectPathIdentityMismatchError();
      }
      if (route.kind !== "publications" && route.kind !== "audit" &&
          (request.query ?? "") !== "") {
        throw new ProjectQueryError();
      }
      if (route.kind === "get") {
        requireProjectApiKeyScope(identity, "results:read");
        const found = await this.services.getJob(identity, route.jobId);
        return projectResponse(200, requestId, {
          request_id: requestId,
          job: wireJob(found),
        });
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
          job: wireJob(controlled),
        });
      }
      requireProjectApiKeyScope(identity, "tasks:write");
      if (!isJsonControlPlaneRequest(request)) {
        return projectProblem(request, requestId, 415, "PROJECT_MEDIA_TYPE_UNSUPPORTED",
          "Unsupported Media Type", "Project requests must use application/json.");
      }
      const key = idempotencyKey(request);
      const parsed = createJobBodySchema.parse(request.body);
      // The service validates this dynamic envelope before hashing or persistence.
      const creationInput = {
        type: parsed.type,
        input: parsed.input,
        dataClass: parsed.data_class,
        placement: {
          class: parsed.placement.class,
          pinnedWorkerId: parsed.placement.pinned_worker_id,
        },
        requiredCapabilities: parsed.required_capabilities,
        budget: {
          deadlineMs: parsed.budget.deadline_ms,
          maxProviderAttempts: parsed.budget.max_provider_attempts,
          maxDocumentBytes: parsed.budget.max_document_bytes,
          maxBrowserMs: parsed.budget.max_browser_ms,
          maxBrowserContexts: parsed.budget.max_browser_contexts,
        },
        policyVersion: parsed.policy_version,
        uploadPrivateArtifact: parsed.upload_private_artifact,
        ...(parsed.priority === undefined ? {} : { priority: parsed.priority }),
        ...(parsed.not_before === undefined ? {} : { notBefore: new Date(parsed.not_before) }),
      } as CreateControlPlaneJobInput;
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
        job: wireJob(created),
      }, { location });
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
    private readonly projects: Pick<ProjectJobHttpApi, "handle">,
    private readonly workers: Readonly<{
      handle(request: WorkerHttpRequest): Promise<WorkerHttpResponse>;
    }>,
  ) {}

  handle(request: WorkerHttpRequest): Promise<WorkerHttpResponse> {
    return request.path.startsWith("/v1/projects/")
      ? this.projects.handle(request)
      : this.workers.handle(request);
  }
}
