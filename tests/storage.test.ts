import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PageCache } from "../src/cache.js";
import type { PageReadArtifact, ReadIntent, RslEvidence } from "../src/types.js";
import { rawPage } from "./helpers.js";

const stores: PageCache[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function store(): PageCache {
  const value = new PageCache(":memory:");
  stores.push(value);
  return value;
}

function intent(profileId: string | null = null): ReadIntent {
  return {
    url: "https://example.com/article",
    operation: "read",
    output: { format: "markdown" },
    freshness: { maxAgeSeconds: 900, allowStaleWhileRevalidate: false },
    authorization: { profileId, allowedOrigins: ["https://example.com"] },
    completion: { type: "content" },
    budget: {
      deadlineMs: 4_000,
      maxAttempts: 2,
      maxDocumentBytes: 2_000_000,
      maxBrowserMs: profileId === null ? 0 : 2_000,
      maxBrowserContexts: profileId === null ? 0 : 1,
      maxOptionalModelTokens: 0,
    },
  };
}

function pageArtifact(overrides: Partial<PageReadArtifact> = {}): PageReadArtifact {
  return {
    status: "ok",
    sourceUrl: "https://example.com/article",
    finalUrl: "https://example.com/article",
    fetchedAt: new Date().toISOString(),
    fetchMethod: "http",
    authProfile: null,
    cached: false,
    title: "Stored article",
    byline: null,
    publishedTime: null,
    contentMarkdown: "Stored evidence ".repeat(40),
    contentHash: "content-hash",
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
      responseBytes: 800,
      contentCharacters: 640,
      extractionMethod: "readability",
      extractorVersion: "readability-v1",
      validatorVersion: "generic-content-v1",
      requestId: "request-store",
      accessPlan: {
        planId: `plan_${"a".repeat(64)}`,
        plannerVersion: "access-planner-v1",
        plannedStages: [],
        executedStages: ["http-read"],
      },
    },
    ...overrides,
  };
}

