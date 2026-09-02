import { describe, expect, it, vi } from "vitest";

import {
  ProjectApiKeyAuthenticationError,
  ProjectApiKeyScopeError,
  type AuthenticatedProjectApiKey,
} from "../src/control-plane/api-key-service.js";
import {
  ControlPlaneHttpApi,
  ProjectJobHttpApi,
} from "../src/control-plane/project-http-api.js";
import {
  JobIdempotencyConflictError,
  JobNotFoundError,
  JobTransitionError,
  type ControlPlaneJob,
} from "../src/control-plane/project-scope.js";
import type {
  AuditEvent,
  JobPublication,
} from "../src/control-plane/organization-authorization.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const requestId = "11111111-1111-4111-8111-111111111111";
const rawKey = `dya_live_deadbeef_${"A".repeat(43)}`;
const now = new Date("2026-09-02T08:00:00.000Z");

const identity: AuthenticatedProjectApiKey = Object.freeze({
  apiKeyId: "key-a",
  projectId,
  organizationId: "organization-a",
  createdByUserId: "user-a",
  scopes: ["tasks:write"] as const,
});

const job: ControlPlaneJob = Object.freeze({
  id: jobId,
  projectId,
  idempotencyKey: "request-a",
  type: "read",
  input: Object.freeze({ url: "https://example.com" }),
  dataClass: "public",
  placement: Object.freeze({ class: "public", pinnedWorkerId: null }),
  requiredCapabilities: Object.freeze({}),
  budget: Object.freeze({
    deadlineMs: 300_000,
    maxProviderAttempts: 2,
    maxDocumentBytes: 1_000_000,
    maxBrowserMs: 0,
    maxBrowserContexts: 0,
  }),
  policyVersion: "2026-09-02",
  uploadPrivateArtifact: false,
  priority: 0,
  notBefore: now,
  deadlineAt: new Date(now.getTime() + 300_000),
  envelopeHash: "hash",
  status: "queued",
  resultCompleteness: null,
  errorCode: null,
  createdAt: now,
  updatedAt: now,
  completedAt: null,
});
const publication: JobPublication = Object.freeze({
  id: "55555555-5555-4555-8555-555555555555",
  projectId,
  jobId,
  leaseId: "66666666-6666-4666-8666-666666666666",
  workerId: "77777777-7777-4777-8777-777777777777",
  leaseGeneration: 1,
  localSequence: 2,
  sequence: 3,
  completeness: "complete",
  recordedAt: now,
  artifact: Object.freeze({
    id: "88888888-8888-4888-8888-888888888888",
    projectId,
    jobId,
    version: 1,
    contentHash: "A".repeat(43),
    byteCount: 42,
    mediaType: "text/markdown",
    storage: "worker_local",
    objectKey: null,
    createdAt: now,
  }),
});
const auditEvent: AuditEvent = Object.freeze({
  id: "99999999-9999-4999-8999-999999999999",
  organizationId: "organization-a",
  projectId,
  actorType: "api_key",
  actorId: "key-a",
  action: "api_key.used",
  targetType: "api_key",
  targetId: "key-a",
  outcome: "succeeded",
  correlationId: requestId,
  occurredAt: now,
});

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "read",
    input: { url: "https://example.com" },
    data_class: "public",
    placement: { class: "public", pinned_worker_id: null },
    required_capabilities: {},
    budget: {
      deadline_ms: 300_000,
      max_provider_attempts: 2,
      max_document_bytes: 1_000_000,
      max_browser_ms: 0,
      max_browser_contexts: 0,
    },
    policy_version: "2026-09-02",
    upload_private_artifact: false,
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    method: "POST",
    path: `/v1/projects/${projectId}/jobs`,
    headers: {
      authorization: `Bearer ${rawKey}`,
      "content-type": "application/json",
      "idempotency-key": "request-a",
    },
    body: body(),
    ...overrides,
  };
}

