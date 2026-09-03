import { describe, expect, it } from "vitest";

import { ReadError } from "../src/errors.js";
import {
  PublicReadRuntimeAdapter,
  type PublicReadRuntimeReader,
  type RemoteWorkerRuntimeJob,
} from "../src/remote-worker/runtime-adapter.js";
import type { PageReadArtifact } from "../src/types.js";

function publicReadJob(): RemoteWorkerRuntimeJob {
  return {
    id: "job-public-read",
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
    data_class: "public",
    placement: { class: "public" },
    budget: {
      deadline_ms: 30_000,
      max_provider_attempts: 4,
      max_document_bytes: 2_000_000,
      max_browser_ms: 10_000,
      max_browser_contexts: 2,
    },
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
      requestId: "job-public-read",
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
      requestId: "job-public-read",
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
      job: { ...publicReadJob(), data_class: "authorized" },
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
