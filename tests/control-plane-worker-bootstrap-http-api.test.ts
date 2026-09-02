import { describe, expect, it, vi } from "vitest";

import {
  WorkerAuthenticationError,
  WorkerEnrollmentAuthenticationError,
  WorkerNotFoundError,
  WorkerPublicKeyError,
  type CreatedWorkerEnrollment,
  type WorkerChallenge,
  type WorkerRecord,
  type WorkerSession,
} from "../src/control-plane/api-key-service.js";
import { AccessTokenAuthenticationError } from "../src/control-plane/oidc-session-service.js";
import { OrganizationAccessDeniedError } from "../src/control-plane/organization-authorization.js";
import type { WorkerHttpRequest } from "../src/control-plane/organization-service.js";
import {
  resolveProjectScope,
  type ControlPlaneDatabase,
  type ControlPlaneQuery,
  type ProjectScope,
} from "../src/control-plane/project-scope.js";
import {
  WorkerBootstrapHttpApi,
  workerBootstrapRouterOperations,
} from "../src/control-plane/worker-bootstrap-http-api.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const workerId = "33333333-3333-4333-8333-333333333333";
const enrollmentId = "44444444-4444-4444-8444-444444444444";
const userId = "55555555-5555-4555-8555-555555555555";
const organizationId = "66666666-6666-4666-8666-666666666666";
const requestId = "77777777-7777-4777-8777-777777777777";
const humanToken = "aaa.bbb.ccc";
const enrollmentToken = `dya_we_${"A".repeat(43)}`;
const challengeValue = `dya_wc_${"B".repeat(43)}`;
const signature = "C".repeat(86);
const sessionToken = "ddd.eee.fff";
const createdAt = new Date("2026-09-02T08:00:00.000Z");
const enrollmentExpiresAt = new Date("2026-09-02T08:10:00.000Z");
const challengeExpiresAt = new Date("2026-09-02T08:02:00.000Z");
const sessionExpiresAt = new Date("2026-09-02T08:05:00.000Z");

class ScopeDatabase implements ControlPlaneDatabase {
  async transaction<Result>(
    operation: (transaction: ControlPlaneQuery) => Promise<Result>,
  ): Promise<Result> {
    return operation(this);
  }

  async query<Row>(_statement: string, _parameters: readonly unknown[]): Promise<{ rows: Row[] }> {
    return { rows: [{
      project_id: projectId,
      organization_id: organizationId,
      role: "admin",
    }] as Row[] };
  }
}

async function scope(): Promise<ProjectScope> {
  return resolveProjectScope(new ScopeDatabase(), { userId }, projectId);
}

function worker(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return Object.freeze({
    id: workerId,
    projectId,
    name: "private-mac",
    kind: "private",
    version: "1.0.0",
    capabilityHash: "D".repeat(43),
    status: "active",
    createdByUserId: userId,
    createdAt,
    disabledAt: null,
    ...overrides,
  });
}

function enrollment(): CreatedWorkerEnrollment {
  return Object.freeze({
    enrollment: Object.freeze({
      id: enrollmentId,
      projectId,
      workerName: "private-mac",
      createdByUserId: userId,
      expiresAt: enrollmentExpiresAt,
    }),
    rawToken: enrollmentToken,
  });
}

function challenge(): WorkerChallenge {
  return Object.freeze({
    workerId,
    challenge: challengeValue,
    signingPayload: `dya-worker-session-v1\n${challengeValue}`,
    expiresAt: challengeExpiresAt,
  });
}

function session(): WorkerSession {
  return Object.freeze({ token: sessionToken, expiresAt: sessionExpiresAt });
}

function request(overrides: Partial<WorkerHttpRequest> = {}): WorkerHttpRequest {
  return {
    method: "POST",
    path: `/v1/projects/${projectId}/worker-enrollments`,
    query: "",
    headers: {
      authorization: `Bearer ${humanToken}`,
      "content-type": "application/json",
    },
    body: { worker_name: "private-mac" },
    ...overrides,
  };
}

type ServiceOverrides = Partial<ConstructorParameters<typeof WorkerBootstrapHttpApi>[0]>;