function harness(options: Readonly<{
  authenticated?: AuthenticatedProjectApiKey | Error;
  created?: ControlPlaneJob | Error;
  found?: ControlPlaneJob | Error;
  cancelled?: ControlPlaneJob | Error;
  publications?: Readonly<{
    items: readonly JobPublication[];
    hasMore: boolean;
    nextSequence: number | null;
  }> | Error;
  auditEvents?: readonly AuditEvent[] | Error;
}> = {}) {
  const authenticate = vi.fn(async () => {
    if (options.authenticated instanceof Error) throw options.authenticated;
    return options.authenticated ?? identity;
  });
  const createJob = vi.fn(async () => {
    if (options.created instanceof Error) throw options.created;
    return options.created ?? job;
  });
  const getJob = vi.fn(async () => {
    if (options.found instanceof Error) throw options.found;
    return options.found ?? job;
  });
  const cancelJob = vi.fn(async () => {
    if (options.cancelled instanceof Error) throw options.cancelled;
    return options.cancelled ?? Object.freeze({ ...job, status: "cancelled" as const });
  });
  const listPublications = vi.fn(async () => {
    if (options.publications instanceof Error) throw options.publications;
    return options.publications ?? { items: [publication], hasMore: false, nextSequence: 3 };
  });
  const listAuditEvents = vi.fn(async () => {
    if (options.auditEvents instanceof Error) throw options.auditEvents;
    return options.auditEvents ?? [auditEvent];
  });
  return {
    api: new ProjectJobHttpApi(
      { authenticate, createJob, getJob, cancelJob, listPublications, listAuditEvents },
      { requestId: () => requestId },
    ),
    authenticate,
    createJob,
    getJob,
    cancelJob,
    listPublications,
    listAuditEvents,
  };
}

