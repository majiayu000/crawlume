import { randomUUID } from "node:crypto";

import { z, ZodError } from "zod";

import {
  AccessTokenAuthenticationError,
  type OidcSessionService,
} from "./oidc-session-service.js";
import {
  ProjectApiKeyNotFoundError,
  type CreatedProjectApiKey,
  type CreateProjectApiKeyInput,
  type ProjectApiKeyMetadata,
} from "./api-key-service.js";
import { OrganizationAccessDeniedError, type AuditContext } from "./organization-authorization.js";
import type { ProjectApiKeyCursor } from "./project-api-key-management.js";
import {
  controlPlaneHeader,
  isJsonControlPlaneRequest,
} from "./project-http-api.js";
import {
  ProjectAccessDeniedError,
  type AuthenticatedUser,
  type ProjectScope,
} from "./project-scope.js";
import { projectApiKeyRouteDefinitions } from "./router-contract.js";
import type { WorkerHttpRequest, WorkerHttpResponse } from "./organization-service.js";

type ProjectApiKeyHttpServices = Readonly<{
  authenticateAccessToken: OidcSessionService["verifyAccessToken"];
  resolveScope(subject: AuthenticatedUser, projectId: string): Promise<ProjectScope>;
  create(
    scope: ProjectScope,
    input: CreateProjectApiKeyInput,
    context: AuditContext,
  ): Promise<CreatedProjectApiKey>;
  list(
    scope: ProjectScope,
    input: Readonly<{ limit: number; before: ProjectApiKeyCursor | null }>,
  ): Promise<readonly ProjectApiKeyMetadata[]>;
  revoke(
    scope: ProjectScope,
    keyId: string,
    context: AuditContext,
  ): Promise<ProjectApiKeyMetadata>;
}>;

type ProjectApiKeyHttpDependencies = Readonly<{
  now?: () => Date;
  requestId?: () => string;
}>;

type ApiKeyRoute =
  | Readonly<{ kind: "collection"; projectId: string; methods: readonly ("GET" | "POST")[] }>
  | Readonly<{ kind: "item"; projectId: string; keyId: string; methods: readonly ["DELETE"] }>;

type ApiKeyProblem = Readonly<{
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

class ProjectApiKeyQueryError extends Error {
  readonly code = "API_KEY_QUERY_INVALID";
  constructor() {
    super("The API Key query parameters are invalid or unsupported.");
    this.name = "ProjectApiKeyQueryError";
  }
}

class ProjectApiKeyInputError extends Error {
  readonly code = "API_KEY_REQUEST_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "ProjectApiKeyInputError";
  }
}

const createBodySchema = z.object({
  scopes: z.array(z.enum(["tasks:write", "results:read", "project:admin"]))
    .min(1)
    .max(3)
    .refine((scopes) => new Set(scopes).size === scopes.length, "Scopes must be unique."),
  expires_at: z.string().datetime({ offset: true }).nullable(),
}).strict();
const cursorSchema = z.object({
  created_at: z.string().datetime({ offset: true }),
  id: z.uuid(),
}).strict();

function matchRoute(path: string): ApiKeyRoute | null {
  for (const definition of projectApiKeyRouteDefinitions) {
    const matched = definition.pattern.exec(path);
    const projectId = matched?.[1];
    if (projectId === undefined) continue;
    if (definition.kind === "collection") {
      return { kind: definition.kind, projectId, methods: definition.methods };
    }
    const keyId = matched?.[2];
    if (keyId !== undefined) {
      return { kind: definition.kind, projectId, keyId, methods: definition.methods };
    }
  }
  return null;
}

function accessToken(request: WorkerHttpRequest): string {
  const authorization = controlPlaneHeader(request, "authorization");
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/iu.exec(
    authorization ?? "",
  );
  if (match?.[1] === undefined) throw new AccessTokenAuthenticationError();
  return match[1];
}

function listInput(query: string): { before: ProjectApiKeyCursor | null; limit: number } {
  const parameters = new URLSearchParams(query);
  for (const key of parameters.keys()) {
    if (key !== "cursor" && key !== "limit") throw new ProjectApiKeyQueryError();
  }
  const limits = parameters.getAll("limit");
  if (limits.length > 1 || (limits[0] !== undefined && !/^[1-9][0-9]*$/u.test(limits[0]))) {
    throw new ProjectApiKeyQueryError();
  }
  const limit = limits[0] === undefined ? 50 : Number(limits[0]);
  if (!Number.isSafeInteger(limit) || limit > 100) throw new ProjectApiKeyQueryError();
  const cursors = parameters.getAll("cursor");
  if (cursors.length > 1) throw new ProjectApiKeyQueryError();
  if (cursors[0] === undefined) return { before: null, limit };
  const encoded = cursors[0];
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || encoded.length > 512) {
    throw new ProjectApiKeyQueryError();
  }
  try {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) throw new ProjectApiKeyQueryError();
    const parsed = cursorSchema.parse(JSON.parse(decoded.toString("utf8")) as unknown);
    return { before: { createdAt: new Date(parsed.created_at), id: parsed.id }, limit };
  } catch (error) {
    if (error instanceof ProjectApiKeyQueryError) throw error;
    throw new ProjectApiKeyQueryError();
  }
}

