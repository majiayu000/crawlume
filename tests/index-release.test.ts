import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PageCache } from "../src/cache.js";
import { ReadError } from "../src/errors.js";
import { LocalPageIndex } from "../src/index.js";
import { LocalIndexReleaseStore } from "../src/index-release.js";
import type { PageReadArtifact, ReadIntent } from "../src/types.js";
import { rawPage } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function dataPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "diaoyan-index-release-"));
  temporaryDirectories.push(directory);
  return join(directory, "data.sqlite");
}

function intent(url: string): ReadIntent {
  return {
    url,
    operation: "crawl",
    output: { format: "markdown" },
    freshness: { maxAgeSeconds: 0, allowStaleWhileRevalidate: false },
    authorization: { profileId: null, allowedOrigins: [new URL(url).origin] },
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

function artifact(version: "one" | "two", requestId = `request-${version}`): PageReadArtifact {
  const current = version === "one";
  return {
    status: "ok",
    sourceUrl: "https://example.com/guide",
    finalUrl: "https://example.com/guide",
    fetchedAt: current ? "2026-08-01T00:00:00.000Z" : "2026-08-02T00:00:00.000Z",
    fetchMethod: "http",
    authProfile: null,
    cached: false,
    title: current ? "Stable release one" : "Candidate release two",
    byline: null,
    publishedTime: null,
    contentMarkdown: current
      ? "Stable release one documentation content."
      : "Candidate release two documentation content.",
    contentHash: current ? "hash-one" : "hash-two",
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
      contentCharacters: 600,
      extractionMethod: "readability",
      extractorVersion: "readability-v1",
      validatorVersion: "generic-content-v1",
      requestId,
      accessPlan: {
        planId: `plan_${"a".repeat(64)}`,
        plannerVersion: "access-planner-v1",
        plannedStages: [],
        executedStages: ["http-read"],
      },
      urlIdentity: { redirects: [], declaredCanonicalUrl: null },
    },
  };
}

function publish(index: LocalPageIndex, cache: PageCache, page: PageReadArtifact): string {
  const readIntent = intent(page.sourceUrl);
  const rawRef = cache.storeRaw(rawPage({
    body: `<html><body>${page.contentMarkdown}</body></html>`,
    finalUrl: page.finalUrl,
  }), readIntent);
  const artifactKey = cache.put(`release:${page.evidence.requestId}`, page, {
    intent: readIntent,
    approvalContextHash: "approval-v1",
    rawRef,
    extractorVersion: page.evidence.extractorVersion,
  });
  expect(artifactKey).not.toBeNull();
  index.put(page, { artifactKey: artifactKey!, rawRef });
  return artifactKey!;
}

function expectCode(operation: () => unknown, code: ReadError["code"]): void {
  expect(operation).toThrowError(expect.objectContaining<Partial<ReadError>>({ code }));
}

describe("local index releases", () => {
  it("rejects an empty projection", () => {
    const path = dataPath();
    const index = new LocalPageIndex(path);
    try {
      const releases = new LocalIndexReleaseStore(path);
      try {
        expectCode(() => releases.createRelease(), "INVALID_ARGUMENT");
      } finally {
        releases.close();
      }
    } finally {
      index.close();
    }
  });

  it("creates one immutable content-verifiable manifest and activates it explicitly", () => {
    const path = dataPath();
    const cache = new PageCache(path);
    let index = new LocalPageIndex(path);
    let releases = new LocalIndexReleaseStore(path);
    try {
      const artifactKey = publish(index, cache, artifact("one"));
      const release = releases.createRelease();

      expect(release).toMatchObject({
        id: expect.stringMatching(/^release_[a-f0-9]{64}$/u),
        manifestHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        status: "complete",
        active: false,
        manifest: {
          schemaVersion: "local-index-release-v1",
          documentCount: 1,
          documents: [{
            finalUrl: "https://example.com/guide",
            requestId: "request-one",
            artifactKey,
            contentHash: "hash-one",
            projectionHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          }],
        },
      });
      expect("contentMarkdown" in release.manifest.documents[0]!).toBe(false);
      expect(releases.activeRelease()).toBeNull();
      expectCode(() => releases.createRelease(), "INVALID_ARGUMENT");

      expect(releases.activateRelease(release.id)).toMatchObject({ id: release.id, active: true });
      expect(releases.activeRelease()).toMatchObject({ id: release.id, active: true });

      releases.close();
      index.close();
      index = new LocalPageIndex(path);
      releases = new LocalIndexReleaseStore(path);
      expect(releases.activeRelease()).toMatchObject({ id: release.id, active: true });
    } finally {
      releases.close();
      index.close();
      cache.close();
    }
  });

  it("prevents manifest mutation and detects tampering before activation", () => {
    const path = dataPath();
    const cache = new PageCache(path);
    const index = new LocalPageIndex(path);
    const releases = new LocalIndexReleaseStore(path);
    const database = new DatabaseSync(path);
    try {
      publish(index, cache, artifact("one"));
      const stable = releases.createRelease();
      releases.activateRelease(stable.id);
      publish(index, cache, artifact("two"));
      const candidate = releases.createRelease();
      releases.activateRelease(stable.id);

      expect(() => database.prepare(
        "UPDATE local_index_releases SET manifest_json = '{}' WHERE release_id = ?",
      ).run(candidate.id)).toThrow();

      database.exec("DROP TRIGGER local_index_releases_immutable_update");
      database.prepare(
        "UPDATE local_index_releases SET manifest_json = '{}' WHERE release_id = ?",
      ).run(candidate.id);

      expectCode(() => releases.activateRelease(candidate.id), "INTERNAL_ERROR");
      expect(releases.activeRelease()?.id).toBe(stable.id);
      expect(index.search("Stable release one", 10, 1)).toHaveLength(1);
    } finally {
      database.close();
      releases.close();
      index.close();
      cache.close();
    }
  });

  it("clears the active release when ordinary indexing changes the projection", () => {
    const path = dataPath();
    const cache = new PageCache(path);
    const index = new LocalPageIndex(path);
    const releases = new LocalIndexReleaseStore(path);
    try {
      publish(index, cache, artifact("one"));
      const release = releases.createRelease();
      releases.activateRelease(release.id);

      publish(index, cache, artifact("two"));

      expect(releases.activeRelease()).toBeNull();
      expect(index.search("Candidate release two", 10, 1)).toHaveLength(1);
    } finally {
      releases.close();
      index.close();
      cache.close();
    }
  });

  it("does not report an active release whose Artifact dependency is no longer rebuildable", () => {
    const path = dataPath();
    const cache = new PageCache(path);
    const index = new LocalPageIndex(path);
    const releases = new LocalIndexReleaseStore(path);
    const database = new DatabaseSync(path);
    try {
      const artifactKey = publish(index, cache, artifact("one"));
      const release = releases.createRelease();
      releases.activateRelease(release.id);
      database.prepare("DELETE FROM artifact_cache_entries WHERE artifact_key = ?").run(artifactKey);
      database.prepare("DELETE FROM artifacts WHERE artifact_key = ?").run(artifactKey);

      expectCode(() => releases.activeRelease(), "INTERNAL_ERROR");
    } finally {
      database.close();
      releases.close();
      index.close();
      cache.close();
    }
  });

  it("rejects Artifact projection tampering before activation", () => {
    const path = dataPath();
    const cache = new PageCache(path);
    const index = new LocalPageIndex(path);
    const releases = new LocalIndexReleaseStore(path);
    const database = new DatabaseSync(path);
    try {
      const artifactKey = publish(index, cache, artifact("one"));
      const release = releases.createRelease();
      const stored = database.prepare(
        "SELECT result_json FROM artifacts WHERE artifact_key = ?",
      ).get(artifactKey) as { result_json: string };
      const tampered = JSON.parse(stored.result_json) as PageReadArtifact;
      tampered.title = "Tampered release title";
      database.prepare("UPDATE artifacts SET result_json = ? WHERE artifact_key = ?")
        .run(JSON.stringify(tampered), artifactKey);

      expectCode(() => releases.activateRelease(release.id), "INTERNAL_ERROR");
      expect(releases.activeRelease()).toBeNull();
    } finally {
      database.close();
      releases.close();
      index.close();
      cache.close();
    }
  });

  it("rejects Raw content-address tampering before activation", () => {
    const path = dataPath();
    const cache = new PageCache(path);
    const index = new LocalPageIndex(path);
    const releases = new LocalIndexReleaseStore(path);
    const database = new DatabaseSync(path);
    try {
      publish(index, cache, artifact("one"));
      const release = releases.createRelease();
      const rawRef = release.manifest.documents[0]!.rawRef;
      database.prepare("UPDATE raw_objects SET bytes = ? WHERE raw_ref = ?")
        .run(Buffer.from("tampered raw body"), rawRef);

      expectCode(() => releases.activateRelease(release.id), "INTERNAL_ERROR");
      expect(releases.activeRelease()).toBeNull();
    } finally {
      database.close();
      releases.close();
      index.close();
      cache.close();
    }
  });

  it("rolls back to a complete release and rejects invalid rollback targets", () => {
    const path = dataPath();
    const cache = new PageCache(path);
    const index = new LocalPageIndex(path);
    const releases = new LocalIndexReleaseStore(path);
    const database = new DatabaseSync(path);
    try {
      publish(index, cache, artifact("one"));
      const stable = releases.createRelease();
      releases.activateRelease(stable.id);
      const candidateArtifactKey = publish(index, cache, artifact("two"));
      const candidate = releases.createRelease();
      releases.activateRelease(candidate.id);

      expect(releases.rollbackRelease(stable.id)).toMatchObject({ id: stable.id, active: true });
      expect(index.search("Stable release one", 10, 1)).toHaveLength(1);
      expect(index.search("Candidate release two", 10, 1)).toEqual([]);

      expectCode(() => releases.rollbackRelease("release_missing"), "INVALID_ARGUMENT");
      database.prepare(
        `INSERT INTO local_index_releases(
          release_id, manifest_hash, manifest_json, status, created_at_ms
        ) VALUES ('release_incomplete', 'sha256:incomplete', '{}', 'building', 0)`,
      ).run();
      expectCode(() => releases.rollbackRelease("release_incomplete"), "INVALID_ARGUMENT");

      database.prepare("DELETE FROM artifact_cache_entries WHERE artifact_key = ?")
        .run(candidateArtifactKey);
      database.prepare("DELETE FROM artifacts WHERE artifact_key = ?").run(candidateArtifactKey);
      expectCode(() => releases.rollbackRelease(candidate.id), "INTERNAL_ERROR");
      expect(releases.activeRelease()?.id).toBe(stable.id);
      expect(index.search("Stable release one", 10, 1)).toHaveLength(1);
    } finally {
      database.close();
      releases.close();
      index.close();
      cache.close();
    }
  });

  it("rolls back the projection and active pointer when activation fails during insertion", () => {
    const path = dataPath();
    const cache = new PageCache(path);
    const index = new LocalPageIndex(path);
    const releases = new LocalIndexReleaseStore(path);
    const database = new DatabaseSync(path);
    try {
      publish(index, cache, artifact("one"));
      const stable = releases.createRelease();
      releases.activateRelease(stable.id);
      publish(index, cache, artifact("two"));
      const candidate = releases.createRelease();
      releases.activateRelease(stable.id);
      database.exec(`
        CREATE TRIGGER reject_candidate_release BEFORE INSERT ON indexed_pages
        WHEN new.content_hash = 'hash-two'
        BEGIN
          SELECT RAISE(ABORT, 'injected activation failure');
        END;
      `);

      expectCode(() => releases.activateRelease(candidate.id), "INTERNAL_ERROR");
      expect(releases.activeRelease()?.id).toBe(stable.id);
      expect(index.search("Stable release one", 10, 1)).toHaveLength(1);
      expect(index.search("Candidate release two", 10, 1)).toEqual([]);
    } finally {
      database.close();
      releases.close();
      index.close();
      cache.close();
    }
  });
});
