import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { PageCache } from "../src/cache.js";
import { AttemptLedger } from "../src/jobs.js";
import { ReaderService } from "../src/reader.js";
import { UrlPolicy } from "../src/security/url-policy.js";
import { publicResolver, rawPage, StubFetcher, testConfig } from "./helpers.js";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function runtime(path: string, http: StubFetcher, ledger: AttemptLedger): ReaderService {
  return new ReaderService(
    { ...testConfig(), cachePath: path },
    new UrlPolicy(async () => publicResolver()),
    new PageCache(path),
    http,
    new StubFetcher(new Error("browser must not run")),
    null,
    null,
    null,
    null,
    () => "",
    ledger,
  );
}

describe("request terminal and artifact consistency", () => {
  it("replays a committed public artifact by requestId after restart without refetching", async () => {
    const directory = mkdtempSync(join(tmpdir(), "diaoyan-request-replay-"));
    directories.push(directory);
    const path = join(directory, "runtime.sqlite");
    const firstLedger = new AttemptLedger(path);
    const firstHttp = new StubFetcher(rawPage());
    const first = runtime(path, firstHttp, firstLedger);
    const original = await first.readPage({
      url: "https://example.com/article",
      requestId: "stable-request",
      cacheMode: "live",
      browserAllowed: false,
    });
    await first.close();
    firstLedger.close();

    const reopenedLedger = new AttemptLedger(path);
    const unopenedHttp = new StubFetcher(new Error("terminal replay must not refetch"));
    const reopened = runtime(path, unopenedHttp, reopenedLedger);
    try {
      const replayed = await reopened.readPage({
        url: "https://example.com/article",
        requestId: "stable-request",
        cacheMode: "live",
        browserAllowed: false,
      });
      expect(replayed.contentHash).toBe(original.contentHash);
      expect(replayed.cached).toBe(true);
      expect(replayed.evidence.cacheStatus).toBe("replayed");
      expect(unopenedHttp.calls).toBe(0);
    } finally {
      await reopened.close();
      reopenedLedger.close();
    }
  });

  it("replays a committed terminal failure instead of rerunning its provider", async () => {
    const directory = mkdtempSync(join(tmpdir(), "diaoyan-failure-replay-"));
    directories.push(directory);
    const path = join(directory, "runtime.sqlite");
    const firstLedger = new AttemptLedger(path);
    const first = runtime(path, new StubFetcher(new Error("origin failed")), firstLedger);
    await expect(first.readPage({
      url: "https://example.com/article",
      requestId: "stable-failure",
      cacheMode: "live",
      browserAllowed: false,
    })).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await first.close();
    firstLedger.close();

    const reopenedLedger = new AttemptLedger(path);
    const unopenedHttp = new StubFetcher(rawPage());
    const reopened = runtime(path, unopenedHttp, reopenedLedger);
    try {
      await expect(reopened.readPage({
        url: "https://example.com/article",
        requestId: "stable-failure",
        cacheMode: "live",
        browserAllowed: false,
      })).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
      expect(unopenedHttp.calls).toBe(0);
    } finally {
      await reopened.close();
      reopenedLedger.close();
    }
  });

  it("expires terminal projections with the artifacts they reference", async () => {
    const directory = mkdtempSync(join(tmpdir(), "diaoyan-terminal-retention-"));
    directories.push(directory);
    const path = join(directory, "runtime.sqlite");
    const ledger = new AttemptLedger(path);
    const first = runtime(path, new StubFetcher(rawPage()), ledger);
    await first.readPage({
      url: "https://example.com/article",
      requestId: "expiring-request",
      cacheMode: "live",
      browserAllowed: false,
    });
    const artifactKey = ledger.getTerminal("expiring-request")?.artifactKey;
    await first.close();
    ledger.close();

    const database = new DatabaseSync(path);
    const expired = new Date(Date.now() - 31 * 86_400_000).toISOString();
    database.prepare("UPDATE artifact_cache_entries SET fetched_at_ms = 0").run();
    database.prepare("UPDATE execution_request_terminals SET committed_at = ?").run(expired);
    database.close();

    const cleanupCache = new PageCache(path);
    const reopenedLedger = new AttemptLedger(path);
    try {
      expect(reopenedLedger.getTerminal("expiring-request")).toBeNull();
      expect(cleanupCache.getArtifact(artifactKey as string)).toBeNull();
    } finally {
      cleanupCache.close();
      reopenedLedger.close();
    }
  });
});
