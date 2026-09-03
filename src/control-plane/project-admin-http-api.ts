import { randomUUID } from "node:crypto";

import { z, ZodError } from "zod";

import {
  AccessTokenAuthenticationError,
  type OidcSessionService,
} from "./oidc-session-service.js";
import {
  ProjectAdminAccessDeniedError,
  ProjectAdminOrganizationNotFoundError,
  ProjectAdminSlugConflictError,
  ProjectCreationIdempotencyConflictError,
  type CreateOrganizationProjectInput,
  type OrganizationProject,
  type OrganizationSummary,
  type ProjectAdminCursor,
  type ProjectAdminPageInput,
} from "./project-admin-management.js";
import type { ProjectApiKeyHttpApi } from "./project-api-key-http-api.js";
import { controlPlaneHeader, isJsonControlPlaneRequest } from "./project-http-api.js";
import type { AuthenticatedUser } from "./project-scope.js";
import { projectApiKeyRouteDefinitions } from "./router-contract.js";
import type { WorkerHttpRequest, WorkerHttpResponse } from "./organization-service.js";

const uuidPath =
  "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})";

const organizationProjectRouterOperations = [
  { method: "GET", path: "/organizations", operationId: "listOrganizations" },
  {
    method: "GET",
    path: "/organizations/{organization_id}/projects",
    operationId: "listOrganizationProjects",
  },
  {
    method: "POST",
    path: "/organizations/{organization_id}/projects",
    operationId: "createOrganizationProject",
  },
] as const;

export const projectAdminRouterOperations = Object.freeze([
  ...organizationProjectRouterOperations,
  ...projectApiKeyRouteDefinitions[0].operations,
  ...projectApiKeyRouteDefinitions[1].operations,
]);

type ProjectAdminHttpServices = Readonly<{
  authenticateAccessToken: OidcSessionService["verifyAccessToken"];
  listOrganizations(
    subject: AuthenticatedUser,
    input: ProjectAdminPageInput,
  ): Promise<readonly OrganizationSummary[]>;
  listProjects(
    subject: AuthenticatedUser,
    organizationId: string,
    input: ProjectAdminPageInput,
  ): Promise<readonly OrganizationProject[]>;
  createProject(
    subject: AuthenticatedUser,
    organizationId: string,
    idempotencyKey: string,
    input: CreateOrganizationProjectInput,
    context: Readonly<{ correlationId: string }>,
  ): Promise<OrganizationProject>;
}>;

type ProjectAdminRoute =
  | Readonly<{ kind: "organizations"; methods: readonly ["GET"] }>
  | Readonly<{ kind: "projects"; organizationId: string; methods: readonly ["GET", "POST"] }>;

type ProjectAdminProblem = Readonly<{
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

class ProjectAdminQueryError extends Error {
  readonly code = "PROJECT_ADMIN_QUERY_INVALID";
  constructor() {
    super("The Project Admin query parameters are invalid or unsupported.");
    this.name = "ProjectAdminQueryError";
  }
}

class ProjectIdempotencyKeyRequiredError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REQUIRED";
  constructor() {
    super("Project creation requires an Idempotency-Key from 1 to 200 characters.");
    this.name = "ProjectIdempotencyKeyRequiredError";
  }
}

class ProjectAdminRequestError extends Error {
  readonly code = "PROJECT_ADMIN_REQUEST_INVALID";
  constructor() {
    super("This Project Admin request must not include a request body.");
    this.name = "ProjectAdminRequestError";
  }
}

const cursorSchema = z.object({
  created_at: z.string().datetime({ offset: true }),
  id: z.uuid(),
}).strict();
const createProjectSchema = z.object({
  slug: z.string().trim().min(1),
  name: z.string().trim().min(1),
}).strict();

function matchRoute(path: string): ProjectAdminRoute | null {
  if (path === "/v1/organizations") return { kind: "organizations", methods: ["GET"] };
  const matched = new RegExp(`^/v1/organizations/${uuidPath}/projects$`, "u").exec(path);
  const organizationId = matched?.[1];
  return organizationId === undefined
    ? null
    : { kind: "projects", organizationId, methods: ["GET", "POST"] };
}

function accessToken(request: WorkerHttpRequest): string {
  const authorization = controlPlaneHeader(request, "authorization");
  const matched = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/iu.exec(
    authorization ?? "",
  );
  if (matched?.[1] === undefined) throw new AccessTokenAuthenticationError();
  return matched[1];
}

