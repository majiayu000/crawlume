import { randomUUID } from "node:crypto";

import { z, ZodError } from "zod";

import {
  WorkerAuthenticationError,
  WorkerEnrollmentAuthenticationError,
  WorkerNotFoundError,
  WorkerPublicKeyError,
  type CreatedWorkerEnrollment,
  type WorkerChallenge,
  type WorkerIdentityService,
  type WorkerRecord,
  type WorkerSession,
} from "./api-key-service.js";
import {
  AccessTokenAuthenticationError,
  type OidcSessionService,
} from "./oidc-session-service.js";
import {
  OrganizationAccessDeniedError,
  type AuditContext,
} from "./organization-authorization.js";
import type { WorkerHttpRequest, WorkerHttpResponse } from "./organization-service.js";
import {
  controlPlaneHeader,
  isJsonControlPlaneRequest,
} from "./project-http-api.js";
import {
  ProjectAccessDeniedError,
  type AuthenticatedUser,
  type ProjectScope,
} from "./project-scope.js";

type WorkerBootstrapHttpServices = Readonly<{
  authenticateAccessToken: OidcSessionService["verifyAccessToken"];
  resolveScope(subject: AuthenticatedUser, projectId: string): Promise<ProjectScope>;
  createEnrollment: WorkerIdentityService["createEnrollment"];
  enroll: WorkerIdentityService["enroll"];
  createChallenge: WorkerIdentityService["createChallenge"];
  createSession: WorkerIdentityService["createSession"];
  disableWorker: WorkerIdentityService["disableWorker"];
}>;

type WorkerBootstrapHttpDependencies = Readonly<{ requestId?: () => string }>;

type WorkerBootstrapProblem = Readonly<{
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

type WorkerBootstrapRoute =
  | Readonly<{ kind: "create-enrollment"; projectId: string; method: "POST" }>
  | Readonly<{ kind: "enroll"; method: "POST" }>
  | Readonly<{ kind: "challenge"; method: "POST" }>
  | Readonly<{ kind: "session"; method: "POST" }>
  | Readonly<{ kind: "disable"; projectId: string; workerId: string; method: "POST" }>;

const uuidPath =
  "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})";
const maximumCapabilityManifestBytes = 16 * 1_024;

const workerBootstrapRouteDefinitions = [
  {
    kind: "create-enrollment",
    method: "POST",
    path: "/projects/{project_id}/worker-enrollments",
    operationId: "createWorkerEnrollment",
    pattern: new RegExp(`^/v1/projects/${uuidPath}/worker-enrollments$`, "u"),
  },
  {
    kind: "enroll",
    method: "POST",
    path: "/worker-enrollments",
    operationId: "enrollWorker",
    pattern: /^\/v1\/worker-enrollments$/u,
  },
  {
    kind: "challenge",
    method: "POST",
    path: "/worker-sessions/challenges",
    operationId: "createWorkerSessionChallenge",
    pattern: /^\/v1\/worker-sessions\/challenges$/u,
  },
  {
    kind: "session",
    method: "POST",
    path: "/worker-sessions",
    operationId: "createWorkerSession",
    pattern: /^\/v1\/worker-sessions$/u,
  },
  {
    kind: "disable",
    method: "POST",
    path: "/projects/{project_id}/workers/{worker_id}/disable",
    operationId: "disableProjectWorker",
    pattern: new RegExp(`^/v1/projects/${uuidPath}/workers/${uuidPath}/disable$`, "u"),
  },
] as const;

export const workerBootstrapRouterOperations = Object.freeze(
  workerBootstrapRouteDefinitions.map(({ method, operationId, path }) => ({
    method,
    operationId,
    path,
  })),
);

const createEnrollmentBodySchema = z.object({
  worker_name: z.string().trim().min(1).max(128),
}).strict();
const enrollBodySchema = z.object({
  public_key_spki: z.string().min(1).max(512),
  version: z.string().trim().min(1).max(128),
  capabilities: z.record(z.string(), z.unknown()).refine((capabilities) => {
    try {
      const json = JSON.stringify(capabilities);
      return json !== undefined && Buffer.byteLength(json) <= maximumCapabilityManifestBytes;
    } catch {
      return false;
    }
  }, "Capabilities must be valid JSON no larger than 16 KiB."),
}).strict();
const challengeBodySchema = z.object({ worker_id: z.uuid() }).strict();
const sessionBodySchema = z.object({
  worker_id: z.uuid(),
  challenge: z.string().regex(/^dya_wc_[A-Za-z0-9_-]{43}$/u),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
}).strict();
const disableBodySchema = z.object({}).strict();

function matchRoute(path: string): WorkerBootstrapRoute | null {
  for (const definition of workerBootstrapRouteDefinitions) {
    const matched = definition.pattern.exec(path);
    if (matched === null) continue;
    if (definition.kind === "create-enrollment") {
      const projectId = matched[1];
      if (projectId !== undefined) return { kind: definition.kind, method: "POST", projectId };
      continue;
    }
    if (definition.kind === "disable") {
      const projectId = matched[1];
      const workerId = matched[2];
      if (projectId !== undefined && workerId !== undefined) {
        return { kind: definition.kind, method: "POST", projectId, workerId };
      }
      continue;
    }
    return { kind: definition.kind, method: "POST" };
  }
  return null;
}

function humanAccessToken(request: WorkerHttpRequest): string {
  const credential = bearerCredential(request);
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(credential)) {
    throw new AccessTokenAuthenticationError();
  }
  return credential;
}

