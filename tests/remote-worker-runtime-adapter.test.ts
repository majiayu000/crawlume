import { describe, expect, it } from "vitest";

import { ReadError } from "../src/errors.js";
import { RemoteWorkerClient } from "../src/remote-worker/client.js";
import {
  PublicReadRuntimeAdapter,
  type PublicReadRuntimeReader,
  type RemoteWorkerRuntimeJob,
} from "../src/remote-worker/runtime-adapter.js";
import type { PageReadArtifact } from "../src/types.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const workerId = "22222222-2222-4222-8222-222222222222";
const leaseId = "33333333-3333-4333-8333-333333333333";

function publicReadJob(): RemoteWorkerRuntimeJob {
  return {
    id: jobId,
    type: "read",
    input: {
      url: "https://example.com/article",
      browserAllowed: true,
      cacheMode: "live",
      maxAgeSeconds: 120,
      browserReadiness: {
        target: { selector: "main", state: "visible", minCount: 1 },
        timeoutMs: 5_000,
      },
    },
    dataClass: "public",
    placement: { class: "public", pinnedWorkerId: null },
    requiredCapabilities: { http: true },
    budget: {
      deadlineMs: 30_000,
      maxProviderAttempts: 4,
      maxDocumentBytes: 2_000_000,
      maxBrowserMs: 10_000,
      maxBrowserContexts: 2,
    },
    policyVersion: "policy-v1",
    uploadPrivateArtifact: false,
    priority: 0,
    notBefore: new Date("2026-09-03T00:00:00.000Z"),
    deadlineAt: new Date("2026-09-03T00:01:00.000Z"),
    status: "running",
    resultCompleteness: null,
    errorCode: null,
  };
}

function pageArtifact(): PageReadArtifact {
  return {
    status: "ok",
    sourceUrl: "https://example.com/article",
    finalUrl: "https://example.com/article",
    fetchedAt: "2026-09-03T00:00:00.000Z",
    fetchMethod: "http",
    authProfile: null,
    cached: false,
    title: "Example article",
    byline: null,
    publishedTime: null,
    contentMarkdown: "Complete article content.",
    contentHash: "a".repeat(64),
    completeness: "complete",
    validation: {
      outcome: "valid",
      validatorVersion: "generic-content-v1",
      checks: [],
      terminalError: null,
    },
    discoveredLinks: ["https://example.com/related"],
    evidence: {
      httpStatus: 200,
      contentType: "text/html",
      responseBytes: 123,
      contentCharacters: 25,
      extractionMethod: "readability",
      extractorVersion: "readability-v1",
      validatorVersion: "generic-content-v1",
      requestId: jobId,
      accessPlan: {
        planId: `plan_${"a".repeat(64)}`,
        plannerVersion: "access-planner-v1",
        plannedStages: [{
          stageId: "http-read",
          provider: "http",
          reasonCode: "HTTP_PRIMARY",
        }],
        executedStages: ["http-read"],
      },
    },
  };
}

