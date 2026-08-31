import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PageCache } from "../src/cache.js";
import { LocalPageIndex, localSearchIndexerVersion } from "../src/index.js";
import { ReaderService } from "../src/reader.js";
import { UrlPolicy } from "../src/security/url-policy.js";
import type { PageReadArtifact, ReadIntent } from "../src/types.js";
import { publicResolver, rawPage, StubFetcher, testConfig } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function dataPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "diaoyan-page-history-"));
  temporaryDirectories.push(directory);
  return join(directory, "data.sqlite");
}

function pageArtifact(overrides: Partial<PageReadArtifact> = {}): PageReadArtifact {
  return {
    status: "ok",
    sourceUrl: "https://example.com/requested",
    finalUrl: "https://example.com/final",
    fetchedAt: "2026-08-01T00:00:00.000Z",
    fetchMethod: "http",
    authProfile: null,
    cached: false,
    title: "Versioned documentation",
    byline: null,
    publishedTime: null,
    contentMarkdown: "Versioned documentation about durable page history.",
    contentHash: "hash-one",
    completeness: "complete",
    validation: {
      outcome: "valid",
      validatorVersion: "generic-content-v1",
      checks: [],
      terminalError: null,
    },
    discoveredLinks: [],
    evidence: {
      httpStatus: 200,
      contentType: "text/html",
      responseBytes: 900,
      contentCharacters: 600,
      extractionMethod: "readability",
      extractorVersion: "readability-v1",
      validatorVersion: "generic-content-v1",
      requestId: "request-one",
      accessPlan: {
        planId: `plan_${"a".repeat(64)}`,
        plannerVersion: "access-planner-v1",
        plannedStages: [],
        executedStages: ["http-read"],
      },
      urlIdentity: {
        redirects: [{
          fromUrl: "https://example.com/requested",
          toUrl: "https://example.com/final",
          httpStatus: 308,
        }],
        declaredCanonicalUrl: "https://example.com/canonical",
      },
    },
    ...overrides,
  };
}

function intent(): ReadIntent {
  return {
    url: "https://example.com/requested",
    operation: "crawl",
    output: { format: "markdown" },
    freshness: { maxAgeSeconds: 0, allowStaleWhileRevalidate: false },
    authorization: { profileId: null, allowedOrigins: ["https://example.com"] },
    completion: { type: "content" },
    budget: {
      deadlineMs: 5_000,
      maxAttempts: 1,
      maxDocumentBytes: 1_000_000,
      maxBrowserMs: 0,
      maxBrowserContexts: 0,
      maxOptionalModelTokens: 0,
    },
  };
}