function workerEnrollmentToken(request: WorkerHttpRequest): string {
  const credential = bearerCredential(request);
  if (!/^dya_we_[A-Za-z0-9_-]{43}$/u.test(credential)) {
    throw new WorkerEnrollmentAuthenticationError();
  }
  return credential;
}

function bearerCredential(request: WorkerHttpRequest): string {
  const authorization = controlPlaneHeader(request, "authorization");
  const match = /^([A-Za-z]+) ([^\s]+)$/u.exec(authorization ?? "");
  if (match?.[1]?.toLowerCase() !== "bearer" || match[2] === undefined) return "";
  return match[2];
}

function wireWorker(worker: WorkerRecord): Record<string, unknown> {
  return {
    id: worker.id,
    project_id: worker.projectId,
    name: worker.name,
    kind: worker.kind,
    version: worker.version,
    capability_hash: worker.capabilityHash,
    status: worker.status,
    created_by_user_id: worker.createdByUserId,
    created_at: worker.createdAt.toISOString(),
    disabled_at: worker.disabledAt?.toISOString() ?? null,
  };
}

function wireEnrollment(created: CreatedWorkerEnrollment): Record<string, unknown> {
  return {
    id: created.enrollment.id,
    project_id: created.enrollment.projectId,
    worker_name: created.enrollment.workerName,
    created_by_user_id: created.enrollment.createdByUserId,
    expires_at: created.enrollment.expiresAt.toISOString(),
  };
}

function wireChallenge(challenge: WorkerChallenge): Record<string, unknown> {
  return {
    worker_id: challenge.workerId,
    challenge: challenge.challenge,
    signing_payload: challenge.signingPayload,
    expires_at: challenge.expiresAt.toISOString(),
  };
}

function wireSession(session: WorkerSession): Record<string, unknown> {
  return { token: session.token, expires_at: session.expiresAt.toISOString() };
}

function response(status: number, requestId: string, body: unknown): WorkerHttpResponse {
  return {
    status,
    headers: Object.freeze({
      "cache-control": "no-store",
      "content-type": "application/json",
      "x-request-id": requestId,
    }),
    body,
  };
}

function problem(
  request: WorkerHttpRequest,
  requestId: string,
  status: number,
  code: string,
  title: string,
  detail: string,
  errors?: WorkerBootstrapProblem["errors"],
  authenticateBearer = false,
): WorkerHttpResponse {
  const body: WorkerBootstrapProblem = {
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
      ...(authenticateBearer ? { "www-authenticate": "Bearer" } : {}),
    }),
    body,
  };
}

export class WorkerBootstrapHttpApi {
  static readonly routerOperations = workerBootstrapRouterOperations;

  private readonly requestId: () => string;

  constructor(
    private readonly services: WorkerBootstrapHttpServices,
    dependencies: WorkerBootstrapHttpDependencies = {},
  ) {
    this.requestId = dependencies.requestId ?? randomUUID;
  }

