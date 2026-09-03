import { describe, expect, it } from "vitest";

import {
  RemoteWorkerClient,
  RemoteWorkerConfigurationError,
  RemoteWorkerHttpError,
  RemoteWorkerOutcomeUnknownError,
  RemoteWorkerProtocolError,
  RemoteWorkerTransportError,
} from "../src/remote-worker/client.js";
import { createInMemoryWorkerIdentity } from "../src/remote-worker/enrollment.js";
import { workerSigningPayload } from "../src/control-plane/worker-challenge-budget.js";

const workerId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const jobId = "55555555-5555-4555-8555-555555555555";
const leaseId = "66666666-6666-4666-8666-666666666666";
const enrollmentToken = `dya_we_${"E".repeat(43)}`;
const sessionToken = "aaa.bbb.ccc";
const challenge = `dya_wc_${"C".repeat(43)}`;

type FetchCall = Readonly<{ input: URL | RequestInfo; init?: RequestInit }>;

function jsonResponse(body: unknown, status = 200, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
}

function queuedFetch(...responses: Array<Response | Error>) {
  const calls: FetchCall[] = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ input, ...(init === undefined ? {} : { init }) });
    const next = responses.shift();
    if (next === undefined) throw new Error("No queued response.");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { calls, fetcher };
}

function workerResponse() {
  return {
    request_id: requestId,
    worker: {
      id: workerId,
      project_id: projectId,
      name: "private-mac",
      kind: "private",
      version: "1.0.0",
      capability_hash: "H".repeat(43),
      status: "active",
      created_by_user_id: userId,
      created_at: "2026-09-03T01:00:00.000Z",
      disabled_at: null,
    },
  };
}

function workerJob(status: "running" | "completed" | "failed" = "running") {
  return {
    id: jobId,
    type: "read",
    input: { url: "https://example.com/article" },
    data_class: "public",
    placement: { class: "public", pinned_worker_id: null },
    required_capabilities: { http: true },
    budget: {
      deadline_ms: 300_000,
      max_provider_attempts: 2,
      max_document_bytes: 1_000_000,
      max_browser_ms: 0,
      max_browser_contexts: 0,
    },
    policy_version: "policy-v1",
    upload_private_artifact: false,
    priority: 0,
    not_before: "2026-09-03T01:00:00.000Z",
    deadline_at: "2026-09-03T01:05:00.000Z",
    status,
    result_completeness: status === "completed" ? "complete" : null,
    error_code: status === "failed" ? "PROVIDER_FAILED" : null,
  };
}

function leaseResponse() {
  return {
    id: leaseId,
    job_id: jobId,
    generation: 3,
    heartbeat_deadline: "2026-09-03T01:00:30.000Z",
    lease_deadline: "2026-09-03T01:05:00.000Z",
  };
}

function problem(overrides: Record<string, unknown> = {}) {
  return {
    type: "https://api.diaoyan.example/errors/job-lease-fenced",
    title: "Job Lease Fenced",
    status: 409,
    detail: "The Job Lease is inactive, expired, or superseded.",
    instance: `/v1/job-leases/${leaseId}/complete`,
    code: "JOB_LEASE_FENCED",
    request_id: requestId,
    retryable: false,
    ...overrides,
  };
}

