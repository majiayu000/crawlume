import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { AccessTokenAuthenticationError } from "../src/control-plane/oidc-session-service.js";
import {
  createOrganizationProject,
  listOrganizationProjects,
  listOrganizations,
  ProjectAdminAccessDeniedError,
  ProjectAdminOrganizationNotFoundError,
  ProjectAdminSlugConflictError,
  ProjectCreationIdempotencyConflictError,
  type OrganizationProject,
  type OrganizationSummary,
} from "../src/control-plane/project-admin-management.js";
import { ProjectAdminHttpApi } from "../src/control-plane/project-admin-http-api.js";
import type {
  ControlPlaneDatabase,
  ControlPlaneQuery,
} from "../src/control-plane/project-scope.js";
import type { WorkerHttpRequest } from "../src/control-plane/organization-service.js";

const userId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const secondId = "44444444-4444-4444-8444-444444444444";
const requestId = "55555555-5555-4555-8555-555555555555";
const token = "aaa.bbb.ccc";
const createdAt = new Date("2026-09-03T01:00:00.000Z");
const auditContext = Object.freeze({ correlationId: requestId });

type QueryCall = Readonly<{ statement: string; parameters: readonly unknown[] }>;
type QueryResponse = Readonly<{ rows: unknown[] }>;

class ScriptedDatabase implements ControlPlaneDatabase {
  readonly calls: QueryCall[] = [];
  transactions = 0;

  constructor(private readonly responses: QueryResponse[]) {}

  async transaction<Result>(
    operation: (transaction: ControlPlaneQuery) => Promise<Result>,
  ): Promise<Result> {
    this.transactions += 1;
    return operation(this);
  }

  async query<Row>(statement: string, parameters: readonly unknown[]): Promise<{ rows: Row[] }> {
    this.calls.push({ statement, parameters });
    const response = this.responses.shift();
    if (response === undefined) throw new Error("Unexpected Project Admin query.");
    return response as { rows: Row[] };
  }
}

function organization(overrides: Partial<OrganizationSummary> = {}): OrganizationSummary {
  return Object.freeze({
    id: organizationId,
    slug: "personal-user",
    name: "Personal",
    kind: "personal",
    role: "owner",
    createdAt,
    ...overrides,
  });
}

function project(overrides: Partial<OrganizationProject> = {}): OrganizationProject {
  return Object.freeze({
    id: projectId,
    organizationId,
    slug: "default",
    name: "Default",
    createdAt,
    ...overrides,
  });
}

function request(overrides: Partial<WorkerHttpRequest> = {}): WorkerHttpRequest {
  return {
    method: "GET",
    path: "/v1/organizations",
    query: "",
    headers: { authorization: `Bearer ${token}` },
    body: null,
    ...overrides,
  };
}

type ServiceOverrides = Partial<ConstructorParameters<typeof ProjectAdminHttpApi>[0]>;

function httpHarness(overrides: ServiceOverrides = {}) {
  const authenticateAccessToken = vi.fn(async () => ({ userId }));
  const listOrganizationsService = vi.fn(async () => [organization()]);
  const listProjects = vi.fn(async () => [project()]);
  const createProject = vi.fn(async () => project({ slug: "research", name: "Research" }));
  const apiKeyResponse = Object.freeze({ status: 204, headers: {}, body: null });
  const apiKeyHandle = vi.fn(async () => apiKeyResponse);
  const api = new ProjectAdminHttpApi({
    authenticateAccessToken,
    listOrganizations: listOrganizationsService,
    listProjects,
    createProject,
    ...overrides,
  }, { handle: apiKeyHandle }, { requestId: () => requestId });
  return {
    api,
    authenticateAccessToken,
    listOrganizations: listOrganizationsService,
    listProjects,
    createProject,
    apiKeyHandle,
    apiKeyResponse,
  };
}