describe("long-term page history", () => {
  it("persists auditable URL identity observations and aggregates content versions", () => {
    const index = new LocalPageIndex(":memory:");
    try {
      index.put(pageArtifact(), { artifactKey: "artifact:one", rawRef: "sha256:one" });
      index.put(pageArtifact({
        fetchedAt: "2026-08-02T00:00:00.000Z",
        evidence: { ...pageArtifact().evidence, requestId: "request-two" },
      }), { artifactKey: "artifact:one", rawRef: "sha256:one" });
      index.put(pageArtifact({
        fetchedAt: "2026-08-03T00:00:00.000Z",
        contentHash: "hash-two",
        title: "Changed documentation",
        evidence: {
          ...pageArtifact().evidence,
          requestId: "request-three",
          extractorVersion: "readability-v2",
        },
      }), { artifactKey: "artifact:two", rawRef: "sha256:two" });

      const history = index.history("https://example.com/final");
      expect(history.observations).toHaveLength(3);
      expect(history.observations[0]).toMatchObject({
        requestId: "request-one",
        artifactKey: "artifact:one",
        rawRef: "sha256:one",
        requestedUrl: "https://example.com/requested",
        finalUrl: "https://example.com/final",
        redirects: [{
          fromUrl: "https://example.com/requested",
          toUrl: "https://example.com/final",
          httpStatus: 308,
        }],
        declaredCanonicalUrl: "https://example.com/canonical",
        parserVersion: "readability-v1",
        indexerVersion: localSearchIndexerVersion,
      });
      expect(history.versions).toEqual([
        expect.objectContaining({
          artifactKey: "artifact:one",
          contentHash: "hash-one",
          observationCount: 2,
          firstObservedAt: "2026-08-01T00:00:00.000Z",
          lastObservedAt: "2026-08-02T00:00:00.000Z",
        }),
        expect.objectContaining({
          artifactKey: "artifact:two",
          contentHash: "hash-two",
          observationCount: 1,
        }),
      ]);
    } finally {
      index.close();
    }
  });

  it("rejects a request ID that is reused for a different history observation", () => {
    const index = new LocalPageIndex(":memory:");
    try {
      index.put(pageArtifact(), { artifactKey: "artifact:one", rawRef: "sha256:one" });

      expect(() => index.put(pageArtifact({
        finalUrl: "https://example.com/different",
        contentHash: "different-hash",
      }), { artifactKey: "artifact:different", rawRef: "sha256:different" }))
        .toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    } finally {
      index.close();
    }
  });

  it("captures redirect and declared canonical identity through the real reader publication path", async () => {
    const path = dataPath();
    const index = new LocalPageIndex(path);
    const body = `<html><head><title>Canonical guide</title><link rel="canonical" href="/canonical"></head><body><main>${"complete canonical documentation ".repeat(30)}</main></body></html>`;
    const reader = new ReaderService(
      { ...testConfig(), cachePath: path },
      new UrlPolicy(async () => publicResolver()),
      new PageCache(path),
      new StubFetcher(rawPage({
        body,
        responseBytes: Buffer.byteLength(body),
        finalUrl: "https://example.com/final",
        redirects: [{
          fromUrl: "https://example.com/requested",
          toUrl: "https://example.com/final",
          httpStatus: 301,
        }],
      })),
      new StubFetcher(new Error("browser must not run")),
      index,
    );
    try {
      await reader.readPage({
        url: "https://example.com/requested",
        browserAllowed: false,
        cacheMode: "live",
      });

      expect(index.history("https://example.com/final").observations[0]).toMatchObject({
        requestedUrl: "https://example.com/requested",
        redirects: [{
          fromUrl: "https://example.com/requested",
          toUrl: "https://example.com/final",
          httpStatus: 301,
        }],
        declaredCanonicalUrl: "https://example.com/canonical",
      });
    } finally {
      await reader.close();
      index.close();
    }
  });

  it("retains historical Raw/Artifact dependencies and rebuilds FTS offline", () => {
    const path = dataPath();
    const cache = new PageCache(path);
    const index = new LocalPageIndex(path);
    try {
      const page = pageArtifact();
      const rawRef = cache.storeRaw(rawPage(), intent());
      const artifactKey = cache.put("history-cache-key", page, {
        intent: intent(),
        approvalContextHash: "approval-v1",
        rawRef,
        extractorVersion: page.evidence.extractorVersion,
      });
      expect(artifactKey).not.toBeNull();
      index.put(page, { artifactKey: artifactKey!, rawRef });

      cache.cleanup({ ttlSeconds: 0, maxArtifacts: 0 });
      expect(cache.getRaw(rawRef)).not.toBeNull();
      expect(cache.getArtifact(artifactKey!)).not.toBeNull();

      const database = new DatabaseSync(path);
      database.prepare(
        "UPDATE indexed_pages SET title = ?, content_markdown = ? WHERE final_url = ?",
      ).run("Corrupted projection", "corrupted projection only", page.finalUrl);
      database.close();
      expect(index.search("corrupted", 10, 1)).toHaveLength(1);

      expect(index.rebuildProjection()).toMatchObject({
        indexedPages: 1,
        indexerVersion: localSearchIndexerVersion,
        parserVersions: ["readability-v1"],
      });
      expect(index.search("durable page history", 10, 1)).toHaveLength(1);
      expect(index.search("corrupted", 10, 1)).toEqual([]);
    } finally {
      index.close();
      cache.close();
    }
  });

  it("computes deterministic recrawl priority from unchanged and changed observations", () => {
    const index = new LocalPageIndex(":memory:");
    try {
      const observed = (url: string, requestId: string, fetchedAt: string, hash: string): void => {
        const page = pageArtifact({
          sourceUrl: url,
          finalUrl: url,
          fetchedAt,
          contentHash: hash,
          evidence: { ...pageArtifact().evidence, requestId, urlIdentity: {
            redirects: [], declaredCanonicalUrl: null,
          } },
        });
        index.put(page, { artifactKey: `artifact:${url}:${hash}`, rawRef: `raw:${hash}` });
      };
      observed("https://example.com/changed", "changed-1", "2026-08-01T00:00:00.000Z", "a");
      observed("https://example.com/changed", "changed-2", "2026-08-02T00:00:00.000Z", "b");
      observed("https://example.com/changed", "changed-3", "2026-08-03T00:00:00.000Z", "c");
      observed("https://example.com/stable", "stable-1", "2026-08-01T00:00:00.000Z", "x");
      observed("https://example.com/stable", "stable-2", "2026-08-02T00:00:00.000Z", "x");
      observed("https://example.com/stable", "stable-3", "2026-08-03T00:00:00.000Z", "x");

      expect(index.recrawlPriorities("2026-08-10T00:00:00.000Z", [
        "https://example.com/stable",
        "https://example.com/unseen",
        "https://example.com/changed",
      ])).toEqual([
        expect.objectContaining({ url: "https://example.com/unseen", reason: "unseen" }),
        expect.objectContaining({ url: "https://example.com/changed", changeRate: 1 }),
        expect.objectContaining({ url: "https://example.com/stable", changeRate: 0 }),
      ]);
    } finally {
      index.close();
    }
  });
});