describe("Project Job HTTP API", () => {
  it("authenticates, scopes, and creates a Project-bound Job", async () => {
    const { api, authenticate, createJob } = harness();

    const response = await api.handle(request());

    expect(response.status).toBe(201);
    expect(response.headers).toMatchObject({
      "content-type": "application/json",
      "x-request-id": requestId,
      location: `/v1/projects/${projectId}/jobs/${jobId}`,
    });
    expect(response.body).toMatchObject({ request_id: requestId, job: { id: jobId } });
    expect(authenticate).toHaveBeenCalledWith(rawKey, { correlationId: requestId });
    expect(createJob).toHaveBeenCalledWith(identity, "request-a", expect.objectContaining({
      type: "read",
      dataClass: "public",
      placement: { class: "public", pinnedWorkerId: null },
    }), { correlationId: requestId });
  });

  it("reads a Job with results:read and keeps the lookup Project-scoped", async () => {
    const readable = Object.freeze({ ...identity, scopes: ["results:read"] as const });
    const { api, getJob } = harness({ authenticated: readable });

    const response = await api.handle(request({
      method: "GET",
      path: `/v1/projects/${projectId}/jobs/${jobId}`,
      headers: { authorization: `Bearer ${rawKey}` },
      body: null,
    }));

    expect(response).toMatchObject({
      status: 200,
      body: { request_id: requestId, job: { id: jobId } },
    });
    expect(getJob).toHaveBeenCalledWith(readable, jobId);
  });

  it("denies Job reads without results:read", async () => {
    const { api, getJob } = harness();
    const response = await api.handle(request({
      method: "GET",
      path: `/v1/projects/${projectId}/jobs/${jobId}`,
    }));

    expect(response).toMatchObject({ status: 403, body: { code: "API_KEY_SCOPE_DENIED" } });
    expect(getJob).not.toHaveBeenCalled();
  });

  it("does not distinguish a missing Job from a Job in another Project", async () => {
    const readable = Object.freeze({ ...identity, scopes: ["results:read"] as const });
    const { api } = harness({ authenticated: readable, found: new JobNotFoundError() });
    const response = await api.handle(request({
      method: "GET",
      path: `/v1/projects/${projectId}/jobs/${jobId}`,
    }));

    expect(response).toMatchObject({ status: 404, body: { code: "JOB_NOT_FOUND" } });
  });

  it("cancels a Project Job with tasks:write", async () => {
    const { api, cancelJob } = harness();
    const response = await api.handle(request({
      path: `/v1/projects/${projectId}/jobs/${jobId}/cancel`,
      headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
      body: {},
    }));

    expect(response).toMatchObject({
      status: 200,
      body: { request_id: requestId, job: { id: jobId, status: "cancelled" } },
    });
    expect(cancelJob).toHaveBeenCalledWith(identity, jobId);
  });

  it("rejects cancel without tasks:write or with an invalid transition", async () => {
    const readable = Object.freeze({ ...identity, scopes: ["results:read"] as const });
    const denied = harness({ authenticated: readable });
    const requestOverride = {
      path: `/v1/projects/${projectId}/jobs/${jobId}/cancel`,
      headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
      body: {},
    };
    expect(await denied.api.handle(request(requestOverride)))
      .toMatchObject({ status: 403, body: { code: "API_KEY_SCOPE_DENIED" } });
    expect(denied.cancelJob).not.toHaveBeenCalled();

    const conflict = harness({ cancelled: new JobTransitionError() });
    expect(await conflict.api.handle(request(requestOverride)))
      .toMatchObject({ status: 409, body: { code: "JOB_TRANSITION_INVALID" } });
  });

  it("validates cancel media type and empty JSON body", async () => {
    const { api, cancelJob } = harness();
    const path = `/v1/projects/${projectId}/jobs/${jobId}/cancel`;
    expect(await api.handle(request({
      path,
      headers: { authorization: `Bearer ${rawKey}` },
      body: null,
    })))
      .toMatchObject({ status: 415, body: { code: "PROJECT_MEDIA_TYPE_UNSUPPORTED" } });
    expect(await api.handle(request({ path, body: { reason: "unused" } })))
      .toMatchObject({ status: 422, body: { code: "JOB_REQUEST_INVALID" } });
    expect(cancelJob).not.toHaveBeenCalled();
  });

  it("lists Project publications with sequence pagination", async () => {
    const readable = Object.freeze({ ...identity, scopes: ["results:read"] as const });
    const { api, listPublications } = harness({ authenticated: readable });
    const response = await api.handle(request({
      method: "GET",
      path: `/v1/projects/${projectId}/jobs/${jobId}/publications`,
      query: "?after_sequence=2&limit=1",
      headers: { authorization: `Bearer ${rawKey}` },
      body: null,
    }));

    expect(response).toMatchObject({
      status: 200,
      body: {
        request_id: requestId,
        publications: [{ id: publication.id, sequence: 3 }],
        pagination: { next_sequence: 3, has_more: false, limit: 1 },
      },
    });
    expect(listPublications).toHaveBeenCalledWith(readable, jobId, {
      afterSequence: 2,
      limit: 1,
    });
  });

  it("rejects unsupported or duplicate publication query parameters", async () => {
    const readable = Object.freeze({ ...identity, scopes: ["results:read"] as const });
    const { api, listPublications } = harness({ authenticated: readable });
    const path = `/v1/projects/${projectId}/jobs/${jobId}/publications`;

    expect(await api.handle(request({ method: "GET", path, query: "?offset=1" })))
      .toMatchObject({ status: 400, body: { code: "PROJECT_QUERY_INVALID" } });
    expect(await api.handle(request({ method: "GET", path, query: "?limit=1&limit=2" })))
      .toMatchObject({ status: 400, body: { code: "PROJECT_QUERY_INVALID" } });
    expect(listPublications).not.toHaveBeenCalled();
  });

  it("lists Project audit events with an opaque cursor", async () => {
    const admin = Object.freeze({ ...identity, scopes: ["project:admin"] as const });
    const older = Object.freeze({
      ...auditEvent,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      occurredAt: new Date(now.getTime() - 1_000),
    });
    const { api, listAuditEvents } = harness({
      authenticated: admin,
      auditEvents: [auditEvent, older],
    });
    const response = await api.handle(request({
      method: "GET",
      path: `/v1/projects/${projectId}/audit-events`,
      query: "?limit=1",
      headers: { authorization: `Bearer ${rawKey}` },
      body: null,
    }));

    expect(response).toMatchObject({
      status: 200,
      body: {
        audit_events: [{ id: auditEvent.id, action: "api_key.used" }],
        pagination: { has_more: true, limit: 1 },
      },
    });
    expect(listAuditEvents).toHaveBeenCalledWith(admin, { before: null, limit: 2 });
    const nextCursor = (response.body as {
      pagination: { next_cursor: string };
    }).pagination.next_cursor;
    const decoded = JSON.parse(Buffer.from(nextCursor, "base64url").toString("utf8")) as unknown;
    expect(decoded).toEqual({ occurred_at: now.toISOString(), id: auditEvent.id });
  });

  it("requires project:admin and rejects malformed audit cursors", async () => {
    const path = `/v1/projects/${projectId}/audit-events`;
    const denied = harness();
    expect(await denied.api.handle(request({ method: "GET", path })))
      .toMatchObject({ status: 403, body: { code: "API_KEY_SCOPE_DENIED" } });
    expect(denied.listAuditEvents).not.toHaveBeenCalled();

    const admin = Object.freeze({ ...identity, scopes: ["project:admin"] as const });
    const malformed = harness({ authenticated: admin });
    expect(await malformed.api.handle(request({ method: "GET", path, query: "?cursor=bad" })))
      .toMatchObject({ status: 400, body: { code: "PROJECT_QUERY_INVALID" } });
    expect(malformed.listAuditEvents).not.toHaveBeenCalled();
  });

  it("does not trust a path Project that differs from the API Key", async () => {
    const { api, createJob } = harness();
    const response = await api.handle(request({
      path: "/v1/projects/44444444-4444-4444-8444-444444444444/jobs",
    }));

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "PROJECT_PATH_IDENTITY_MISMATCH" });
    expect(createJob).not.toHaveBeenCalled();
  });

  it("returns indistinguishable authentication failures and explicit scope denial", async () => {
    const invalid = harness({ authenticated: new ProjectApiKeyAuthenticationError() });
    const unauthorized = await invalid.api.handle(request());
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers).toMatchObject({ "www-authenticate": "Bearer" });
    expect(unauthorized.body).toMatchObject({ code: "API_KEY_AUTHENTICATION_FAILED" });

    const denied = harness({ authenticated: new ProjectApiKeyScopeError() });
    const forbidden = await denied.api.handle(request());
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toMatchObject({ code: "API_KEY_SCOPE_DENIED" });
  });

  it("rejects missing idempotency, wrong media type, and invalid bodies before creation", async () => {
    const { api, createJob } = harness();
    const missingKey = await api.handle(request({
      headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
    }));
    expect(missingKey.status).toBe(400);
    expect(missingKey.body).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });

    const emptyKey = await api.handle(request({
      headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json",
        "idempotency-key": " " },
    }));
    expect(emptyKey.status).toBe(400);

    const wrongMedia = await api.handle(request({
      headers: { authorization: `Bearer ${rawKey}`, "content-type": "text/plain",
        "idempotency-key": "request-a" },
    }));
    expect(wrongMedia.status).toBe(415);

    const invalidBody = await api.handle(request({ body: body({ project_id: projectId }) }));
    expect(invalidBody.status).toBe(422);
    expect(invalidBody.body).toMatchObject({ code: "JOB_REQUEST_INVALID" });

    for (const unsupported of ["monitor-run", "vertical-index-run"]) {
      const unsupportedType = await api.handle(request({ body: body({ type: unsupported }) }));
      expect(unsupportedType.status).toBe(422);
      expect(unsupportedType.body).toMatchObject({ code: "JOB_REQUEST_INVALID" });
    }

    const validBudget = body().budget as Record<string, number>;
    for (const [field, value] of [
      ["deadline_ms", 86_400_001],
      ["max_provider_attempts", 1_000_001],
      ["max_document_bytes", Number.MAX_SAFE_INTEGER + 1],
      ["max_browser_ms", 86_400_001],
      ["max_browser_contexts", 100_001],
    ] as const) {
      const overBudget = await api.handle(request({
        body: body({ budget: { ...validBudget, [field]: value } }),
      }));
      expect(overBudget.status).toBe(422);
      expect(overBudget.body).toMatchObject({ code: "JOB_REQUEST_INVALID" });
    }
    expect(createJob).not.toHaveBeenCalled();
  });

  it("maps idempotency conflicts and domain validation without hiding server failures", async () => {
    const conflict = harness({ created: new JobIdempotencyConflictError() });
    expect(await conflict.api.handle(request())).toMatchObject({
      status: 409,
      body: { code: "JOB_IDEMPOTENCY_CONFLICT" },
    });

    const invalid = harness({ created: new TypeError("invalid schedule") });
    expect(await invalid.api.handle(request())).toMatchObject({
      status: 422,
      body: { code: "JOB_REQUEST_INVALID" },
    });

    const failed = harness({ created: new Error("database secret") });
    expect(await failed.api.handle(request())).toMatchObject({
      status: 500,
      body: { code: "INTERNAL_ERROR", detail: "The Project request could not be completed." },
    });
  });

  it("returns route and method errors without authenticating", async () => {
    const { api, authenticate } = harness();
    expect(await api.handle(request({ path: "/v1/projects/not-a-uuid/jobs" })))
      .toMatchObject({ status: 404, body: { code: "PROJECT_ROUTE_NOT_FOUND" } });
    const method = await api.handle(request({ method: "GET" }));
    expect(method).toMatchObject({ status: 405, headers: { allow: "POST" } });
    expect(authenticate).not.toHaveBeenCalled();
  });
});

describe("control-plane HTTP routing", () => {
  it("routes Project paths to the Project API and preserves Worker paths", async () => {
    const projects = { handle: vi.fn(async () => ({ status: 201, headers: {}, body: null })) };
    const workers = { handle: vi.fn(async () => ({ status: 204, headers: {}, body: null })) };
    const api = new ControlPlaneHttpApi(projects, workers);

    await api.handle(request());
    await api.handle(request({ path: "/v1/workers/worker-a/claims" }));

    expect(projects.handle).toHaveBeenCalledTimes(1);
    expect(workers.handle).toHaveBeenCalledTimes(1);
  });
});