function pageInput(query: string): ProjectAdminPageInput {
  const parameters = new URLSearchParams(query);
  for (const key of parameters.keys()) {
    if (key !== "cursor" && key !== "limit") throw new ProjectAdminQueryError();
  }
  const limits = parameters.getAll("limit");
  if (limits.length > 1 || (limits[0] !== undefined && !/^[1-9][0-9]*$/u.test(limits[0]))) {
    throw new ProjectAdminQueryError();
  }
  const limit = limits[0] === undefined ? 50 : Number(limits[0]);
  if (!Number.isSafeInteger(limit) || limit > 100) throw new ProjectAdminQueryError();
  const cursors = parameters.getAll("cursor");
  if (cursors.length > 1) throw new ProjectAdminQueryError();
  if (cursors[0] === undefined) return { before: null, limit };
  const encoded = cursors[0];
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || encoded.length > 512) {
    throw new ProjectAdminQueryError();
  }
  try {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) throw new ProjectAdminQueryError();
    const parsed = cursorSchema.parse(JSON.parse(decoded.toString("utf8")) as unknown);
    return { before: { createdAt: new Date(parsed.created_at), id: parsed.id }, limit };
  } catch (error) {
    if (error instanceof ProjectAdminQueryError) throw error;
    throw new ProjectAdminQueryError();
  }
}

function idempotencyKey(request: WorkerHttpRequest): string {
  const value = controlPlaneHeader(request, "idempotency-key");
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0 || normalized.length > 200) {
    throw new ProjectIdempotencyKeyRequiredError();
  }
  return normalized;
}

function requestHasBody(request: WorkerHttpRequest): boolean {
  if (request.body !== null) return true;
  if (Object.keys(request.headers).some((name) => name.toLowerCase() === "transfer-encoding")) {
    return true;
  }
  const contentLengths = Object.entries(request.headers)
    .filter(([name]) => name.toLowerCase() === "content-length");
  return contentLengths.length > 0 &&
    (contentLengths.length !== 1 || contentLengths[0]?.[1] !== "0");
}

function encodedCursor(item: Readonly<{ createdAt: Date; id: string }>): string {
  return Buffer.from(JSON.stringify({
    created_at: item.createdAt.toISOString(),
    id: item.id,
  })).toString("base64url");
}

function organizationWire(item: OrganizationSummary): Record<string, unknown> {
  return {
    id: item.id,
    slug: item.slug,
    name: item.name,
    kind: item.kind,
    role: item.role,
    created_at: item.createdAt.toISOString(),
  };
}

function projectWire(item: OrganizationProject): Record<string, unknown> {
  return {
    id: item.id,
    organization_id: item.organizationId,
    slug: item.slug,
    name: item.name,
    created_at: item.createdAt.toISOString(),
  };
}

