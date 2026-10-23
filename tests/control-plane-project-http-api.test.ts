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
import { startWorkerControlServer } from "../src/server.js";
import type {
  AuditEvent,
  JobPublication,
} from "../src/control-plane/organization-authorization.js";
import { ApiRequestRateLimiter, QuotaExceededError } from "../src/control-plane/quotas.js";

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
  paused?: ControlPlaneJob | Error;
  resumed?: ControlPlaneJob | Error;
  cancelled?: ControlPlaneJob | Error;
  publications?: Readonly<{
    items: readonly JobPublication[];
    hasMore: boolean;
    nextSequence: number | null;
  }> | Error;
  auditEvents?: readonly AuditEvent[] | Error;
  rateLimiter?: ApiRequestRateLimiter;
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
  const pauseJob = vi.fn(async () => {
    if (options.paused instanceof Error) throw options.paused;
    return options.paused ?? Object.freeze({ ...job, status: "paused" as const });
  });
  const resumeJob = vi.fn(async () => {
    if (options.resumed instanceof Error) throw options.resumed;
    return options.resumed ?? Object.freeze({ ...job, status: "queued" as const });
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
      {
        authenticate, createJob, getJob, pauseJob, resumeJob, cancelJob,
        listPublications, listAuditEvents,
      },
      {
        requestId: () => requestId,
        ...(options.rateLimiter === undefined ? {} : { rateLimiter: options.rateLimiter }),
      },
    ),
    authenticate,
    createJob,
    getJob,
    pauseJob,
    resumeJob,
    cancelJob,
    listPublications,
    listAuditEvents,
  };
}