describe("Remote Worker HTTP client", () => {
  it("consumes an enrollment token once without putting credentials or tenant identity in the body", async () => {
    const identity = createInMemoryWorkerIdentity();
    const controller = new AbortController();
    const { calls, fetcher } = queuedFetch(jsonResponse(workerResponse(), 201));
    const client = new RemoteWorkerClient("http://127.0.0.1:4321/v1/", { fetch: fetcher });

    const enrolled = await client.enroll({
      enrollmentToken,
      identity,
      version: " 1.0.0 ",
      capabilities: { http: true },
      signal: controller.signal,
    });

    expect(enrolled).toMatchObject({
      requestId,
      worker: { id: workerId, projectId, status: "active" },
    });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe("http://127.0.0.1:4321/v1/worker-enrollments");
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/json, application/problem+json",
        authorization: `Bearer ${enrollmentToken}`,
        "content-type": "application/json",
      },
    });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      public_key_spki: identity.publicKeySpki,
      version: "1.0.0",
      capabilities: { http: true },
    });
    expect(body).not.toHaveProperty("project_id");
    expect(JSON.stringify(body)).not.toContain(enrollmentToken);
  });

  it("creates an anonymous challenge, validates its exact payload, and exchanges the signature", async () => {
    const identity = createInMemoryWorkerIdentity();
    const { calls, fetcher } = queuedFetch(
      jsonResponse({
        request_id: requestId,
        challenge: {
          worker_id: workerId,
          challenge,
          signing_payload: workerSigningPayload(challenge),
          expires_at: "2026-09-03T01:02:00.000Z",
        },
      }, 201),
      jsonResponse({
        request_id: requestId,
        session: { token: sessionToken, expires_at: "2026-09-03T01:05:00.000Z" },
      }, 201),
    );
    const client = new RemoteWorkerClient("https://control.example/v1/", { fetch: fetcher });

    const session = await client.createSession({ workerId, identity });

    expect(session).toEqual({
      requestId,
      token: sessionToken,
      expiresAt: new Date("2026-09-03T01:05:00.000Z"),
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init?.headers).not.toHaveProperty("authorization");
    expect(calls[1]?.init?.headers).not.toHaveProperty("authorization");
    const exchange = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>;
    expect(exchange).toMatchObject({ worker_id: workerId, challenge });
    expect(exchange.signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);
  });

  it("fails closed before Session exchange when the challenge response is inconsistent", async () => {
    const { calls, fetcher } = queuedFetch(jsonResponse({
      request_id: requestId,
      challenge: {
        worker_id: workerId,
        challenge,
        signing_payload: "different-protocol-payload",
        expires_at: "2026-09-03T01:02:00.000Z",
      },
    }, 201));
    const client = new RemoteWorkerClient("https://control.example/v1/", { fetch: fetcher });

    await expect(client.createSession({ workerId, identity: createInMemoryWorkerIdentity() }))
      .rejects.toBeInstanceOf(RemoteWorkerProtocolError);
    expect(calls).toHaveLength(1);
  });

  it("returns a typed claim, null for 204, and passes the caller AbortSignal", async () => {
    const controller = new AbortController();
    const { calls, fetcher } = queuedFetch(
      jsonResponse({ request_id: requestId, job: workerJob(), lease: leaseResponse() }),
      new Response(null, { status: 204 }),
    );
    const client = new RemoteWorkerClient("https://control.example/v1", { fetch: fetcher });

    const claimed = await client.claim({
      workerId,
      sessionToken,
      waitMs: 30_000,
      signal: controller.signal,
    });
    const empty = await client.claim({ workerId, sessionToken, waitMs: 0 });

    expect(claimed).toMatchObject({
      requestId,
      job: {
        id: jobId,
        type: "read",
        input: { url: "https://example.com/article" },
        dataClass: "public",
        requiredCapabilities: { http: true },
        status: "running",
      },
      lease: { id: leaseId, jobId, generation: 3 },
    });
    expect(claimed?.job.notBefore).toEqual(new Date("2026-09-03T01:00:00.000Z"));
    expect(empty).toBeNull();
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      signal: controller.signal,
      headers: { authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ wait_ms: 30_000 }),
    });
    expect(String(calls[0]?.input)).toContain(`/v1/workers/${workerId}/claims`);
  });

  it("heartbeats and reports both terminal outcomes with the exact fenced generation", async () => {
    const { calls, fetcher } = queuedFetch(
      jsonResponse({ request_id: requestId, lease: leaseResponse() }),
      jsonResponse({
        request_id: requestId,
        job: { ...workerJob("completed"), result_completeness: "partial" },
      }),
      jsonResponse({ request_id: requestId, job: workerJob("failed") }),
    );
    const client = new RemoteWorkerClient("https://control.example/v1/", { fetch: fetcher });

    const heartbeat = await client.heartbeat({ sessionToken, leaseId, generation: 3 });
    const completed = await client.complete({
      sessionToken,
      leaseId,
      expectedJobId: jobId,
      generation: 3,
      terminal: { status: "completed", resultCompleteness: "partial", errorCode: null },
    });
    const failed = await client.complete({
      sessionToken,
      leaseId,
      expectedJobId: jobId,
      generation: 3,
      terminal: { status: "failed", resultCompleteness: null, errorCode: " PROVIDER_FAILED " },
    });

    expect(heartbeat.lease).toMatchObject({ id: leaseId, generation: 3 });
    expect(completed.job.status).toBe("completed");
    expect(failed.job.status).toBe("failed");
    expect(calls.map((call) => call.init?.method)).toEqual(["PATCH", "POST", "POST"]);
    expect(calls.map((call) => JSON.parse(String(call.init?.body)))).toEqual([
      { generation: 3 },
      { generation: 3, status: "completed", result_completeness: "partial", error_code: null },
      { generation: 3, status: "failed", result_completeness: null, error_code: "PROVIDER_FAILED" },
    ]);
  });

  it("validates Problem Details but exposes only non-sensitive error metadata", async () => {
    const maliciousDetail = `server reflected ${sessionToken}`;
    const { fetcher } = queuedFetch(jsonResponse(
      problem({ detail: maliciousDetail }),
      409,
      "application/problem+json",
    ));
    const client = new RemoteWorkerClient("https://control.example/v1/", { fetch: fetcher });

    const caught = await client.complete({
      sessionToken,
      leaseId,
      expectedJobId: jobId,
      generation: 3,
      terminal: { status: "completed", resultCompleteness: "complete", errorCode: null },
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(RemoteWorkerHttpError);
    expect(caught).toMatchObject({
      status: 409,
      code: "JOB_LEASE_FENCED",
      requestId,
      retryable: false,
      retryAfterSeconds: null,
    });
    expect(String(caught)).toBe(
      "RemoteWorkerHttpError: The Remote Worker control request was rejected.",
    );
    expect(JSON.stringify(caught)).not.toContain(sessionToken);
  });

  it("maps challenge rate limiting without sleeping or retrying", async () => {
    const response = jsonResponse(problem({
      type: "https://api.diaoyan.example/errors/worker-challenge-rate-limited",
      title: "Worker Challenge Rate Limited",
      status: 429,
      code: "WORKER_CHALLENGE_RATE_LIMITED",
      retryable: true,
    }), 429, "application/problem+json");
    response.headers.set("retry-after", "1");
    const { calls, fetcher } = queuedFetch(response);
    const client = new RemoteWorkerClient("https://control.example/v1/", { fetch: fetcher });

    const caught = await client.createSession({
      workerId,
      identity: createInMemoryWorkerIdentity(),
    }).catch((error: unknown) => error);

    expect(caught).toMatchObject({
      status: 429,
      code: "WORKER_CHALLENGE_RATE_LIMITED",
      retryAfterSeconds: 1,
    });
    expect(calls).toHaveLength(1);
  });

  it("rejects unsafe endpoints and malformed successful responses", async () => {
    expect(() => new RemoteWorkerClient("http://control.example/v1/"))
      .toThrow(RemoteWorkerConfigurationError);
    expect(() => new RemoteWorkerClient("http://localhost/v1/"))
      .toThrow(RemoteWorkerConfigurationError);
    expect(() => new RemoteWorkerClient("https://user:password@control.example/v1/"))
      .toThrow(RemoteWorkerConfigurationError);

    const malformed = { ...workerResponse(), unexpected: true };
    const { fetcher } = queuedFetch(jsonResponse(malformed, 201));
    const client = new RemoteWorkerClient("https://control.example/v1/", { fetch: fetcher });
    await expect(client.enroll({
      enrollmentToken,
      identity: createInMemoryWorkerIdentity(),
      version: "1.0.0",
      capabilities: { http: true },
    })).rejects.toBeInstanceOf(RemoteWorkerOutcomeUnknownError);
  });

  it("marks a failed enrollment transport outcome unknown without retrying or exposing its token", async () => {
    const { calls, fetcher } = queuedFetch(new Error(`network failure ${enrollmentToken}`));
    const client = new RemoteWorkerClient("https://control.example/v1/", { fetch: fetcher });

    const caught = await client.enroll({
      enrollmentToken,
      identity: createInMemoryWorkerIdentity(),
      version: "1.0.0",
      capabilities: {},
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(RemoteWorkerOutcomeUnknownError);
    expect(caught).toMatchObject({ metadata: { operation: "enroll" } });
    expect(String(caught)).toBe(
      "RemoteWorkerOutcomeUnknownError: The Remote Worker request outcome is unknown.",
    );
    expect(String(caught)).not.toContain(enrollmentToken);
    expect(JSON.stringify(caught)).not.toContain(enrollmentToken);
    expect(calls).toHaveLength(1);
  });

  it("requires complete to match the expected Job and exact terminal projection", async () => {
    const mismatched = [
      { ...workerJob("completed"), id: "77777777-7777-4777-8777-777777777777" },
      { ...workerJob("failed"), result_completeness: null, error_code: "PROVIDER_FAILED" },
      { ...workerJob("completed"), result_completeness: "complete" },
      { ...workerJob("failed"), result_completeness: null, error_code: "DIFFERENT_FAILURE" },
    ];
    const { fetcher } = queuedFetch(...mismatched.map((job) =>
      jsonResponse({ request_id: requestId, job })));
    const client = new RemoteWorkerClient("https://control.example/v1/", { fetch: fetcher });
    const completed = {
      sessionToken,
      leaseId,
      expectedJobId: jobId,
      generation: 3,
      terminal: { status: "completed", resultCompleteness: "partial", errorCode: null } as const,
    };
    const failed = {
      sessionToken,
      leaseId,
      expectedJobId: jobId,
      generation: 3,
      terminal: {
        status: "failed",
        resultCompleteness: null,
        errorCode: "PROVIDER_FAILED",
      } as const,
    };

    await expect(client.complete(completed)).rejects.toMatchObject({
      metadata: { operation: "complete", leaseId, generation: 3, expectedJobId: jobId },
    });
    await expect(client.complete(completed)).rejects.toBeInstanceOf(RemoteWorkerOutcomeUnknownError);
    await expect(client.complete(completed)).rejects.toBeInstanceOf(RemoteWorkerOutcomeUnknownError);
    await expect(client.complete(failed)).rejects.toBeInstanceOf(RemoteWorkerOutcomeUnknownError);
  });

  it("uses per-operation documented error statuses and reserves Retry-After for challenge", async () => {
    const enrollmentRejected = jsonResponse(problem({
      type: "https://api.diaoyan.example/errors/worker-enrollment-invalid",
      title: "Worker Enrollment Invalid",
      status: 401,
      code: "WORKER_ENROLLMENT_INVALID",
    }), 401, "application/problem+json");
    const undocumentedComplete = jsonResponse(problem({
      type: "https://api.diaoyan.example/errors/forbidden",
      title: "Forbidden",
      status: 403,
      code: "FORBIDDEN",
    }), 403, "application/problem+json");
    const undocumentedHeartbeat = jsonResponse(problem({
      type: "https://api.diaoyan.example/errors/rate-limited",
      title: "Rate Limited",
      status: 429,
      code: "RATE_LIMITED",
      retryable: true,
    }), 429, "application/problem+json");
    undocumentedHeartbeat.headers.set("retry-after", "1");
    const { fetcher } = queuedFetch(
      enrollmentRejected,
      undocumentedComplete,
      undocumentedHeartbeat,
    );
    const client = new RemoteWorkerClient("https://control.example/v1/", { fetch: fetcher });

    await expect(client.enroll({
      enrollmentToken,
      identity: createInMemoryWorkerIdentity(),
      version: "1.0.0",
      capabilities: {},
    })).rejects.toMatchObject({ status: 401, code: "WORKER_ENROLLMENT_INVALID" });
    await expect(client.complete({
      sessionToken,
      leaseId,
      expectedJobId: jobId,
      generation: 3,
      terminal: { status: "completed", resultCompleteness: "complete", errorCode: null },
    })).rejects.toBeInstanceOf(RemoteWorkerOutcomeUnknownError);
    await expect(client.heartbeat({ sessionToken, leaseId, generation: 3 }))
      .rejects.toBeInstanceOf(RemoteWorkerProtocolError);
  });

  it("accepts an arbitrary Problem code without reflecting it through default serialization", async () => {
    const reflectedBearer = `Bearer ${sessionToken}`;
    const { fetcher } = queuedFetch(jsonResponse(
      problem({ code: reflectedBearer }),
      409,
      "application/problem+json",
    ));
    const client = new RemoteWorkerClient("https://control.example/v1/", { fetch: fetcher });

    const caught = await client.complete({
      sessionToken,
      leaseId,
      expectedJobId: jobId,
      generation: 3,
      terminal: { status: "completed", resultCompleteness: "complete", errorCode: null },
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(RemoteWorkerHttpError);
    expect((caught as RemoteWorkerHttpError).code).toBe(reflectedBearer);
    expect(String(caught)).not.toContain(reflectedBearer);
    expect(JSON.stringify(caught)).not.toContain(reflectedBearer);
  });

  it("caps decoded bytes even for a 204 claim response", async () => {
    const oversized = {
      status: 204,
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(256 * 1_024 + 1));
          controller.close();
        },
      }),
    } as Response;
    const { fetcher } = queuedFetch(oversized);
    const client = new RemoteWorkerClient("https://control.example/v1/", { fetch: fetcher });

    await expect(client.claim({ workerId, sessionToken, waitMs: 0 }))
      .rejects.toBeInstanceOf(RemoteWorkerOutcomeUnknownError);
  });

  it("marks a claim outcome unknown when the caller aborts while reading its response", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped the response read");
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        controller.abort(reason);
        stream.error(new Error("body source failed"));
      },
    });
    const { fetcher } = queuedFetch(new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const client = new RemoteWorkerClient("https://control.example/v1/", { fetch: fetcher });

    await expect(client.claim({
      workerId,
      sessionToken,
      waitMs: 0,
      signal: controller.signal,
    })).rejects.toMatchObject({
      metadata: { operation: "claim", workerId },
    });
  });

  it("marks enrollment and completion outcomes unknown when aborted after dispatch", async () => {
    const enrollController = new AbortController();
    const enrollReason = new Error(`caller stopped ${enrollmentToken}`);
    const enrollFetch = (async () => {
      enrollController.abort(enrollReason);
      throw enrollReason;
    }) as typeof fetch;
    const enrollClient = new RemoteWorkerClient("https://control.example/v1/", {
      fetch: enrollFetch,
    });

    const enrollmentError = await enrollClient.enroll({
      enrollmentToken,
      identity: createInMemoryWorkerIdentity(),
      version: "1.0.0",
      capabilities: {},
      signal: enrollController.signal,
    }).catch((error: unknown) => error);

    expect(enrollmentError).toBeInstanceOf(RemoteWorkerOutcomeUnknownError);
    expect(enrollmentError).toMatchObject({ metadata: { operation: "enroll" } });
    expect(String(enrollmentError)).not.toContain(enrollmentToken);
    expect(JSON.stringify(enrollmentError)).not.toContain(enrollmentToken);

    const completeController = new AbortController();
    const completeReason = new Error(`caller stopped ${sessionToken}`);
    const completeFetch = (async () => {
      completeController.abort(completeReason);
      throw completeReason;
    }) as typeof fetch;
    const completeClient = new RemoteWorkerClient("https://control.example/v1/", {
      fetch: completeFetch,
    });

    const completionError = await completeClient.complete({
      sessionToken,
      leaseId,
      expectedJobId: jobId,
      generation: 3,
      terminal: { status: "completed", resultCompleteness: "complete", errorCode: null },
      signal: completeController.signal,
    }).catch((error: unknown) => error);

    expect(completionError).toBeInstanceOf(RemoteWorkerOutcomeUnknownError);
    expect(completionError).toMatchObject({
      metadata: { operation: "complete", leaseId, generation: 3, expectedJobId: jobId },
    });
    expect(String(completionError)).not.toContain(sessionToken);
    expect(JSON.stringify(completionError)).not.toContain(sessionToken);
  });

  it("preserves abort identity before stateful dispatch and for heartbeat response reads", async () => {
    const preflightController = new AbortController();
    const preflightReason = new Error("caller stopped before dispatch");
    preflightController.abort(preflightReason);
    let dispatches = 0;
    const client = new RemoteWorkerClient("https://control.example/v1/", {
      fetch: (async () => {
        dispatches += 1;
        throw new Error("must not dispatch");
      }) as typeof fetch,
    });

    await expect(client.claim({
      workerId,
      sessionToken,
      signal: preflightController.signal,
    })).rejects.toBe(preflightReason);
    expect(dispatches).toBe(0);

    const heartbeatController = new AbortController();
    const heartbeatReason = new Error("caller stopped heartbeat response read");
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        heartbeatController.abort(heartbeatReason);
        stream.error(new Error("body source failed"));
      },
    });
    const { fetcher } = queuedFetch(new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const heartbeatClient = new RemoteWorkerClient("https://control.example/v1/", { fetch: fetcher });

    await expect(heartbeatClient.heartbeat({
      sessionToken,
      leaseId,
      generation: 3,
      signal: heartbeatController.signal,
    })).rejects.toBe(heartbeatReason);
  });

  it("keeps heartbeat transport failures distinct from the required outcome-unknown operations", async () => {
    const { fetcher } = queuedFetch(new Error("network failed"));
    const client = new RemoteWorkerClient("https://control.example/v1/", { fetch: fetcher });

    await expect(client.heartbeat({ sessionToken, leaseId, generation: 3 }))
      .rejects.toBeInstanceOf(RemoteWorkerTransportError);
  });
});
