import { describe, expect, it, vi } from "vitest";

import {
  AccessTokenAuthenticationError,
} from "../src/control-plane/oidc-session-service.js";
import {
  ProjectApiKeyNotFoundError,
  type ProjectApiKeyMetadata,
} from "../src/control-plane/api-key-service.js";
import { OrganizationAccessDeniedError } from "../src/control-plane/organization-authorization.js";
import { ProjectApiKeyHttpApi } from "../src/control-plane/project-api-key-http-api.js";
import { listProjectApiKeys } from "../src/control-plane/project-api-key-management.js";
import {
  resolveProjectScope,
  type ControlPlaneDatabase,
  type ControlPlaneQuery,
  type ProjectScope,
} from "../src/control-plane/project-scope.js";
import type { WorkerHttpRequest } from "../src/control-plane/organization-service.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const keyId = "33333333-3333-4333-8333-333333333333";
const secondKeyId = "44444444-4444-4444-8444-444444444444";
const userId = "55555555-5555-4555-8555-555555555555";
const organizationId = "66666666-6666-4666-8666-666666666666";
const requestId = "77777777-7777-4777-8777-777777777777";
const token = "aaa.bbb.ccc";
const now = new Date("2026-09-02T08:00:00.000Z");
const createdAt = new Date("2026-09-01T08:00:00.000Z");

type QueryCall = Readonly<{ statement: string; parameters: readonly unknown[] }>;
type QueryResponse = Readonly<{ rows: unknown[] }>;

class ScriptedDatabase implements ControlPlaneDatabase {
  readonly calls: QueryCall[] = [];

  constructor(private readonly responses: QueryResponse[]) {}

  async transaction<Result>(
    operation: (transaction: ControlPlaneQuery) => Promise<Result>,
  ): Promise<Result> {
    return operation(this);
  }

  async query<Row>(statement: string, parameters: readonly unknown[]): Promise<{ rows: Row[] }> {
    this.calls.push({ statement, parameters });
    const response = this.responses.shift();
    if (response === undefined) throw new Error("Unexpected API Key management query.");
    return response as { rows: Row[] };
  }
}

async function scope(role: "owner" | "admin" | "member" = "admin"): Promise<ProjectScope> {
  return resolveProjectScope(new ScriptedDatabase([{ rows: [{
    project_id: projectId,
    organization_id: organizationId,
    role,
  }] }]), { userId }, projectId);
}

function metadata(overrides: Partial<ProjectApiKeyMetadata> = {}): ProjectApiKeyMetadata {
  return Object.freeze({
    id: keyId,
    projectId,
    displayPrefix: "dya_live_deadbeef",
    createdByUserId: userId,
    scopes: ["tasks:write", "results:read"] as const,
    createdAt,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  });
}

function request(overrides: Partial<WorkerHttpRequest> = {}): WorkerHttpRequest {
  return {
    method: "POST",
    path: `/v1/projects/${projectId}/api-keys`,
    query: "",
    headers: {
      authorization: `bEaReR ${token}`,
      "content-type": "application/json",
    },
    body: { scopes: ["tasks:write", "results:read"], expires_at: null },
    ...overrides,
  };
}

type ServiceOverrides = Partial<ConstructorParameters<typeof ProjectApiKeyHttpApi>[0]>;

async function harness(overrides: ServiceOverrides = {}) {
  const projectScope = await scope();
  const authenticateAccessToken = vi.fn(async () => ({ userId }));
  const resolveScope = vi.fn(async () => projectScope);
  const create = vi.fn(async () => ({ apiKey: metadata(), rawKey: "one-time-secret" }));
  const list = vi.fn(async () => [metadata()]);
  const revoke = vi.fn(async () => metadata({ revokedAt: now }));
  const api = new ProjectApiKeyHttpApi({
    authenticateAccessToken,
    resolveScope,
    create,
    list,
    revoke,
    ...overrides,
  }, { now: () => now, requestId: () => requestId });
  return { api, authenticateAccessToken, resolveScope, create, list, revoke, projectScope };
}