  async handle(request: WorkerHttpRequest): Promise<WorkerHttpResponse> {
    const requestId = this.requestId();
    const route = matchRoute(request.path);
    if (route === null) {
      return problem(request, requestId, 404, "WORKER_BOOTSTRAP_ROUTE_NOT_FOUND", "Not Found",
        "The Worker bootstrap route does not exist.");
    }
    if (request.method.toUpperCase() !== route.method) {
      const result = problem(request, requestId, 405, "WORKER_BOOTSTRAP_METHOD_NOT_ALLOWED",
        "Method Not Allowed", "The Worker bootstrap route does not accept this method.");
      return { ...result, headers: { ...result.headers, allow: route.method } };
    }
    if ((request.query ?? "") !== "") {
      return problem(request, requestId, 400, "WORKER_BOOTSTRAP_QUERY_UNSUPPORTED", "Bad Request",
        "Worker bootstrap routes do not accept query parameters.");
    }

    try {
      const auditContext: AuditContext = { correlationId: requestId };
      if (route.kind === "create-enrollment") {
        const scope = await this.humanScope(request, route.projectId);
        this.requireJson(request);
        const body = createEnrollmentBodySchema.parse(request.body);
        const created = await this.services.createEnrollment(
          scope,
          { workerName: body.worker_name },
          auditContext,
        );
        return response(201, requestId, {
          request_id: requestId,
          enrollment: wireEnrollment(created),
          enrollment_token: created.rawToken,
        });
      }
      if (route.kind === "enroll") {
        const token = workerEnrollmentToken(request);
        this.requireJson(request);
        const body = enrollBodySchema.parse(request.body);
        const enrolled = await this.services.enroll(token, {
          publicKeySpki: body.public_key_spki,
          version: body.version,
          capabilities: body.capabilities,
        }, auditContext);
        return response(201, requestId, { request_id: requestId, worker: wireWorker(enrolled) });
      }
      if (route.kind === "challenge") {
        this.requireJson(request);
        const body = challengeBodySchema.parse(request.body);
        const created = await this.services.createChallenge(body.worker_id);
        return response(201, requestId, {
          request_id: requestId,
          challenge: wireChallenge(created),
        });
      }
      if (route.kind === "session") {
        this.requireJson(request);
        const body = sessionBodySchema.parse(request.body);
        const created = await this.services.createSession({
          workerId: body.worker_id,
          challenge: body.challenge,
          signature: body.signature,
        });
        return response(201, requestId, { request_id: requestId, session: wireSession(created) });
      }
      const scope = await this.humanScope(request, route.projectId);
      this.requireJson(request);
      disableBodySchema.parse(request.body);
      const disabled = await this.services.disableWorker(
        scope,
        route.workerId,
        auditContext,
      );
      return response(200, requestId, { request_id: requestId, worker: wireWorker(disabled) });
    } catch (error) {
      return this.errorResponse(request, requestId, error);
    }
  }

  private async humanScope(request: WorkerHttpRequest, projectId: string): Promise<ProjectScope> {
    const subject = await this.services.authenticateAccessToken(humanAccessToken(request));
    return this.services.resolveScope(subject, projectId);
  }

  private requireJson(request: WorkerHttpRequest): void {
    if (!isJsonControlPlaneRequest(request)) {
      throw new WorkerBootstrapMediaTypeError();
    }
  }

  private errorResponse(
    request: WorkerHttpRequest,
    requestId: string,
    error: unknown,
  ): WorkerHttpResponse {
    if (error instanceof AccessTokenAuthenticationError) {
      return problem(
        request,
        requestId,
        401,
        error.code,
        "Access Token Invalid",
        error.message,
        undefined,
        true,
      );
    }
    if (error instanceof WorkerEnrollmentAuthenticationError) {
      return problem(
        request,
        requestId,
        401,
        error.code,
        "Worker Enrollment Invalid",
        error.message,
        undefined,
        true,
      );
    }
    if (error instanceof WorkerAuthenticationError) {
      return problem(request, requestId, 400, error.code, "Worker Proof Invalid",
        "The Worker identity, challenge, signature, or session is invalid.");
    }
    if (error instanceof WorkerPublicKeyError) {
      return problem(request, requestId, 422, error.code, "Worker Public Key Invalid",
        "The Worker public key must be a canonical Ed25519 SPKI key.");
    }
    if (error instanceof ProjectAccessDeniedError || error instanceof OrganizationAccessDeniedError) {
      return problem(request, requestId, 403, "WORKER_MANAGEMENT_FORBIDDEN", "Forbidden",
        "The authenticated user cannot manage Workers in this Project.");
    }
    if (error instanceof WorkerNotFoundError) {
      return problem(request, requestId, 404, error.code, "Worker Not Found", error.message);
    }
    if (error instanceof WorkerBootstrapMediaTypeError) {
      return problem(request, requestId, 415, error.code, "Unsupported Media Type", error.message);
    }
    if (error instanceof ZodError) {
      return problem(request, requestId, 422, "WORKER_BOOTSTRAP_REQUEST_INVALID",
        "Worker Bootstrap Request Invalid", "The Worker bootstrap request body failed validation.",
        error.issues.map((issue) => ({
          field: issue.path.length === 0 ? "body" : issue.path.join("."),
          message: issue.message,
        })));
    }
    return problem(request, requestId, 500, "INTERNAL_ERROR", "Internal Server Error",
      "The Worker bootstrap request could not be completed.");
  }
}

class WorkerBootstrapMediaTypeError extends Error {
  readonly code = "WORKER_BOOTSTRAP_MEDIA_TYPE_UNSUPPORTED";

  constructor() {
    super("Worker bootstrap requests must use application/json.");
    this.name = "WorkerBootstrapMediaTypeError";
  }
}