function response(
  status: number,
  requestId: string,
  body: unknown | null,
  headers: Readonly<Record<string, string>> = {},
): WorkerHttpResponse {
  return {
    status,
    headers: Object.freeze({
      "x-request-id": requestId,
      "cache-control": "no-store",
      ...(body === null ? {} : { "content-type": "application/json" }),
      ...headers,
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
  errors?: ProjectAdminProblem["errors"],
): WorkerHttpResponse {
  const body: ProjectAdminProblem = {
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
      "cache-control": "no-store",
      ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
    }),
    body,
  };
}

function listResponse<T extends Readonly<{ createdAt: Date; id: string }>>(
  requestId: string,
  field: "organizations" | "projects",
  records: readonly T[],
  input: ProjectAdminPageInput,
  wire: (record: T) => Record<string, unknown>,
): WorkerHttpResponse {
  const hasMore = records.length > input.limit;
  const items = records.slice(0, input.limit);
  return response(200, requestId, {
    request_id: requestId,
    [field]: items.map(wire),
    pagination: {
      next_cursor: hasMore && items.at(-1) !== undefined ? encodedCursor(items.at(-1)!) : null,
      has_more: hasMore,
      limit: input.limit,
    },
  });
}

export class ProjectAdminHttpApi {
  static readonly routerOperations = projectAdminRouterOperations;
  private readonly requestId: () => string;

  constructor(
    private readonly services: ProjectAdminHttpServices,
    private readonly apiKeys: Pick<ProjectApiKeyHttpApi, "handle">,
    dependencies: Readonly<{ requestId?: () => string }> = {},
  ) {
    this.requestId = dependencies.requestId ?? randomUUID;
  }

  async handle(request: WorkerHttpRequest): Promise<WorkerHttpResponse> {
    const requestId = this.requestId();
    const route = matchRoute(request.path);
    if (route === null) {
      if (projectApiKeyRouteDefinitions.some(({ pattern }) => pattern.test(request.path))) {
        return this.apiKeys.handle(request);
      }
      return problem(request, requestId, 404, "PROJECT_ADMIN_ROUTE_NOT_FOUND", "Not Found",
        "The Project Admin route does not exist.");
    }
    const method = request.method.toUpperCase();
    if (!route.methods.some((allowed) => allowed === method)) {
      const result = problem(request, requestId, 405, "PROJECT_ADMIN_METHOD_NOT_ALLOWED",
        "Method Not Allowed", "The Project Admin route does not accept this method.");
      return { ...result, headers: { ...result.headers, allow: route.methods.join(", ") } };
    }

    try {
      if (method === "GET" && requestHasBody(request)) throw new ProjectAdminRequestError();
      const subject = await this.services.authenticateAccessToken(accessToken(request));
      if (method === "GET") {
        const input = pageInput(request.query ?? "");
        if (route.kind === "organizations") {
          const organizations = await this.services.listOrganizations(subject, {
            before: input.before,
            limit: input.limit + 1,
          });
          return listResponse(requestId, "organizations", organizations, input, organizationWire);
        }
        const projects = await this.services.listProjects(subject, route.organizationId, {
          before: input.before,
          limit: input.limit + 1,
        });
        return listResponse(requestId, "projects", projects, input, projectWire);
      }
      if (route.kind !== "projects") {
        throw new Error("The Project Admin route method is inconsistent.");
      }
      if ((request.query ?? "") !== "") throw new ProjectAdminQueryError();
      if (!isJsonControlPlaneRequest(request)) {
        return problem(request, requestId, 415, "PROJECT_ADMIN_MEDIA_TYPE_UNSUPPORTED",
          "Unsupported Media Type", "Project creation requires application/json.");
      }
      const key = idempotencyKey(request);
      const input = createProjectSchema.parse(request.body);
      const project = await this.services.createProject(
        subject,
        route.organizationId,
        key,
        input,
        { correlationId: requestId },
      );
      return response(201, requestId, {
        request_id: requestId,
        project: projectWire(project),
      });
    } catch (error) {
      return this.errorResponse(request, requestId, error);
    }
  }

  private errorResponse(
    request: WorkerHttpRequest,
    requestId: string,
    error: unknown,
  ): WorkerHttpResponse {
    if (error instanceof AccessTokenAuthenticationError) {
      return problem(request, requestId, 401, error.code, "Access Token Invalid", error.message);
    }
    if (error instanceof ProjectAdminOrganizationNotFoundError) {
      return problem(request, requestId, 404, error.code, "Organization Not Found", error.message);
    }
    if (error instanceof ProjectAdminAccessDeniedError) {
      return problem(request, requestId, 403, error.code, "Forbidden", error.message);
    }
    if (error instanceof ProjectAdminSlugConflictError ||
        error instanceof ProjectCreationIdempotencyConflictError) {
      return problem(request, requestId, 409, error.code, "Project Creation Conflict", error.message);
    }
    if (error instanceof ProjectIdempotencyKeyRequiredError) {
      return problem(request, requestId, 400, error.code, "Idempotency Key Required", error.message);
    }
    if (error instanceof ProjectAdminRequestError) {
      return problem(request, requestId, 400, error.code, "Project Admin Request Invalid",
        error.message);
    }
    if (error instanceof ProjectAdminQueryError) {
      return problem(request, requestId, 400, error.code, "Project Admin Query Invalid", error.message);
    }
    if (error instanceof ZodError) {
      return problem(request, requestId, 422, "PROJECT_REQUEST_INVALID", "Project Request Invalid",
        "The Project request body failed validation.", error.issues.map((issue) => ({
          field: issue.path.length === 0 ? "body" : issue.path.join("."),
          message: issue.message,
        })));
    }
    return problem(request, requestId, 500, "INTERNAL_ERROR", "Internal Server Error",
      "The Project Admin request could not be completed.");
  }
}