describe("Project API Key management HTTP API", () => {
  it("creates a Key through a human Access Token and returns its Secret once", async () => {
    const { api, authenticateAccessToken, resolveScope, create, projectScope } = await harness();
    const expiresAt = "2026-10-01T00:00:00.000Z";
    const result = await api.handle(request({
      body: { scopes: ["project:admin"], expires_at: expiresAt },
    }));

    expect(result).toMatchObject({
      status: 201,
      headers: {
        "cache-control": "no-store",
        location: `/v1/projects/${projectId}/api-keys/${keyId}`,
      },
      body: {
        request_id: requestId,
        api_key: { id: keyId, display_prefix: "dya_live_deadbeef" },
        secret: "one-time-secret",
      },
    });
    expect(authenticateAccessToken).toHaveBeenCalledWith(token);
    expect(resolveScope).toHaveBeenCalledWith({ userId }, projectId);
    expect(create).toHaveBeenCalledWith(projectScope, {
      scopes: ["project:admin"],
      expiresAt: new Date(expiresAt),
    }, { correlationId: requestId });
  });

  it("lists only metadata with an opaque stable cursor", async () => {
    const first = metadata();
    const second = metadata({ id: secondKeyId, createdAt: new Date("2026-08-31T08:00:00.000Z") });
    const list = vi.fn(async () => [first, second]);
    const { api, projectScope } = await harness({ list });
    const result = await api.handle(request({ method: "GET", query: "?limit=1", body: null }));

    expect(result).toMatchObject({
      status: 200,
      headers: { "cache-control": "no-store" },
      body: {
        api_keys: [{ id: keyId }],
        pagination: { has_more: true, limit: 1 },
      },
    });
    expect(JSON.stringify(result.body)).not.toContain("one-time-secret");
    expect(list).toHaveBeenCalledWith(projectScope, { before: null, limit: 2 });
    const body = result.body as { pagination: { next_cursor: string } };
    expect(JSON.parse(Buffer.from(body.pagination.next_cursor, "base64url").toString("utf8")))
      .toEqual({ created_at: createdAt.toISOString(), id: keyId });
  });

  it("revokes a Project-bound Key with an empty 204 response", async () => {
    const { api, revoke, projectScope } = await harness();
    const result = await api.handle(request({
      method: "DELETE",
      path: `/v1/projects/${projectId}/api-keys/${keyId}`,
      headers: { authorization: `Bearer ${token}` },
      body: null,
    }));

    expect(result).toMatchObject({
      status: 204,
      headers: { "cache-control": "no-store" },
      body: null,
    });
    expect(result.headers).not.toHaveProperty("content-type");
    expect(revoke).toHaveBeenCalledWith(projectScope, keyId, { correlationId: requestId });
  });

  it("fails closed for invalid identity, membership, and unknown scoped Keys", async () => {
    const invalid = await harness({
      authenticateAccessToken: vi.fn(async () => { throw new AccessTokenAuthenticationError(); }),
    });
    await expect(invalid.api.handle(request())).resolves.toMatchObject({
      status: 401,
      headers: { "cache-control": "no-store", "www-authenticate": "Bearer" },
      body: { code: "ACCESS_TOKEN_INVALID" },
    });

    const denied = await harness({
      resolveScope: vi.fn(async () => { throw new OrganizationAccessDeniedError(); }),
    });
    await expect(denied.api.handle(request())).resolves.toMatchObject({
      status: 403,
      body: { code: "API_KEY_MANAGEMENT_FORBIDDEN" },
    });

    const missing = await harness({
      revoke: vi.fn(async () => { throw new ProjectApiKeyNotFoundError(); }),
    });
    await expect(missing.api.handle(request({
      method: "DELETE",
      path: `/v1/projects/${projectId}/api-keys/${keyId}`,
      headers: { authorization: `Bearer ${token}` },
      body: null,
    }))).resolves.toMatchObject({ status: 404, body: { code: "API_KEY_NOT_FOUND" } });
  });

  it("rejects unsupported methods, malformed queries, and invalid creation bodies", async () => {
    const { api, authenticateAccessToken } = await harness();
    await expect(api.handle(request({ method: "PATCH" }))).resolves.toMatchObject({
      status: 405,
      headers: { allow: "GET, POST", "cache-control": "no-store" },
    });

    for (const bodyRequest of [
      request({ method: "GET" }),
      request({
        method: "GET",
        headers: { authorization: `Bearer ${token}`, "transfer-encoding": "chunked" },
        body: null,
      }),
      request({
        method: "DELETE",
        path: `/v1/projects/${projectId}/api-keys/${keyId}`,
        headers: { authorization: `Bearer ${token}`, "content-length": "4" },
        body: null,
      }),
      request({
        method: "DELETE",
        path: `/v1/projects/${projectId}/api-keys/${keyId}`,
        headers: {
          authorization: `Bearer ${token}`,
          "Content-Length": "0",
          "content-length": "0",
        },
        body: null,
      }),
    ]) {
      await expect(api.handle(bodyRequest)).resolves.toMatchObject({
        status: 400,
        headers: { "cache-control": "no-store" },
        body: { code: "API_KEY_REQUEST_INVALID" },
      });
    }
    expect(authenticateAccessToken).not.toHaveBeenCalled();

    await expect(api.handle(request({ method: "GET", query: "?offset=1", body: null })))
      .resolves.toMatchObject({ status: 400, body: { code: "API_KEY_QUERY_INVALID" } });
    await expect(api.handle(request({ body: { scopes: [], expires_at: null } })))
      .resolves.toMatchObject({ status: 422, body: { code: "API_KEY_REQUEST_INVALID" } });
    await expect(api.handle(request({
      body: { scopes: ["tasks:write"], expires_at: "2026-01-01T00:00:00.000Z" },
    }))).resolves.toMatchObject({ status: 422, body: { code: "API_KEY_REQUEST_INVALID" } });
  });
});

describe("Project API Key metadata listing", () => {
  it("revalidates the admin role and binds the stable cursor to one Project", async () => {
    const before = { createdAt, id: keyId };
    const database = new ScriptedDatabase([
      { rows: [{ id: organizationId }] },
      { rows: [{ role: "admin" }] },
      { rows: [{
        id: secondKeyId,
        project_id: projectId,
        display_prefix: "dya_live_feedface",
        created_by_user_id: userId,
        tasks_write: true,
        results_read: false,
        project_admin: false,
        created_at: new Date("2026-08-31T08:00:00.000Z"),
        last_used_at: null,
        expires_at: null,
        revoked_at: null,
      }] },
    ]);

    await expect(listProjectApiKeys(database, await scope(), { before, limit: 51 }))
      .resolves.toEqual([expect.objectContaining({ id: secondKeyId, scopes: ["tasks:write"] })]);
    expect(database.calls[2]?.statement).toContain("ORDER BY created_at DESC, id DESC");
    expect(database.calls[2]?.parameters).toEqual([projectId, createdAt, keyId, 51]);
  });

  it("does not list metadata for a member", async () => {
    const database = new ScriptedDatabase([
      { rows: [{ id: organizationId }] },
      { rows: [{ role: "member" }] },
    ]);
    await expect(listProjectApiKeys(database, await scope("member"), { before: null, limit: 50 }))
      .rejects.toEqual(new OrganizationAccessDeniedError());
    expect(database.calls).toHaveLength(2);
  });
});
