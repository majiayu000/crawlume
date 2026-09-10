import { afterEach, describe, expect, it } from "vitest";

import { LocalPageIndex } from "../src/index.js";
import { ReadError } from "../src/errors.js";
import type { PageReadArtifact } from "../src/types.js";

const indexes: LocalPageIndex[] = [];

function createIndex(): LocalPageIndex {
  const index = new LocalPageIndex(":memory:");
  indexes.push(index);
  return index;
}

function artifact(overrides: Partial<PageReadArtifact> = {}): PageReadArtifact {
  return {
    status: "ok",
    sourceUrl: "https://example.com/source",
    finalUrl: "https://example.com/article",
    fetchedAt: new Date().toISOString(),
    fetchMethod: "http",
    authProfile: null,
    cached: false,
    title: "MiniMax H3 inference guide",
    byline: null,
    publishedTime: "2026-08-01T00:00:00.000Z",
    contentMarkdown: "MiniMax H3 includes practical inference optimization techniques.",
    contentHash: "hash-one",
    completeness: "complete",
    validation: { outcome: "valid", validatorVersion: "generic-content-v1", checks: [], terminalError: null },
    discoveredLinks: [],
    evidence: {
      httpStatus: 200,
      contentType: "text/html",
      responseBytes: 100,
      contentCharacters: 70,
      extractionMethod: "readability",
      extractorVersion: "readability-v1",
      validatorVersion: "generic-content-v1",
      requestId: "request-test",
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
    ...overrides,
  };
}

afterEach(() => {
  while (indexes.length > 0) {
    indexes.pop()?.close();
  }
});

describe("LocalPageIndex", () => {
  it("indexes public pages and returns normalized local results", () => {
    const index = createIndex();
    index.put(artifact({ fetchedAt: "2026-08-01T00:00:00.000Z" }));

    expect(index.count()).toBe(1);
    expect(index.search("MiniMax H3", 10, 1)).toEqual([
      expect.objectContaining({
        title: "MiniMax H3 inference guide",
        url: "https://example.com/article",
        source: "local",
        engines: ["crawlume-local"],
      }),
    ]);
  });

  it("matches Chinese queries against Chinese page text", () => {
    const index = createIndex();
    index.put(artifact({
      title: "推理优化指南",
      contentMarkdown: "本文介绍推理优化与批处理吞吐。",
      finalUrl: "https://example.com/zh",
    }));

    expect(index.search("推理优化", 10, 1)).toEqual([
      expect.objectContaining({ url: "https://example.com/zh", title: "推理优化指南" }),
    ]);
  });

  it("updates an existing final URL instead of duplicating it", () => {
    const index = createIndex();
    index.put(artifact());
    index.put(artifact({
      title: "Updated model serving guide",
      contentMarkdown: "A replacement article about speculative decoding.",
      contentHash: "hash-two",
    }));

    expect(index.count()).toBe(1);
    expect(index.search("MiniMax", 10, 1)).toEqual([]);
    expect(index.search("speculative decoding", 10, 1)).toEqual([
      expect.objectContaining({ title: "Updated model serving guide" }),
    ]);
  });

  it("never indexes pages read with an authorization profile", () => {
    const index = createIndex();
    index.put(artifact({ authProfile: "research" }));

    expect(index.count()).toBe(0);
    expect(index.search("MiniMax", 10, 1)).toEqual([]);
  });

  it("records distinct content versions without duplicating unchanged refreshes", () => {
    const index = createIndex();
    index.put(artifact({ fetchedAt: "2026-08-01T00:00:00.000Z" }));
    index.put(artifact({ fetchedAt: "2026-08-02T00:00:00.000Z" }));
    index.put(artifact({
      contentHash: "hash-two",
      fetchedAt: "2026-08-03T00:00:00.000Z",
      evidence: {
        ...artifact().evidence,
        extractorVersion: "readability-v2",
        validatorVersion: "generic-content-v2",
      },
      validation: {
        outcome: "valid",
        validatorVersion: "generic-content-v2",
        checks: [],
        terminalError: null,
      },
    }));

    expect(index.versions("https://example.com/article")).toEqual([
      expect.objectContaining({
        contentHash: "hash-one",
        extractorVersion: "readability-v1",
        validatorVersion: "generic-content-v1",
      }),
      expect.objectContaining({
        contentHash: "hash-two",
        extractorVersion: "readability-v2",
        validatorVersion: "generic-content-v2",
      }),
    ]);
  });

  it("rejects a new page at capacity while allowing an existing page to update", () => {
    const index = new LocalPageIndex(":memory:", 1);
    indexes.push(index);
    index.put(artifact());

    expect(() => index.put(artifact({
      sourceUrl: "https://example.com/second",
      finalUrl: "https://example.com/second",
    }))).toThrowError(expect.objectContaining<Partial<ReadError>>({ code: "BUDGET_EXHAUSTED" }));

    index.put(artifact({ contentHash: "hash-updated", title: "Updated in place" }));
    expect(index.count()).toBe(1);
    expect(index.versions("https://example.com/article")).toHaveLength(2);
  });
});