describe("Project Admin HTTP API", () => {
  it("publishes the approved Organization, Project, and API Key routes", () => {
    expect(ProjectAdminHttpApi.routerOperations).toEqual([
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
      {
        method: "POST",
        path: "/projects/{project_id}/api-keys",
        operationId: "createProjectApiKey",
      },
      {
        method: "GET",
        path: "/projects/{project_id}/api-keys",
        operationId: "listProjectApiKeys",
      },
      {
        method: "DELETE",
        path: "/projects/{project_id}/api-keys/{key_id}",
        operationId: "revokeProjectApiKey",
      },
    ]);
  });

  it("lists only the authenticated user's Organizations with an opaque cursor", async () => {
    const first = organization();
    const second = organization({ id: secondId, createdAt: new Date("2026-09-02T01:00:00Z") });
    const list = vi.fn(async () => [first, second]);
    const { api, authenticateAccessToken } = httpHarness({ listOrganizations: list });

    const result = await api.handle(request({
      query: "?limit=1",
      headers: { authorization: `bEaReR ${token}` },
    }));

    expect(result).toMatchObject({
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        request_id: requestId,
        organizations: [{ id: organizationId, role: "owner" }],
        pagination: { has_more: true, limit: 1 },
      },
    });
    expect(authenticateAccessToken).toHaveBeenCalledWith(token);
    expect(list).toHaveBeenCalledWith({ userId }, { before: null, limit: 2 });
    const body = result.body as { pagination: { next_cursor: string } };
    expect(JSON.parse(Buffer.from(body.pagination.next_cursor, "base64url").toString("utf8")))
      .toEqual({ created_at: createdAt.toISOString(), id: organizationId });
  });

  it("lists an accessible Organization's Projects for a member", async () => {
    const { api, listProjects } = httpHarness();
    const result = await api.handle(request({
      path: `/v1/organizations/${organizationId}/projects`,
    }));

    expect(result).toMatchObject({
      status: 200,
      body: {
        projects: [{ id: projectId, organization_id: organizationId }],
        pagination: { has_more: false, limit: 50 },
      },
    });
    expect(listProjects).toHaveBeenCalledWith(
      { userId },
      organizationId,
      { before: null, limit: 51 },
    );
  });

  it("trims required idempotency and creates a Project without a dead Location", async () => {
    const { api, createProject } = httpHarness();
    const result = await api.handle(request({
      method: "POST",
      path: `/v1/organizations/${organizationId}/projects`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "  create-research  ",
      },
      body: { slug: "research", name: "Research" },
    }));

    expect(result).toMatchObject({
      status: 201,
      body: { project: { id: projectId, slug: "research", name: "Research" } },
    });
    expect(result.headers).not.toHaveProperty("location");
    expect(createProject).toHaveBeenCalledWith(
      { userId },
      organizationId,
      "create-research",
      { slug: "research", name: "Research" },
      auditContext,
    );

    const missing = await api.handle(request({
      method: "POST",
      path: `/v1/organizations/${organizationId}/projects`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { slug: "research", name: "Research" },
    }));
    expect(missing).toMatchObject({ status: 400, body: { code: "IDEMPOTENCY_KEY_REQUIRED" } });

    const tooLong = await api.handle(request({
      method: "POST",
      path: `/v1/organizations/${organizationId}/projects`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": ` ${"x".repeat(201)} `,
      },
      body: { slug: "research", name: "Research" },
    }));
    expect(tooLong).toMatchObject({ status: 400, body: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
  });

  it("fails closed for invalid identity, inaccessible Organizations, and member writes", async () => {
    const invalid = httpHarness({
      authenticateAccessToken: vi.fn(async () => { throw new AccessTokenAuthenticationError(); }),
    });
    await expect(invalid.api.handle(request())).resolves.toMatchObject({
      status: 401,
      headers: { "www-authenticate": "Bearer", "content-type": "application/problem+json" },
      body: { code: "ACCESS_TOKEN_INVALID" },
    });

    const hidden = httpHarness({
      listProjects: vi.fn(async () => { throw new ProjectAdminOrganizationNotFoundError(); }),
    });
    await expect(hidden.api.handle(request({
      path: `/v1/organizations/${organizationId}/projects`,
    }))).resolves.toMatchObject({ status: 404, body: { code: "ORGANIZATION_NOT_FOUND" } });

    const denied = httpHarness({
      createProject: vi.fn(async () => { throw new ProjectAdminAccessDeniedError(); }),
    });
    await expect(denied.api.handle(request({
      method: "POST",
      path: `/v1/organizations/${organizationId}/projects`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "member-write",
      },
      body: { slug: "research", name: "Research" },
    }))).resolves.toMatchObject({ status: 403, body: { code: "PROJECT_ADMIN_FORBIDDEN" } });
  });

  it("maps query, media, body, conflicts, and unknown failures visibly", async () => {
    const { api } = httpHarness();
    await expect(api.handle(request({ query: "?offset=1" }))).resolves.toMatchObject({
      status: 400,
      body: { code: "PROJECT_ADMIN_QUERY_INVALID" },
    });
    await expect(api.handle(request({
      method: "POST",
      path: `/v1/organizations/${organizationId}/projects`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "create" },
    }))).resolves.toMatchObject({ status: 415 });
    await expect(api.handle(request({
      method: "POST",
      path: `/v1/organizations/${organizationId}/projects`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "create",
      },
      body: { slug: " ", name: "Research" },
    }))).resolves.toMatchObject({ status: 422, body: { code: "PROJECT_REQUEST_INVALID" } });

    for (const [failure, code] of [
      [new ProjectAdminSlugConflictError(), "PROJECT_SLUG_CONFLICT"],
      [new ProjectCreationIdempotencyConflictError(), "PROJECT_IDEMPOTENCY_CONFLICT"],
    ] as const) {
      const failed = httpHarness({ createProject: vi.fn(async () => { throw failure; }) });
      await expect(failed.api.handle(request({
        method: "POST",
        path: `/v1/organizations/${organizationId}/projects`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": "create",
        },
        body: { slug: "research", name: "Research" },
      }))).resolves.toMatchObject({ status: 409, body: { code } });
    }

    const failed = httpHarness({ listOrganizations: vi.fn(async () => { throw new Error("secret"); }) });
    const internal = await failed.api.handle(request());
    expect(internal).toMatchObject({ status: 500, body: { code: "INTERNAL_ERROR" } });
    expect(JSON.stringify(internal)).not.toContain("secret");
  });

  it("delegates existing API Key management routes without authenticating twice", async () => {
    const { api, apiKeyHandle, apiKeyResponse, authenticateAccessToken } = httpHarness();
    const apiKeyRequest = request({
      method: "DELETE",
      path: `/v1/projects/${projectId}/api-keys/${secondId}`,
    });
    await expect(api.handle(apiKeyRequest)).resolves.toBe(apiKeyResponse);
    expect(apiKeyHandle).toHaveBeenCalledWith(apiKeyRequest);
    expect(authenticateAccessToken).not.toHaveBeenCalled();
  });
});

