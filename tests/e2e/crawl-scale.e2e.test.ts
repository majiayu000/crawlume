import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDurableCrawlSite } from "../../benchmarks/controlled-site/durable-crawl.js";
import {
  getCrawlPageBatch,
  getCrawl,
  startCrawl,
  waitForCrawl,
  waitForTerminalCrawl,
  type CrawlPagePublication,
  type JsonRecord,
} from "../../benchmarks/harness/crawl-e2e.js";
import {
  startBuiltMcpProcess,
  type BuiltMcpProcess,
} from "../../benchmarks/harness/mcp-process.js";
import {
  inspectCrawlDatabase,
  readFrontierRows,
} from "../../benchmarks/harness/sqlite-inspector.js";

function processEnvironment(proxyUrl: string): Record<string, string> {
  return {
    CRAWLUME_ALLOW_DNS_FAKE_IP: "1",
    CRAWLUME_CRAWL_LEASE_MS: "1000",
    CRAWLUME_CRAWL_MAX_ATTEMPTS: "2",
    CRAWLUME_CRAWL_MIN_HOST_INTERVAL_MS: "0",
    CRAWLUME_CRAWL_RETRY_BASE_MS: "0",
    CRAWLUME_CRAWL_WORKER_CONCURRENCY: "16",
    CRAWLUME_LOCAL_INDEX_ENABLED: "0",
    CRAWLUME_PROXY_URLS: proxyUrl,
    CRAWLUME_REQUEST_TIMEOUT_MS: "30000",
  };
}

function publishedCount(job: JsonRecord): number {
  const progress = job.progress;
  if (progress === null || Array.isArray(progress) || typeof progress !== "object") return 0;
  const value = (progress as JsonRecord).publishedCount;
  return typeof value === "number" ? value : 0;
}

function pageNumber(url: unknown): string {
  if (typeof url !== "string") throw new Error("crawl publication has no URL");
  const match = /\/page\/(\d+)$/u.exec(new URL(url).pathname);
  if (match?.[1] === undefined) throw new Error(`unexpected controlled page URL: ${url}`);
  return match[1];
}

async function collectCursorBatches(
  process: BuiltMcpProcess,
  jobId: string,
  expectedPages: number,
  limit: number,
): Promise<CrawlPagePublication[]> {
  const publications: CrawlPagePublication[] = [];
  const sequences = new Set<number>();
  let cursor = 0;
  for (;;) {
    const batch = await getCrawlPageBatch(process, jobId, cursor, limit);
    expect(batch.jobId).toBe(jobId);
    expect(batch.pages.length).toBeLessThanOrEqual(limit);
    for (const publication of batch.pages) {
      expect(publication.publicationSequence).toBeGreaterThan(cursor);
      expect(sequences.has(publication.publicationSequence)).toBe(false);
      sequences.add(publication.publicationSequence);
    }
    publications.push(...batch.pages);
    const expectedCursor = batch.pages.at(-1)?.publicationSequence ?? cursor;
    expect(batch.nextSequence).toBe(expectedCursor);
    if (batch.done) break;
    expect(batch.pages.length).toBeGreaterThan(0);
    expect(batch.nextSequence).toBeGreaterThan(cursor);
    cursor = batch.nextSequence;
  }
  expect(publications).toHaveLength(expectedPages);
  expect(publications.map((publication) => publication.publicationSequence)).toEqual(
    Array.from({ length: expectedPages }, (_, index) => index + 1),
  );
  return publications;
}