describe("Project Job HTTP API", () => {
  it("returns a retryable 429 with Retry-After for a time-bound quota", async () => {
    const { api } = harness({ created: new QuotaExceededError("monthlyProviderAttempts", 3, 120) });
    const response = await api.handle(request());
    expect(response.status).toBe(429);
    expect(response.headers).toMatchObject({
      "content-type": "application/problem+json",
      "retry-after": "120",
    });
    expect(response.body).toMatchObject({ code: "QUOTA_EXCEEDED", status: 429, retryable: true });
  });

  it("returns a non-retryable 429 without Retry-After for a capacity quota", async () => {
    const { api } = harness({ created: new QuotaExceededError("activeJobs", 1, null) });
    const response = await api.handle(request());
    expect(response.status).toBe(429);
    expect(response.headers).not.toHaveProperty("retry-after");
    expect(response.body).toMatchObject({ code: "QUOTA_EXCEEDED", retryable: false });
  });

  it("rate limits each API key per minute before running the route", async () => {
    const limiter = new ApiRequestRateLimiter(1, () => 30_000);
    const { api, createJob } = harness({ rateLimiter: limiter });
    expect((await api.handle(request())).status).toBe(201);
    const limited = await api.handle(request());
    expect(limited.status).toBe(429);
    expect(limited.headers).toMatchObject({ "retry-after": "30" });
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  it("charges authenticated cross-project requests to the same rate limit", async () => {
    const { api, createJob } = harness({ rateLimiter: new ApiRequestRateLimiter(1, () => 30_000) });
    const otherProject = request({ path: "/v1/projects/44444444-4444-4444-8444-444444444444/jobs" });
    expect((await api.handle(otherProject)).status).toBe(403);
    const response = await api.handle(otherProject);
    expect(response).toMatchObject({ status: 429, body: { code: "QUOTA_EXCEEDED" } });
    expect(response.headers["retry-after"]).toBe("30");
    expect(createJob).not.toHaveBeenCalled();
  });

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

  it.each([
    ["pause", "paused", "pauseJob"],
    ["resume", "queued", "resumeJob"],
  ] as const)("%ss a Project Job and returns its wire status", async (
    action,
    status,
    serviceName,
  ) => {
    const context = harness();
    const response = await context.api.handle(request({
      path: `/v1/projects/${projectId}/jobs/${jobId}/${action}`,
      headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
      body: {},
    }));

    expect(response).toMatchObject({
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": requestId },
      body: { request_id: requestId, job: { id: jobId, status } },
    });
    expect(context[serviceName]).toHaveBeenCalledWith(identity, jobId);
  });

  it.each(["pause", "resume"] as const)(
    "returns a complete Problem Details contract for invalid %s transitions",
    async (action) => {
      const context = harness({
        ...(action === "pause"
          ? { paused: new JobTransitionError() }
          : { resumed: new JobTransitionError() }),
      });
      const path = `/v1/projects/${projectId}/jobs/${jobId}/${action}`;
      const response = await context.api.handle(request({ path, body: {} }));

      expect(response).toEqual({
        status: 409,
        headers: {
          "content-type": "application/problem+json",
          "x-request-id": requestId,
        },
        body: {
          type: "https://api.diaoyan.example/errors/job-transition-invalid",
          title: "Job Transition Invalid",
          status: 409,
          detail: "The requested Job state transition is not valid.",
          instance: path,
          code: "JOB_TRANSITION_INVALID",
          request_id: requestId,
          retryable: false,
        },
      });
    },
  );

  it.each(["pause", "resume"] as const)(
    "denies %s without tasks:write",
    async (action) => {
      const readable = Object.freeze({ ...identity, scopes: ["results:read"] as const });
      const context = harness({ authenticated: readable });
      const response = await context.api.handle(request({
        path: `/v1/projects/${projectId}/jobs/${jobId}/${action}`,
        body: {},
      }));

      expect(response).toMatchObject({
        status: 403,
        headers: { "content-type": "application/problem+json" },
        body: { status: 403, code: "API_KEY_SCOPE_DENIED" },
      });
      expect(context[action === "pause" ? "pauseJob" : "resumeJob"]).not.toHaveBeenCalled();
    },
  );

  it.each(["pause", "resume"] as const)(
    "validates %s media type and strict empty JSON body",
    async (action) => {
      const context = harness();
      const path = `/v1/projects/${projectId}/jobs/${jobId}/${action}`;
      expect(await context.api.handle(request({
        path,
        headers: { authorization: `Bearer ${rawKey}` },
        body: {},
      }))).toMatchObject({
        status: 415,
        headers: { "content-type": "application/problem+json" },
        body: { status: 415, code: "PROJECT_MEDIA_TYPE_UNSUPPORTED" },
      });
      expect(await context.api.handle(request({ path, body: { reason: "unused" } })))
        .toMatchObject({
          status: 422,
          headers: { "content-type": "application/problem+json" },
          body: { status: 422, code: "JOB_REQUEST_INVALID" },
        });
      expect(context[action === "pause" ? "pauseJob" : "resumeJob"]).not.toHaveBeenCalled();
    },
  );

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
  it("dispatches all 33 mounted operations to exactly one target handler", async () => {
    const handlers = {
      humanAuth: { handle: vi.fn(async () => ({ status: 200, headers: {}, body: null })) },
      projectAdmin: { handle: vi.fn(async () => ({ status: 200, headers: {}, body: null })) },
      workerBootstrap: { handle: vi.fn(async () => ({ status: 200, headers: {}, body: null })) },
      projects: { handle: vi.fn(async () => ({ status: 200, headers: {}, body: null })) },
      workers: { handle: vi.fn(async () => ({ status: 200, headers: {}, body: null })) },
    };
    const api = new ControlPlaneHttpApi(
      handlers.humanAuth,
      handlers.projectAdmin,
      handlers.workerBootstrap,
      handlers.projects,
      handlers.workers,
    );
    const target = (operationId: string): keyof typeof handlers => {
      if (["beginHumanOidcLogin", "completeHumanOidcLogin", "refreshHumanSession",
        "logoutHumanSession"].includes(operationId)) return "humanAuth";
      if (["listOrganizations", "listOrganizationProjects", "createOrganizationProject",
        "createProjectApiKey", "listProjectApiKeys", "revokeProjectApiKey"].includes(operationId)) {
        return "projectAdmin";
      }
      if (["createWorkerEnrollment", "enrollWorker", "createWorkerSessionChallenge",
        "createWorkerSession", "disableProjectWorker"].includes(operationId)) return "workerBootstrap";
      if (operationId.includes("Project") || operationId.includes("Webhook")) return "projects";
      return "workers";
    };

    expect(ControlPlaneHttpApi.routerOperations).toHaveLength(33);
    for (const operation of ControlPlaneHttpApi.routerOperations) {
      const before = Object.values(handlers).reduce((sum, handler) =>
        sum + handler.handle.mock.calls.length, 0);
      const path = `/v1${operation.path}`
        .replaceAll("{organization_id}", projectId)
        .replaceAll("{project_id}", projectId)
        .replaceAll("{job_id}", jobId)
        .replaceAll("{key_id}", jobId)
        .replaceAll("{worker_id}", jobId)
        .replaceAll("{lease_id}", jobId)
        .replaceAll("{endpoint_id}", jobId)
        .replaceAll("{event_id}", jobId);

      await api.handle(request({ method: operation.method, path }));

      expect(handlers[target(operation.operationId)].handle).toHaveBeenLastCalledWith(
        expect.objectContaining({ method: operation.method, path }),
      );
      expect(Object.values(handlers).reduce((sum, handler) =>
        sum + handler.handle.mock.calls.length, 0)).toBe(before + 1);
    }
  });

  it("preserves allowed queries and empty-body semantics over a real loopback socket", async () => {
    const humanAuth = { handle: vi.fn(async () => ({ status: 204, headers: {}, body: null })) };
    const projectAdmin = { handle: vi.fn(async () => ({ status: 204, headers: {}, body: null })) };
    const workerBootstrap = { handle: vi.fn(async () => ({ status: 204, headers: {}, body: null })) };
    const projects = { handle: vi.fn(async () => ({ status: 204, headers: {}, body: null })) };
    const workers = { handle: vi.fn(async () => ({ status: 204, headers: {}, body: null })) };
    const listener = await startWorkerControlServer(
      new ControlPlaneHttpApi(humanAuth, projectAdmin, workerBootstrap, projects, workers),
      { host: "127.0.0.1", port: 0, tls: null },
    );
    const cursor = Buffer.from("cursor").toString("base64url");

    try {
      await fetch(`${listener.origin}/v1/auth/oidc/callback?state=state-a&code=code-a`);
      await fetch(`${listener.origin}/v1/organizations?cursor=${cursor}&limit=5`);
      await fetch(`${listener.origin}/v1/organizations/${projectId}/projects?limit=6`);
      await fetch(`${listener.origin}/v1/projects/${projectId}/api-keys?cursor=${cursor}`);
      await fetch(`${listener.origin}/v1/projects/${projectId}/webhook-deliveries?limit=7`);
      await fetch(`${listener.origin}/v1/auth/refresh`, { method: "POST" });
      await fetch(`${listener.origin}/v1/auth/logout`, { method: "POST" });

      expect(humanAuth.handle).toHaveBeenNthCalledWith(1, expect.objectContaining({
        path: "/v1/auth/oidc/callback", query: "?state=state-a&code=code-a",
      }));
      expect(projectAdmin.handle).toHaveBeenNthCalledWith(1, expect.objectContaining({
        path: "/v1/organizations", query: `?cursor=${cursor}&limit=5`,
      }));
      expect(projectAdmin.handle).toHaveBeenNthCalledWith(2, expect.objectContaining({
        path: `/v1/organizations/${projectId}/projects`, query: "?limit=6",
      }));
      expect(projectAdmin.handle).toHaveBeenNthCalledWith(3, expect.objectContaining({
        path: `/v1/projects/${projectId}/api-keys`, query: `?cursor=${cursor}`,
      }));
      expect(projects.handle).toHaveBeenCalledWith(expect.objectContaining({
        path: `/v1/projects/${projectId}/webhook-deliveries`, query: "?limit=7",
      }));
      expect(humanAuth.handle).toHaveBeenNthCalledWith(2, expect.objectContaining({
        path: "/v1/auth/refresh", body: null,
      }));
      expect(humanAuth.handle).toHaveBeenNthCalledWith(3, expect.objectContaining({
        path: "/v1/auth/logout", body: null,
      }));

      const emptyJson = await fetch(`${listener.origin}/v1/auth/refresh`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "",
      });
      expect(emptyJson.status).toBe(400);
      await expect(emptyJson.json()).resolves.toMatchObject({ code: "JSON_INVALID" });
      expect(humanAuth.handle).toHaveBeenCalledTimes(3);
    } finally {
      await listener.close();
    }
  });

  it("reports Project Job action transport failures over a real loopback socket", async () => {
    const context = harness();
    const workers = { handle: vi.fn(async () => ({ status: 204, headers: {}, body: null })) };
    const listener = await startWorkerControlServer(
      new ControlPlaneHttpApi(workers, workers, workers, context.api, workers),
      { host: "127.0.0.1", port: 0, tls: null },
    );
    const post = (action: "pause" | "resume" | "cancel", suffix: string, body: string) => fetch(
      `${listener.origin}/v1/projects/${projectId}/jobs/${jobId}/${action}${suffix}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
        body,
      },
    );
    const expectProblem = async (response: Response, status: number, code: string) => {
      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toBe("application/problem+json");
      await expect(response.json()).resolves.toMatchObject({ status, code, retryable: false });
    };

    try {
      expect((await post("pause", "", "{}")).status).toBe(200);
      await expectProblem(await post("pause", "", ""), 400, "JSON_INVALID");
      await expectProblem(await post("resume", "", "{"), 400, "JSON_INVALID");
      await expectProblem(await post("pause", "?force=true", "{}"), 400, "QUERY_UNSUPPORTED");
      await expectProblem(
        await post("resume", "", "x".repeat(65_537)),
        413,
        "REQUEST_BODY_TOO_LARGE",
      );
      await expectProblem(await post("cancel", "", "{"), 400, "JSON_INVALID");
      await expectProblem(await post("cancel", "?force=true", "{}"), 400, "QUERY_UNSUPPORTED");
      await expectProblem(
        await post("cancel", "", "x".repeat(65_537)),
        413,
        "REQUEST_BODY_TOO_LARGE",
      );
      expect(context.pauseJob).toHaveBeenCalledOnce();
      expect(context.resumeJob).not.toHaveBeenCalled();
      expect(context.cancelJob).not.toHaveBeenCalled();
      expect(workers.handle).not.toHaveBeenCalled();
    } finally {
      await listener.close();
    }
  });
});
