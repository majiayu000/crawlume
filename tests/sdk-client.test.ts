import { describe, expect, it } from "vitest";

import { ControlPlaneError, CrawlumeClient, type CreateJobRequest, type Job } from "../src/sdk/client.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";

const request: CreateJobRequest = {
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
};

function job(status: Job["status"]): Job {
  return {
    ...request,
    id: jobId,
    priority: 0,
    not_before: "2026-10-22T00:00:00.000Z",
    deadline_at: "2026-10-22T00:05:00.000Z",
    status,
    result_completeness: null,
    error_code: null,
  };
}

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };

function fakeFetch(responses: Array<() => Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: init?.body as string | undefined,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected request");
    return next();
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): () => Response {
  return () => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": status < 400 ? "application/json" : "application/problem+json", ...headers },
  });
}

function problem(status: number, code: string, retryable: boolean) {
  return {
    type: "about:blank",
    title: code,
    status,
    detail: `${code} detail`,
    instance: "/v1/x",
    code,
    request_id: "33333333-3333-4333-8333-333333333333",
    retryable,
  };
}

function client(fetchImpl: typeof fetch, maxRetries = 3): CrawlumeClient {
  return new CrawlumeClient({
    baseUrl: "https://control.example/v1/",
    apiKey: "dya_live_test",
    projectId,
    fetch: fetchImpl,
    maxRetries,
    retryBaseMs: 1,
  });
}

describe("CrawlumeClient", () => {
  it("creates a Job with bearer auth and a generated Idempotency-Key", async () => {
    const fake = fakeFetch([json(201, { request_id: "r", job: job("accepted") })]);
    await expect(client(fake.fetch).createJob(request)).resolves.toMatchObject({ id: jobId });
    const call = fake.calls[0]!;
    expect(call.url).toBe(`https://control.example/v1/projects/${projectId}/jobs`);
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe("Bearer dya_live_test");
    expect(call.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.parse(call.body!)).toEqual(request);
  });

  it("keeps a caller-provided Idempotency-Key across retries", async () => {
    const fake = fakeFetch([
      json(503, problem(503, "UNAVAILABLE", true), { "retry-after": "0" }),
      json(201, { request_id: "r", job: job("accepted") }),
    ]);
    await client(fake.fetch).createJob(request, { idempotencyKey: "fixed-key" });
    expect(fake.calls.map((call) => call.headers["idempotency-key"])).toEqual(["fixed-key", "fixed-key"]);
  });

  it("throws typed problems and does not retry non-retryable errors", async () => {
    const fake = fakeFetch([json(409, problem(409, "IDEMPOTENCY_CONFLICT", false))]);
    const error = await client(fake.fetch).createJob(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ControlPlaneError);
    expect(error).toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
      retryable: false,
      requestId: "33333333-3333-4333-8333-333333333333",
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("stops retrying after maxRetries", async () => {
    const fake = fakeFetch([
      json(503, problem(503, "UNAVAILABLE", true)),
      json(503, problem(503, "UNAVAILABLE", true)),
      json(503, problem(503, "UNAVAILABLE", true)),
    ]);
    await expect(client(fake.fetch, 2).getJob(jobId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(fake.calls).toHaveLength(3);
  });

  it("reports non-JSON failures with the HTTP status", async () => {
    const fake = fakeFetch([() => new Response("bad gateway", { status: 502 })]);
    await expect(client(fake.fetch).getJob(jobId)).rejects.toMatchObject({
      status: 502,
      code: "HTTP_ERROR",
      retryable: false,
      problem: null,
    });
  });

  it("follows the publication cursor until has_more is false", async () => {
    const publication = (sequence: number) => ({ id: `p${sequence}`, sequence });
    const fake = fakeFetch([
      json(200, { request_id: "r", publications: [publication(1), publication(2)], pagination: { next_sequence: 2, has_more: true, limit: 2 } }),
      json(200, { request_id: "r", publications: [publication(3)], pagination: { next_sequence: null, has_more: false, limit: 2 } }),
    ]);
    const sequences: number[] = [];
    for await (const item of client(fake.fetch).publications(jobId, { limit: 2 })) sequences.push(item.sequence);
    expect(sequences).toEqual([1, 2, 3]);
    expect(fake.calls.map((call) => new URL(call.url).search)).toEqual([
      "?limit=2",
      "?after_sequence=2&limit=2",
    ]);
  });

  it("waits for a terminal Job and fails clearly on timeout", async () => {
    const terminal = fakeFetch([
      json(200, { request_id: "r", job: job("running") }),
      json(200, { request_id: "r", job: job("completed") }),
    ]);
    await expect(client(terminal.fetch).waitForJob(jobId, { intervalMs: 1 }))
      .resolves.toMatchObject({ status: "completed" });

    const running = fakeFetch(Array.from({ length: 100 }, () => json(200, { request_id: "r", job: job("running") })));
    await expect(client(running.fetch).waitForJob(jobId, { timeoutMs: 20, intervalMs: 5 }))
      .rejects.toThrow(`Job ${jobId} was still running`);
  });

  it("sends empty JSON bodies for Job transitions", async () => {
    const fake = fakeFetch([
      json(200, { request_id: "r", job: job("paused") }),
      json(200, { request_id: "r", job: job("queued") }),
      json(200, { request_id: "r", job: job("cancelled") }),
    ]);
    const sdk = client(fake.fetch);
    await sdk.pauseJob(jobId);
    await sdk.resumeJob(jobId);
    await sdk.cancelJob(jobId);
    expect(fake.calls.map((call) => [new URL(call.url).pathname.split("/").at(-1), call.body]))
      .toEqual([["pause", "{}"], ["resume", "{}"], ["cancel", "{}"]]);
  });
});