describe("content-addressed raw and artifact storage", () => {
  it("round-trips immutable raw bytes by their content hash", () => {
    const cache = store();
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const page = rawPage({ body: "%PDF-", bodyBytes: bytes, contentType: "application/pdf" });

    const first = cache.storeRaw(page, intent());
    const second = cache.storeRaw(page, intent());
    cache.storeRaw({ ...page, contentType: "text/plain" }, intent());

    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(second).toBe(first);
    expect(cache.getRaw(first)).toEqual({
      ref: first,
      mediaType: "application/pdf",
      bytes,
      retentionClass: "shared",
    });
  });

  it("isolates immutable artifacts by intent and extractor/validator versions", () => {
    const cache = store();
    const readIntent = intent();
    const rawRef = cache.storeRaw(rawPage(), readIntent);
    const firstArtifact = pageArtifact();
    const firstKey = cache.put("lookup-v1", firstArtifact, {
      intent: readIntent,
      approvalContextHash: "approval-v1",
      rawRef,
      extractorVersion: "readability-v1",
    });
    const secondArtifact = pageArtifact({
      validation: {
        outcome: "valid",
        validatorVersion: "generic-content-v2",
        checks: [],
        terminalError: null,
      },
      evidence: {
        ...firstArtifact.evidence,
        validatorVersion: "generic-content-v2",
      },
    });
    const secondKey = cache.put("lookup-v2", secondArtifact, {
      intent: readIntent,
      approvalContextHash: "approval-v1",
      rawRef,
      extractorVersion: "readability-v1",
    });
    const extractorKey = cache.put("lookup-extractor", firstArtifact, {
      intent: readIntent,
      approvalContextHash: "approval-v1",
      rawRef,
      extractorVersion: "readability-v2",
    });
    const intentKey = cache.put("lookup-intent", firstArtifact, {
      intent: { ...readIntent, output: { format: "json", schemaId: "article-v1" } },
      approvalContextHash: "approval-v1",
      rawRef,
      extractorVersion: "readability-v1",
    });
    const authorizationKey = cache.put("lookup-authorization", firstArtifact, {
      intent: {
        ...readIntent,
        authorization: {
          profileId: null,
          allowedOrigins: ["https://example.com", "https://cdn.example.com"],
        },
      },
      approvalContextHash: "approval-v1",
      rawRef,
      extractorVersion: "readability-v1",
    });
    const licenseContextKey = cache.put("lookup-license", firstArtifact, {
      intent: readIntent,
      approvalContextHash: "approval-v2",
      rawRef,
      extractorVersion: "readability-v1",
    });

    expect(firstKey).toMatch(/^artifact:[a-f0-9]{64}$/u);
    expect(secondKey).toMatch(/^artifact:[a-f0-9]{64}$/u);
    expect(secondKey).not.toBe(firstKey);
    expect(new Set([
      firstKey,
      secondKey,
      extractorKey,
      intentKey,
      authorizationKey,
      licenseContextKey,
    ])).toHaveLength(6);
    expect(cache.getArtifact(firstKey as string)?.validation.validatorVersion).toBe(
      "generic-content-v1",
    );
    expect(cache.getArtifact(secondKey as string)?.validation.validatorVersion).toBe(
      "generic-content-v2",
    );
    expect(cache.get("lookup-v2", 900)?.contentHash).toBe("content-hash");
  });

  it.each([
    ["authorized profile", intent("research"), undefined],
    [
      "license token",
      intent(),
      {
        status: "permitted",
        usage: "ai-input",
        discoveredBy: ["http-link"],
        licenseUrls: ["https://example.com/license"],
        licenseHashes: ["license-hash"],
        approvalsApplied: 0,
        licenseTokensApplied: 1,
      } satisfies RslEvidence,
    ],
  ])("does not persist %s content in shared stores", (_name, readIntent, rsl) => {
    const cache = store();
    const page = rawPage({ ...(rsl === undefined ? {} : { rsl }) });
    const rawRef = cache.storeRaw(page, readIntent);
    const result = pageArtifact({
      authProfile: readIntent.authorization.profileId,
      evidence: { ...pageArtifact().evidence, ...(rsl === undefined ? {} : { rsl }) },
    });

    expect(cache.getRaw(rawRef)).toBeNull();
    expect(cache.put("private", result, {
      intent: readIntent,
      approvalContextHash: "approval-v1",
      rawRef,
      extractorVersion: "readability-v1",
    })).toBeNull();
    expect(cache.get("private", 900)).toBeNull();
  });

  it("cleans expired and over-capacity projections with their unreferenced CAS objects", () => {
    const cache = store();
    const readIntent = intent();
    const oldPage = rawPage({ body: "old raw", fetchedAt: new Date(Date.now() - 7_200_000).toISOString() });
    const freshPage = rawPage({ body: "fresh raw", fetchedAt: new Date().toISOString() });
    const oldRawRef = cache.storeRaw(oldPage, readIntent);
    const freshRawRef = cache.storeRaw(freshPage, readIntent);
    const oldKey = cache.put("old", pageArtifact({
      fetchedAt: oldPage.fetchedAt,
      contentHash: "old-content",
    }), {
      intent: readIntent,
      approvalContextHash: "approval-v1",
      rawRef: oldRawRef,
      extractorVersion: "readability-v1",
    });
    const freshKey = cache.put("fresh", pageArtifact({ fetchedAt: freshPage.fetchedAt }), {
      intent: readIntent,
      approvalContextHash: "approval-v1",
      rawRef: freshRawRef,
      extractorVersion: "readability-v1",
    });

    expect(cache.cleanup({ ttlSeconds: 3_600, maxArtifacts: 1 })).toMatchObject({
      projectionsDeleted: 1,
      artifactsDeleted: 1,
      rawObjectsDeleted: 1,
    });
    expect(cache.getArtifact(oldKey as string)).toBeNull();
    expect(cache.getRaw(oldRawRef)).toBeNull();
    expect(cache.getArtifact(freshKey as string)).not.toBeNull();
  });

  it("runs bounded retention cleanup when a persistent cache starts", () => {
    const directory = mkdtempSync(join(tmpdir(), "crawlume-cache-retention-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "cache.sqlite");
    const first = new PageCache(path);
    const readIntent = intent();
    const expiredPage = rawPage({
      fetchedAt: new Date(Date.now() - 31 * 86_400_000).toISOString(),
    });
    const rawRef = first.storeRaw(expiredPage, readIntent);
    const artifactKey = first.put("expired", pageArtifact({
      fetchedAt: expiredPage.fetchedAt,
    }), {
      intent: readIntent,
      approvalContextHash: "approval-v1",
      rawRef,
      extractorVersion: "readability-v1",
    });
    first.close();

    const reopened = new PageCache(path);
    stores.push(reopened);
    expect(reopened.getArtifact(artifactKey as string)).toBeNull();
    expect(reopened.getRaw(rawRef)).toBeNull();
  });

  it("updates mutable HTTP validators without changing the immutable artifact", () => {
    const cache = store();
    const readIntent = intent();
    const rawRef = cache.storeRaw(rawPage(), readIntent);
    const artifactKey = cache.put("validators", pageArtifact(), {
      intent: readIntent,
      approvalContextHash: "approval-v1",
      rawRef,
      extractorVersion: "readability-v1",
    }, {
      etag: '"article-v1"',
    });

    cache.markRevalidated("validators", {
      etag: '"article-v2"',
      lastModified: "Sun, 30 Aug 2026 10:00:00 GMT",
    });

    expect(cache.lookup("validators")).toMatchObject({
      artifactKey,
      etag: '"article-v2"',
      lastModified: "Sun, 30 Aug 2026 10:00:00 GMT",
    });
    expect(cache.getArtifact(artifactKey as string)?.contentHash).toBe("content-hash");
  });
});