async function harness(overrides: ServiceOverrides = {}) {
  const projectScope = await scope();
  const authenticateAccessToken = vi.fn(async () => ({ userId }));
  const resolveScope = vi.fn(async () => projectScope);
  const createEnrollment = vi.fn(async () => enrollment());
  const enroll = vi.fn(async () => worker());
  const createChallenge = vi.fn(async () => challenge());
  const createSession = vi.fn(async () => session());
  const disableWorker = vi.fn(async () => worker({ status: "disabled", disabledAt: createdAt }));
  const api = new WorkerBootstrapHttpApi({
    authenticateAccessToken,
    resolveScope,
    createEnrollment,
    enroll,
    createChallenge,
    createSession,
    disableWorker,
    ...overrides,
  }, { requestId: () => requestId });
  return {
    api,
    authenticateAccessToken,
    resolveScope,
    createEnrollment,
    enroll,
    createChallenge,
    createSession,
    disableWorker,
    projectScope,
  };
}

describe("Worker bootstrap HTTP API", () => {
  it("exports the five exact operations for HTTP-04 integration", () => {
    expect(workerBootstrapRouterOperations).toEqual([
      {
        method: "POST",
        path: "/projects/{project_id}/worker-enrollments",
        operationId: "createWorkerEnrollment",
      },
      { method: "POST", path: "/worker-enrollments", operationId: "enrollWorker" },
      {
        method: "POST",
        path: "/worker-sessions/challenges",
        operationId: "createWorkerSessionChallenge",
      },
      { method: "POST", path: "/worker-sessions", operationId: "createWorkerSession" },
      {
        method: "POST",
        path: "/projects/{project_id}/workers/{worker_id}/disable",
        operationId: "disableProjectWorker",
      },
    ]);
    expect(WorkerBootstrapHttpApi.routerOperations).toBe(workerBootstrapRouterOperations);
  });

  it("creates a Project-bound enrollment through a human Access Token", async () => {
    const { api, authenticateAccessToken, resolveScope, createEnrollment, projectScope } =
      await harness();
    const result = await api.handle(request({
      headers: {
        authorization: `bEaReR ${humanToken}`,
        "content-type": "application/json",
      },
      body: { worker_name: " private-mac " },
    }));

    expect(result).toEqual({
      status: 201,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
        "x-request-id": requestId,
      },
      body: {
        request_id: requestId,
        enrollment: {
          id: enrollmentId,
          project_id: projectId,
          worker_name: "private-mac",
          created_by_user_id: userId,
          expires_at: enrollmentExpiresAt.toISOString(),
        },
        enrollment_token: enrollmentToken,
      },
    });
    expect(authenticateAccessToken).toHaveBeenCalledWith(humanToken);
    expect(resolveScope).toHaveBeenCalledWith({ userId }, projectId);
    expect(createEnrollment).toHaveBeenCalledWith(
      projectScope,
      { workerName: "private-mac" },
      { correlationId: requestId },
    );
  });

  it("enrolls without accepting tenant identity from the Worker body", async () => {
    const { api, enroll } = await harness();
    const body = {
      public_key_spki: "canonical-public-key",
      version: " 1.0.0 ",
      capabilities: { http: true },
    };
    const result = await api.handle(request({
      path: "/v1/worker-enrollments",
      headers: {
        authorization: `bEaReR ${enrollmentToken}`,
        "content-type": "application/json",
      },
      body,
    }));

    expect(result).toMatchObject({
      status: 201,
      body: {
        request_id: requestId,
        worker: { id: workerId, project_id: projectId, capability_hash: "D".repeat(43) },
      },
    });
    expect(enroll).toHaveBeenCalledWith(enrollmentToken, {
      publicKeySpki: "canonical-public-key",
      version: "1.0.0",
      capabilities: { http: true },
    }, { correlationId: requestId });

    await expect(api.handle(request({
      path: "/v1/worker-enrollments",
      headers: {
        authorization: `Bearer ${enrollmentToken}`,
        "content-type": "application/json",
      },
      body: { ...body, project_id: projectId },
    }))).resolves.toMatchObject({
      status: 422,
      body: { code: "WORKER_BOOTSTRAP_REQUEST_INVALID" },
    });
    await expect(api.handle(request({
      path: "/v1/worker-enrollments",
      headers: {
        authorization: `Bearer ${enrollmentToken}`,
        "content-type": "application/json",
      },
      body: { ...body, token: enrollmentToken },
    }))).resolves.toMatchObject({
      status: 422,
      body: { code: "WORKER_BOOTSTRAP_REQUEST_INVALID" },
    });
    expect(enroll).toHaveBeenCalledTimes(1);
  });

  it("creates challenges and sessions without requiring an existing Worker Session", async () => {
    const { api, createChallenge, createSession } = await harness();
    const challenged = await api.handle(request({
      path: "/v1/worker-sessions/challenges",
      headers: { "content-type": "application/json" },
      body: { worker_id: workerId },
    }));
    expect(challenged).toEqual({
      status: 201,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
        "x-request-id": requestId,
      },
      body: {
        request_id: requestId,
        challenge: {
          worker_id: workerId,
          challenge: challengeValue,
          signing_payload: `dya-worker-session-v1\n${challengeValue}`,
          expires_at: challengeExpiresAt.toISOString(),
        },
      },
    });
    expect(createChallenge).toHaveBeenCalledWith(workerId);

    const created = await api.handle(request({
      path: "/v1/worker-sessions",
      headers: { "content-type": "application/json" },
      body: { worker_id: workerId, challenge: challengeValue, signature },
    }));
    expect(created).toEqual({
      status: 201,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
        "x-request-id": requestId,
      },
      body: {
        request_id: requestId,
        session: { token: sessionToken, expires_at: sessionExpiresAt.toISOString() },
      },
    });
    expect(createSession).toHaveBeenCalledWith({
      workerId,
      challenge: challengeValue,
      signature,
    });
  });

  it("disables a Worker through a Project-bound human identity", async () => {
    const { api, disableWorker, projectScope } = await harness();
    const result = await api.handle(request({
      path: `/v1/projects/${projectId}/workers/${workerId}/disable`,
      body: {},
    }));

    expect(result).toMatchObject({
      status: 200,
      body: { request_id: requestId, worker: { id: workerId, status: "disabled" } },
    });
    expect(disableWorker).toHaveBeenCalledWith(
      projectScope,
      workerId,
      { correlationId: requestId },
    );
  });

  it("fails closed for invalid human identity, authorization, and scoped Worker lookup", async () => {
    const invalid = await harness({
      authenticateAccessToken: vi.fn(async () => { throw new AccessTokenAuthenticationError(); }),
    });
    await expect(invalid.api.handle(request())).resolves.toMatchObject({
      status: 401,
      headers: { "www-authenticate": "Bearer" },
      body: { code: "ACCESS_TOKEN_INVALID" },
    });

    const denied = await harness({
      resolveScope: vi.fn(async () => { throw new OrganizationAccessDeniedError(); }),
    });
    await expect(denied.api.handle(request())).resolves.toMatchObject({
      status: 403,
      body: { code: "WORKER_MANAGEMENT_FORBIDDEN" },
    });

    const missing = await harness({
      disableWorker: vi.fn(async () => { throw new WorkerNotFoundError(); }),
    });
    await expect(missing.api.handle(request({
      path: `/v1/projects/${projectId}/workers/${workerId}/disable`,
      body: {},
    }))).resolves.toMatchObject({ status: 404, body: { code: "WORKER_NOT_FOUND" } });
  });

  it("uses uniform authentication failures without leaking enrollment or session credentials", async () => {
    const invalidEnrollment = await harness({
      enroll: vi.fn(async () => { throw new WorkerEnrollmentAuthenticationError(); }),
    });
    const enrollmentResult = await invalidEnrollment.api.handle(request({
      path: "/v1/worker-enrollments",
      headers: {
        authorization: `Bearer ${enrollmentToken}`,
        "content-type": "application/json",
      },
      body: { public_key_spki: "key", version: "1", capabilities: {} },
    }));
    expect(enrollmentResult).toMatchObject({
      status: 401,
      headers: { "www-authenticate": "Bearer" },
      body: { code: "WORKER_ENROLLMENT_INVALID" },
    });
    expect(JSON.stringify(enrollmentResult)).not.toContain(enrollmentToken);

    const malformedEnrollment = await harness();
    const malformedResult = await malformedEnrollment.api.handle(request({
      path: "/v1/worker-enrollments",
      headers: {
        authorization: "Bearer malformed",
        "content-type": "application/json",
      },
      body: {
        public_key_spki: "key",
        version: "1",
        capabilities: {},
        token: enrollmentToken,
      },
    }));
    expect(malformedResult).toMatchObject({
      status: 401,
      body: { code: "WORKER_ENROLLMENT_INVALID" },
    });
    expect(malformedEnrollment.enroll).not.toHaveBeenCalled();
    expect(JSON.stringify(malformedResult)).not.toContain(enrollmentToken);

    const invalidWorker = await harness({
      createChallenge: vi.fn(async () => { throw new WorkerAuthenticationError(); }),
      createSession: vi.fn(async () => { throw new WorkerAuthenticationError(); }),
    });
    const challengeResult = await invalidWorker.api.handle(request({
      path: "/v1/worker-sessions/challenges",
      headers: { "content-type": "application/json" },
      body: { worker_id: workerId },
    }));
    expect(challengeResult).toMatchObject({
      status: 401,
      body: { code: "WORKER_AUTHENTICATION_FAILED" },
    });
    expect(challengeResult.headers).not.toHaveProperty("www-authenticate");

    const sessionResult = await invalidWorker.api.handle(request({
      path: "/v1/worker-sessions",
      headers: { "content-type": "application/json" },
      body: { worker_id: workerId, challenge: challengeValue, signature },
    }));
    expect(sessionResult).toMatchObject({
      status: 401,
      body: { code: "WORKER_AUTHENTICATION_FAILED" },
    });
    expect(sessionResult.headers).not.toHaveProperty("www-authenticate");
    const serialized = JSON.stringify(sessionResult);
    expect(serialized).not.toContain(challengeValue);
    expect(serialized).not.toContain(signature);
    expect(serialized).not.toContain(sessionToken);
  });

  it("rejects unsupported methods, queries, media types, and strict invalid bodies", async () => {
    const { api, createEnrollment, createChallenge } = await harness();
    await expect(api.handle(request({ method: "GET" }))).resolves.toMatchObject({
      status: 405,
      headers: { allow: "POST" },
    });
    await expect(api.handle(request({ query: "?token=secret" }))).resolves.toMatchObject({
      status: 400,
      body: { code: "WORKER_BOOTSTRAP_QUERY_UNSUPPORTED" },
    });
    await expect(api.handle(request({ headers: { authorization: `Bearer ${humanToken}` } })))
      .resolves.toMatchObject({ status: 415, body: { code: "WORKER_BOOTSTRAP_MEDIA_TYPE_UNSUPPORTED" } });
    await expect(api.handle(request({ body: { worker_name: "" } }))).resolves.toMatchObject({
      status: 422,
      body: { code: "WORKER_BOOTSTRAP_REQUEST_INVALID" },
    });
    await expect(api.handle(request({
      path: "/v1/worker-sessions/challenges",
      headers: { "content-type": "application/json" },
      body: { worker_id: "not-a-uuid" },
    }))).resolves.toMatchObject({ status: 422 });
    await expect(api.handle(request({ path: "/v1/not-a-bootstrap-route" })))
      .resolves.toMatchObject({
        status: 404,
        body: { code: "WORKER_BOOTSTRAP_ROUTE_NOT_FOUND" },
      });
    expect(createEnrollment).not.toHaveBeenCalled();
    expect(createChallenge).not.toHaveBeenCalled();
  });

  it("maps invalid Worker public keys and oversized capabilities to redacted validation errors", async () => {
    const invalidKey = "not-a-canonical-worker-public-key";
    const rejectedKey = await harness({
      enroll: vi.fn(async () => { throw new WorkerPublicKeyError(); }),
    });
    const keyResult = await rejectedKey.api.handle(request({
      path: "/v1/worker-enrollments",
      headers: {
        authorization: `Bearer ${enrollmentToken}`,
        "content-type": "application/json",
      },
      body: { public_key_spki: invalidKey, version: "1", capabilities: {} },
    }));
    expect(keyResult).toMatchObject({
      status: 422,
      body: { code: "WORKER_PUBLIC_KEY_INVALID", retryable: false },
    });
    expect(JSON.stringify(keyResult)).not.toContain(invalidKey);

    const oversized = await harness();
    const capabilities = { value: "x".repeat(16 * 1_024) };
    const capabilityResult = await oversized.api.handle(request({
      path: "/v1/worker-enrollments",
      headers: {
        authorization: `Bearer ${enrollmentToken}`,
        "content-type": "application/json",
      },
      body: { public_key_spki: "key", version: "1", capabilities },
    }));
    expect(capabilityResult).toMatchObject({
      status: 422,
      body: { code: "WORKER_BOOTSTRAP_REQUEST_INVALID", retryable: false },
    });
    expect(oversized.enroll).not.toHaveBeenCalled();
    expect(JSON.stringify(capabilityResult)).not.toContain(capabilities.value);
  });

  it("turns unexpected failures into redacted Problem Details", async () => {
    const secret = "credential-that-must-not-leak";
    const failed = await harness({
      createEnrollment: vi.fn(async () => { throw new Error(`database failed with ${secret}`); }),
    });
    const result = await failed.api.handle(request());
    expect(result).toMatchObject({
      status: 500,
      body: { code: "INTERNAL_ERROR", retryable: true, request_id: requestId },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