describe("Project Admin management", () => {
  it("lists only memberships with stable Organization keyset ordering", async () => {
    const database = new ScriptedDatabase([{ rows: [{
      id: organizationId,
      slug: "personal-user",
      name: "Personal",
      kind: "personal",
      role: "member",
      created_at: createdAt,
    }] }]);
    const before = { createdAt: new Date("2026-09-04T00:00:00Z"), id: secondId };

    await expect(listOrganizations(database, { userId }, { before, limit: 51 }))
      .resolves.toEqual([organization({ role: "member" })]);
    expect(database.calls[0]?.statement).toContain("organization_memberships.user_id = $1");
    expect(database.calls[0]?.statement).toContain("ORDER BY organizations.created_at DESC");
    expect(database.calls[0]?.parameters).toEqual([userId, before.createdAt, secondId, 51]);
  });

  it("allows members to list Projects while preserving the membership join", async () => {
    const database = new ScriptedDatabase([
      { rows: [{ role: "member" }] },
      { rows: [{
        id: projectId,
        organization_id: organizationId,
        slug: "default",
        name: "Default",
        created_at: createdAt,
      }] },
    ]);

    await expect(listOrganizationProjects(
      database,
      { userId },
      organizationId,
      { before: null, limit: 51 },
    )).resolves.toEqual([project()]);
    expect(database.calls[1]?.statement).toContain("organization_memberships.user_id = $2");
    expect(database.calls[1]?.parameters).toEqual([organizationId, userId, null, null, 51]);
  });

  it("creates and audits one Project before binding the idempotency record", async () => {
    const database = new ScriptedDatabase([
      { rows: [{ id: organizationId, role: "admin" }] },
      { rows: [] },
      { rows: [{
        id: projectId,
        organization_id: organizationId,
        slug: "research",
        name: "Research",
        created_at: createdAt,
      }] },
      { rows: [{ id: "audit-a" }] },
      { rows: [] },
    ]);

    await expect(createOrganizationProject(
      database,
      { userId },
      organizationId,
      "  create-research  ",
      { slug: "research", name: "Research" },
      auditContext,
    )).resolves.toEqual(project({ slug: "research", name: "Research" }));
    expect(database.transactions).toBe(1);
    expect(database.calls[0]?.statement).toContain("FOR UPDATE OF organizations");
    expect(database.calls[2]?.parameters[1]).toBe(organizationId);
    expect(database.calls[3]?.parameters.slice(3)).toEqual([
      "user",
      userId,
      "project.created",
      "project",
      projectId,
      "succeeded",
      requestId,
    ]);
    expect(database.calls[4]?.statement).toContain("project_creation_idempotency");
    expect(database.calls[4]?.parameters.slice(0, 2)).toEqual([
      organizationId,
      "create-research",
    ]);
  });

  it("replays the same Project and rejects a different payload for the same key", async () => {
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ slug: "research", name: "Research" }))
      .digest();
    const replayDatabase = new ScriptedDatabase([
      { rows: [{ id: organizationId, role: "owner" }] },
      { rows: [{ request_hash: requestHash, project_id: projectId }] },
      { rows: [{
        id: projectId,
        organization_id: organizationId,
        slug: "research",
        name: "Research",
        created_at: createdAt,
      }] },
    ]);
    await expect(createOrganizationProject(
      replayDatabase,
      { userId },
      organizationId,
      "create-research",
      { slug: "research", name: "Research" },
      auditContext,
    )).resolves.toEqual(project({ slug: "research", name: "Research" }));
    expect(replayDatabase.calls).toHaveLength(3);

    const conflictDatabase = new ScriptedDatabase([
      { rows: [{ id: organizationId, role: "owner" }] },
      { rows: [{ request_hash: Buffer.alloc(32, 7), project_id: projectId }] },
    ]);
    await expect(createOrganizationProject(
      conflictDatabase,
      { userId },
      organizationId,
      "create-research",
      { slug: "different", name: "Different" },
      auditContext,
    )).rejects.toEqual(new ProjectCreationIdempotencyConflictError());
  });

  it("hides absent memberships and denies member Project creation", async () => {
    const hidden = new ScriptedDatabase([{ rows: [] }]);
    await expect(listOrganizationProjects(
      hidden,
      { userId },
      organizationId,
      { before: null, limit: 50 },
    )).rejects.toEqual(new ProjectAdminOrganizationNotFoundError());

    const member = new ScriptedDatabase([{ rows: [{ id: organizationId, role: "member" }] }]);
    await expect(createOrganizationProject(
      member,
      { userId },
      organizationId,
      "create-research",
      { slug: "research", name: "Research" },
      auditContext,
    )).rejects.toEqual(new ProjectAdminAccessDeniedError());
    expect(member.calls).toHaveLength(1);
  });
});