describe("PublicReadRuntimeAdapter", () => {
  it("maps a verified public read Job to the existing Reader exactly once", async () => {
    const artifact = pageArtifact();
    const calls: Parameters<PublicReadRuntimeReader["readPageArtifact"]>[0][] = [];
    const reader: PublicReadRuntimeReader = {
      async readPageArtifact(options) {
        calls.push(options);
        return artifact;
      },
    };
    const signal = new AbortController().signal;

    const result = await new PublicReadRuntimeAdapter(reader).execute(publicReadJob(), signal);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      url: "https://example.com/article",
      browserAllowed: true,
      cacheMode: "live",
      maxAgeSeconds: 120,
      browserReadiness: {
        target: { selector: "main", state: "visible", minCount: 1 },
        timeoutMs: 5_000,
      },
      requestId: jobId,
      budget: {
        deadlineMs: 30_000,
        maxAttempts: 4,
        maxDocumentBytes: 2_000_000,
        maxBrowserMs: 10_000,
        maxBrowserContexts: 2,
        maxOptionalModelTokens: 0,
      },
      signal,
    });
    const { discoveredLinks: _discoveredLinks, ...expected } = artifact;
    expect(result).toEqual(expected);
    expect(result).not.toHaveProperty("discoveredLinks");
  });

  it.each([
    {
      name: "a non-read type",
      job: { ...publicReadJob(), type: "search", input: { query: "example" } },
      details: { jobType: "search" },
    },
    {
      name: "non-public data",
      job: { ...publicReadJob(), dataClass: "authorized" },
      details: { dataClass: "authorized" },
    },
    {
      name: "private placement",
      job: { ...publicReadJob(), placement: { class: "private" } },
      details: { placementClass: "private" },
    },
  ] as const)("rejects $name before invoking the Reader", async ({ job, details }) => {
    let calls = 0;
    const reader: PublicReadRuntimeReader = {
      async readPageArtifact() {
        calls += 1;
        return pageArtifact();
      },
    };

    await expect(new PublicReadRuntimeAdapter(reader).execute(
      job as RemoteWorkerRuntimeJob,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details });
    expect(calls).toBe(0);
  });

  it("executes the normalized Job returned by RemoteWorkerClient.claim", async () => {
    const client = new RemoteWorkerClient("http://127.0.0.1:9876/v1", {
      fetch: async () => new Response(JSON.stringify({
        request_id: "44444444-4444-4444-8444-444444444444",
        job: {
          id: jobId,
          type: "read",
          input: { url: "https://example.com/article", browserAllowed: false },
          data_class: "public",
          placement: { class: "public", pinned_worker_id: null },
          required_capabilities: { http: true },
          budget: {
            deadline_ms: 45_000,
            max_provider_attempts: 3,
            max_document_bytes: 1_000_000,
            max_browser_ms: 0,
            max_browser_contexts: 0,
          },
          policy_version: "policy-v1",
          upload_private_artifact: false,
          priority: 0,
          not_before: "2026-09-03T00:00:00.000Z",
          deadline_at: "2026-09-03T00:01:00.000Z",
          status: "running",
          result_completeness: null,
          error_code: null,
        },
        lease: {
          id: leaseId,
          job_id: jobId,
          generation: 1,
          heartbeat_deadline: "2026-09-03T00:00:30.000Z",
          lease_deadline: "2026-09-03T00:01:00.000Z",
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const claim = await client.claim({
      workerId,
      sessionToken: "header.payload.signature",
    });
    if (claim === null) throw new Error("The integration claim unexpectedly returned no Job.");
    const calls: Parameters<PublicReadRuntimeReader["readPageArtifact"]>[0][] = [];
    const reader: PublicReadRuntimeReader = {
      async readPageArtifact(options) {
        calls.push(options);
        return pageArtifact();
      },
    };
    const signal = new AbortController().signal;

    await new PublicReadRuntimeAdapter(reader).execute(claim.job, signal);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      requestId: jobId,
      budget: {
        deadlineMs: 45_000,
        maxAttempts: 3,
        maxDocumentBytes: 1_000_000,
        maxBrowserMs: 0,
        maxBrowserContexts: 0,
        maxOptionalModelTokens: 0,
      },
      signal,
    });
  });

  it("preserves ReadError identity and normalizes unknown Reader failures", async () => {
    const expected = new ReadError("ACCESS_DENIED", "The page is not accessible.");
    const existingErrorReader: PublicReadRuntimeReader = {
      async readPageArtifact() {
        throw expected;
      },
    };
    const unknownErrorReader: PublicReadRuntimeReader = {
      async readPageArtifact() {
        throw new Error("unexpected implementation detail");
      },
    };
    const signal = new AbortController().signal;

    await expect(new PublicReadRuntimeAdapter(existingErrorReader).execute(publicReadJob(), signal))
      .rejects.toBe(expected);
    await expect(new PublicReadRuntimeAdapter(unknownErrorReader).execute(publicReadJob(), signal))
      .rejects.toMatchObject({
        name: "ReadError",
        code: "INTERNAL_ERROR",
        message: "The web reader failed unexpectedly.",
      });
  });
});
