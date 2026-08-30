import { afterEach, describe, expect, it } from "vitest";

import { LocalPageIndex } from "../src/index.js";
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
    validation: { status: "usable", warnings: [] },
    discoveredLinks: [],
    evidence: {
      httpStatus: 200,
      contentType: "text/html",
      responseBytes: 100,
      contentCharacters: 70,
      extractionMethod: "readability",
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
    index.put(artifact());

    expect(index.count()).toBe(1);
    expect(index.search("MiniMax H3", 10, 1)).toEqual([
      expect.objectContaining({
        title: "MiniMax H3 inference guide",
        url: "https://example.com/article",
        source: "local",
        engines: ["diaoyan-local"],
      }),
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
});