describe("durable crawl production-scale acceptance", () => {
  it("completes 500 real pages concurrently with stable cursor publications", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "crawlume-crawl-500-e2e-"));
    const databasePath = join(dataDirectory, "cache.sqlite");
    const site = await createDurableCrawlSite({ pages: 500, holdPageResponses: true });
    let process: BuiltMcpProcess | null = null;
    try {
      process = await startBuiltMcpProcess({
        dataDirectory,
        environment: processEnvironment(site.proxyUrl),
      });
      const started = await startCrawl(process, {
        url: site.seedUrl,
        browserAllowed: false,
        cacheMode: "live",
        maxPages: 500,
        maxDepth: 1,
        concurrency: 16,
        crawlBudget: {
          maxDurationMs: 240_000,
          maxProviderAttempts: 1_000,
          maxDocumentBytes: 32_000_000,
          maxBrowserMs: 0,
          maxBrowserContexts: 0,
        },
      });

      await site.waitForPageRequests(1, 30_000);
      site.releasePage(0);
      let concurrent;
      try {
        concurrent = await site.waitForPageRequests(17, 10_000);
      } catch (error) {
        const job = await getCrawl(process, started.id);
        const frontier = await readFrontierRows(databasePath, started.id);
        throw new Error(`scale concurrency stalled: ${JSON.stringify({
          stats: site.stats(),
          job,
          states: Object.groupBy(frontier, (row) => row.state),
        })}`, { cause: error });
      }
      expect(concurrent.activePageRequests).toBe(16);
      expect(concurrent.peakActivePageRequests).toBe(16);
      site.setHoldPageResponses(false);

      const completed = await waitForTerminalCrawl(process, started.id, 240_000);
      if (publishedCount(completed) === 500 &&
          JSON.stringify(completed).includes('"failedCount":') &&
          !JSON.stringify(completed).includes('"failedCount":0')) {
        const diagnostic = await getCrawlPageBatch(process, started.id, 0, 1_000);
        throw new Error(`scale pages failed: ${JSON.stringify({
          job: completed,
          errors: diagnostic.pages.filter((page) => page.status === "failed")
            .slice(0, 5).map((page) => page.error),
          stats: site.stats(),
          stderr: process.stderr(),
        })}`);
      }
      expect(completed).toMatchObject({
        status: "completed",
        progress: {
          discoveredCount: 500,
          queuedCount: 0,
          leasedCount: 0,
          succeededCount: 500,
          failedCount: 0,
          publishedCount: 500,
        },
      });

      const publications = await collectCursorBatches(process, started.id, 500, 37);
      expect(new Set(publications.map((publication) => publication.url)).size).toBe(500);
      expect(publications.every((publication) => publication.status === "succeeded")).toBe(true);

      const stats = site.stats();
      expect(stats.pageRequests).toBe(500);
      expect(stats.peakActivePageRequests).toBe(16);
      expect(Object.values(stats.requestsByPage).every((count) => count === 1)).toBe(true);

      const frontier = await readFrontierRows(databasePath, started.id);
      expect(frontier).toHaveLength(500);
      expect(frontier.every((row) => row.state === "succeeded")).toBe(true);
      expect(frontier.every((row) => row.executionCount === 1)).toBe(true);
      expect((await inspectCrawlDatabase(databasePath)).integrity).toEqual(["ok"]);
    } finally {
      await process?.close().catch(() => undefined);
      await site.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }, 300_000);

  it("resumes 1000 pages after SIGKILL without refetching committed publications", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "crawlume-crawl-1000-e2e-"));
    const databasePath = join(dataDirectory, "cache.sqlite");
    const site = await createDurableCrawlSite({ pages: 1_000, holdPageResponses: true });
    const environment = processEnvironment(site.proxyUrl);
    let first: BuiltMcpProcess | null = null;
    let restarted: BuiltMcpProcess | null = null;
    try {
      first = await startBuiltMcpProcess({ dataDirectory, environment });
      const started = await startCrawl(first, {
        url: site.seedUrl,
        browserAllowed: false,
        cacheMode: "live",
        maxPages: 1_000,
        maxDepth: 1,
        concurrency: 16,
        crawlBudget: {
          maxDurationMs: 360_000,
          maxProviderAttempts: 3_000,
          maxDocumentBytes: 64_000_000,
          maxBrowserMs: 0,
          maxBrowserContexts: 0,
        },
      });

      await site.waitForPageRequests(1, 30_000);
      site.releasePage(0);
      const active = await site.waitForPageRequests(17, 60_000);
      const releasable = Object.keys(active.requestsByPage)
        .filter((page) => page !== "0")
        .map(Number)
        .sort((left, right) => left - right)
        .slice(0, 8);
      expect(releasable).toHaveLength(8);
      for (const page of releasable) site.releasePage(page);

      await waitForCrawl(first, started.id, (job) => publishedCount(job) >= 9, {
        timeoutMs: 60_000,
        description: "at least nine committed publications before SIGKILL",
      });
      const committedBeforeKill = await getCrawlPageBatch(first, started.id, 0, 100);
      expect(committedBeforeKill.pages.length).toBeGreaterThanOrEqual(9);
      const committedRequestCounts = new Map(
        committedBeforeKill.pages.map((publication) => {
          const page = pageNumber(publication.url);
          return [page, site.stats().requestsByPage[page] ?? 0] as const;
        }),
      );
      expect([...committedRequestCounts.values()].every((count) => count === 1)).toBe(true);

      await first.kill("SIGKILL");
      first = null;
      site.setHoldPageResponses(false);

      restarted = await startBuiltMcpProcess({ dataDirectory, environment });
      const completed = await waitForTerminalCrawl(restarted, started.id, 360_000);
      expect(completed).toMatchObject({
        status: "completed",
        progress: {
          discoveredCount: 1_000,
          queuedCount: 0,
          leasedCount: 0,
          succeededCount: 1_000,
          failedCount: 0,
          publishedCount: 1_000,
        },
      });

      const publications = await collectCursorBatches(restarted, started.id, 1_000, 127);
      expect(new Set(publications.map((publication) => publication.url)).size).toBe(1_000);
      expect(publications.every((publication) => publication.status === "succeeded")).toBe(true);
      for (const [page, requestCount] of committedRequestCounts) {
        expect(site.stats().requestsByPage[page]).toBe(requestCount);
      }

      const frontier = await readFrontierRows(databasePath, started.id);
      expect(frontier).toHaveLength(1_000);
      expect(new Set(frontier.map((row) => row.normalizedUrl)).size).toBe(1_000);
      expect(frontier.every((row) => row.state === "succeeded")).toBe(true);
      expect((await inspectCrawlDatabase(databasePath)).integrity).toEqual(["ok"]);
    } finally {
      await first?.close().catch(() => undefined);
      await restarted?.close().catch(() => undefined);
      await site.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }, 480_000);
});