function cursor(metadata: ProjectApiKeyMetadata): string {
  return Buffer.from(JSON.stringify({
    created_at: metadata.createdAt.toISOString(),
    id: metadata.id,
  })).toString("base64url");
}

function wireMetadata(metadata: ProjectApiKeyMetadata): Record<string, unknown> {
  return {
    id: metadata.id,
    display_prefix: metadata.displayPrefix,
    scopes: metadata.scopes,
    created_by_user_id: metadata.createdByUserId,
    created_at: metadata.createdAt.toISOString(),
    last_used_at: metadata.lastUsedAt?.toISOString() ?? null,
    expires_at: metadata.expiresAt?.toISOString() ?? null,
    revoked_at: metadata.revokedAt?.toISOString() ?? null,
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
  errors?: ApiKeyProblem["errors"],
): WorkerHttpResponse {
  const body: ApiKeyProblem = {
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
  return response(status, requestId, body, status === 401 ? { "www-authenticate": "Bearer" } : {});
}

export class ProjectApiKeyHttpApi {
  private readonly now: () => Date;
  private readonly requestId: () => string;

  constructor(
    private readonly services: ProjectApiKeyHttpServices,
    dependencies: ProjectApiKeyHttpDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.requestId = dependencies.requestId ?? randomUUID;
  }

  async handle(request: WorkerHttpRequest): Promise<WorkerHttpResponse> {
    const requestId = this.requestId();
    const route = matchRoute(request.path);
    if (route === null) {
      return problem(request, requestId, 404, "API_KEY_ROUTE_NOT_FOUND", "Not Found",
        "The API Key management route does not exist.");
    }
    const method = request.method.toUpperCase();
    if (!route.methods.some((allowed) => allowed === method)) {
      const result = problem(request, requestId, 405, "API_KEY_METHOD_NOT_ALLOWED",
        "Method Not Allowed", "The API Key management route does not accept this method.");
      return { ...result, headers: { ...result.headers, allow: route.methods.join(", ") } };
    }

    try {
      const subject = await this.services.authenticateAccessToken(accessToken(request));
      const scope = await this.services.resolveScope(subject, route.projectId);
      const context: AuditContext = { correlationId: requestId };
      if (route.kind === "item") {
        if ((request.query ?? "") !== "") throw new ProjectApiKeyQueryError();
        await this.services.revoke(scope, route.keyId, context);
        return response(204, requestId, null);
      }
      if (method === "GET") {
        const input = listInput(request.query ?? "");
        const metadata = await this.services.list(scope, {
          before: input.before,
          limit: input.limit + 1,
        });
        const hasMore = metadata.length > input.limit;
        const items = metadata.slice(0, input.limit);
        return response(200, requestId, {
          request_id: requestId,
          api_keys: items.map(wireMetadata),
          pagination: {
            next_cursor: hasMore && items.at(-1) !== undefined ? cursor(items.at(-1)!) : null,
            has_more: hasMore,
            limit: input.limit,
          },
        });
      }
      if ((request.query ?? "") !== "") throw new ProjectApiKeyQueryError();
      if (!isJsonControlPlaneRequest(request)) {
        return problem(request, requestId, 415, "API_KEY_MEDIA_TYPE_UNSUPPORTED",
          "Unsupported Media Type", "API Key creation requires application/json.");
      }
      const parsed = createBodySchema.parse(request.body);
      const expiresAt = parsed.expires_at === null ? null : new Date(parsed.expires_at);
      if (expiresAt !== null && expiresAt.getTime() <= this.now().getTime()) {
        throw new ProjectApiKeyInputError("expires_at must be in the future.");
      }
      const created = await this.services.create(scope, {
        scopes: parsed.scopes,
        expiresAt,
      }, context);
      return response(201, requestId, {
        request_id: requestId,
        api_key: wireMetadata(created.apiKey),
        secret: created.rawKey,
      }, { location: `/v1/projects/${scope.projectId}/api-keys/${created.apiKey.id}` });
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
    if (error instanceof ProjectAccessDeniedError || error instanceof OrganizationAccessDeniedError) {
      return problem(request, requestId, 403, "API_KEY_MANAGEMENT_FORBIDDEN", "Forbidden",
        "The authenticated user cannot manage API Keys in this Project.");
    }
    if (error instanceof ProjectApiKeyNotFoundError) {
      return problem(request, requestId, 404, error.code, "API Key Not Found", error.message);
    }
    if (error instanceof ProjectApiKeyQueryError) {
      return problem(request, requestId, 400, error.code, "API Key Query Invalid", error.message);
    }
    if (error instanceof ZodError) {
      return problem(request, requestId, 422, "API_KEY_REQUEST_INVALID",
        "API Key Request Invalid", "The API Key request body failed validation.",
        error.issues.map((issue) => ({
          field: issue.path.length === 0 ? "body" : issue.path.join("."),
          message: issue.message,
        })));
    }
    if (error instanceof ProjectApiKeyInputError) {
      return problem(request, requestId, 422, error.code, "API Key Request Invalid", error.message);
    }
    return problem(request, requestId, 500, "INTERNAL_ERROR", "Internal Server Error",
      "The API Key management request could not be completed.");
  }
}
