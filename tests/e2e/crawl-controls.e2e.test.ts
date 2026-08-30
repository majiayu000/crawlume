import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDurableCrawlSite,
  type DurableCrawlStats,
} from "../../benchmarks/controlled-site/durable-crawl.js";
import {
  collectCrawlPages,
  getCrawlPageBatch,
  requireStructuredResult,
  startCrawl,
  waitForCrawl,
  waitForTerminalCrawl,
  type JsonRecord,
} from "../../benchmarks/harness/crawl-e2e.js";
import {
  startBuiltMcpProcess,
  type BuiltMcpProcess,
} from "../../benchmarks/harness/mcp-process.js";
import {
  inspectCrawlDatabase,
  readFrontierRows,
  type FrontierInspectionRow,
} from "../../benchmarks/harness/sqlite-inspector.js";

const crawlBudget = {
  maxDurationMs: 60_000,
  maxProviderAttempts: 100,
  maxDocumentBytes: 4_000_000,
  maxBrowserMs: 0,
  maxBrowserContexts: 0,
};

function processEnvironment(proxyUrl: string): Record<string, string> {
  return {
    DIAOYAN_ALLOW_DNS_FAKE_IP: "1",
    DIAOYAN_CRAWL_MAX_ATTEMPTS: "1",
    DIAOYAN_CRAWL_MIN_HOST_INTERVAL_MS: "0",
    DIAOYAN_CRAWL_RETRY_BASE_MS: "0",
    DIAOYAN_CRAWL_WORKER_CONCURRENCY: "4",
    DIAOYAN_LOCAL_INDEX_ENABLED: "0",
    DIAOYAN_PROXY_URLS: proxyUrl,
    DIAOYAN_REQUEST_TIMEOUT_MS: "10000",
  };
}

function progressCount(job: JsonRecord, field: string): number {
  const progress = job.progress;
  if (progress === null || Array.isArray(progress) || typeof progress !== "object") return 0;
  const value = (progress as JsonRecord)[field];
  return typeof value === "number" ? value : 0;
}

async function controlCrawl(
  process: BuiltMcpProcess,
  tool: "pause_crawl" | "resume_crawl" | "cancel_crawl",
  jobId: string,
): Promise<JsonRecord> {
  return requireStructuredResult(await process.callTool(tool, { jobId }), tool);
}

async function waitForObservation<T>(
  observe: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  description: string,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let intervalMs = 10;
  let last = await observe();
  while (!predicate(last)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for ${description}; last observation: ${JSON.stringify(last)}`,
      );
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    });
    intervalMs = Math.min(100, intervalMs * 2);
    last = await observe();
  }
  return last;
}

describe("durable crawl controls through the built MCP process", () => {
  it("pauses before new claims, resumes, and demonstrates real concurrent HTTP work", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "diaoyan-crawl-pause-e2e-"));
    const databasePath = join(dataDirectory, "cache.sqlite");
    const site = await createDurableCrawlSite({ pages: 5, holdPageResponses: true });
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
        maxPages: 5,
        maxDepth: 1,
        concurrency: 3,
        crawlBudget,
      });

      await site.waitForPageRequests(1);
      const paused = await controlCrawl(process, "pause_crawl", started.id);
      expect(paused).toMatchObject({ id: started.id, status: "paused" });
      await waitForCrawl(process, started.id, (job) => job.status === "paused", {
        description: "the persisted paused job state",
      });

      site.releasePage(0);
      const rootCommitted = await waitForCrawl(
        process,
        started.id,
        (job) => progressCount(job, "publishedCount") === 1,
        { description: "the in-flight root page to commit while paused" },
      );
      expect(rootCommitted.status).toBe("paused");
      expect(site.stats()).toMatchObject({ pageRequests: 1, activePageRequests: 0 });
      expect(await readFrontierRows(databasePath, started.id)).toEqual([
        expect.objectContaining({ normalizedUrl: site.seedUrl, state: "succeeded" }),
        expect.objectContaining({ state: "queued" }),
        expect.objectContaining({ state: "queued" }),
        expect.objectContaining({ state: "queued" }),
        expect.objectContaining({ state: "queued" }),
      ]);

      const resumed = await controlCrawl(process, "resume_crawl", started.id);
      expect(resumed).toMatchObject({ id: started.id, status: "running" });
      const concurrent = await site.waitForPageRequests(4);
      expect(concurrent).toMatchObject({ pageRequests: 4, activePageRequests: 3 });
      expect(concurrent.peakActivePageRequests).toBeGreaterThanOrEqual(2);

      site.setHoldPageResponses(false);
      const completed = await waitForTerminalCrawl(process, started.id);
      expect(completed).toMatchObject({
        status: "completed",
        progress: {
          queuedCount: 0,
          leasedCount: 0,
          succeededCount: 5,
          publishedCount: 5,
        },
      });
      const publications = await collectCrawlPages(process, started.id, 2);
      expect(publications).toHaveLength(5);
      expect(new Set(publications.map((page) => page.url)).size).toBe(5);
      expect(publications.every((page) => page.status === "succeeded")).toBe(true);
      expect((await inspectCrawlDatabase(databasePath)).integrity).toEqual(["ok"]);
      expect((await readFrontierRows(databasePath, started.id)).some(
        (row) => row.state === "leased",
      )).toBe(false);
    } finally {
      await process?.close().catch(() => undefined);
      await site.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  it("cancels active sockets and publishes a clean terminal frontier", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "diaoyan-crawl-cancel-e2e-"));
    const databasePath = join(dataDirectory, "cache.sqlite");
    const site = await createDurableCrawlSite({ pages: 6, holdPageResponses: true });
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
        maxPages: 6,
        maxDepth: 1,
        concurrency: 2,
        crawlBudget,
      });

      await site.waitForPageRequests(1);
      site.releasePage(0);
      const active = await site.waitForPageRequests(2);
      expect(active.activePageRequests).toBeGreaterThanOrEqual(1);

      const cancelled = await controlCrawl(process, "cancel_crawl", started.id);
      expect(cancelled).toMatchObject({ id: started.id });
      const terminal = await waitForTerminalCrawl(process, started.id);
      expect(terminal.status).toBe("cancelled");

      const socketsClosed = await waitForObservation<DurableCrawlStats>(
        () => site.stats(),
        (stats) => stats.activePageRequests === 0,
        "cancelled HTTP sockets to close",
        2_000,
      );
      expect(socketsClosed.pageRequests).toBeLessThanOrEqual(3);

      const terminalFrontier = await waitForObservation<FrontierInspectionRow[]>(
        () => readFrontierRows(databasePath, started.id),
        (rows) => rows.length === 6 && rows.every(
          (row) => row.state === "succeeded" || row.state === "stopped",
        ),
        "the cancelled frontier to contain no queued or leased pages",
        2_000,
      );
      expect(terminalFrontier.filter((row) => row.state === "succeeded")).toHaveLength(1);
      expect(terminalFrontier.filter((row) => row.state === "stopped")).toHaveLength(5);

      const publications = await getCrawlPageBatch(process, started.id, 0, 100);
      expect(publications.done).toBe(true);
      expect(publications.pages).toHaveLength(6);
      expect(publications.pages.filter((page) => page.status === "succeeded")).toHaveLength(1);
      expect(publications.pages.filter((page) => page.status === "stopped")).toHaveLength(5);
      expect((await inspectCrawlDatabase(databasePath)).integrity).toEqual(["ok"]);
    } finally {
      await process?.close().catch(() => undefined);
      await site.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  it("enforces the cumulative provider-attempt budget across concurrent claims", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "diaoyan-crawl-budget-e2e-"));
    const databasePath = join(dataDirectory, "cache.sqlite");
    const site = await createDurableCrawlSite({ pages: 6 });
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
        maxPages: 6,
        maxDepth: 1,
        concurrency: 4,
        crawlBudget: {
          maxDurationMs: 60_000,
          maxProviderAttempts: 2,
          maxDocumentBytes: 4_000_000,
          maxBrowserMs: 0,
          maxBrowserContexts: 0,
        },
      });

      const terminal = await waitForTerminalCrawl(process, started.id);
      expect(terminal).toMatchObject({
        status: "failed",
        error: { code: "BUDGET_EXHAUSTED" },
        usage: { providerAttempts: 2 },
        progress: { publishedCount: 6, queuedCount: 0, leasedCount: 0 },
      });
      expect(site.stats().pageRequests).toBe(2);
      const publications = await collectCrawlPages(process, started.id, 2);
      expect(publications).toHaveLength(6);
      expect(publications.filter((page) => page.status === "succeeded")).toHaveLength(2);
      expect(publications.filter((page) => page.status === "stopped")).toHaveLength(4);
      expect((await inspectCrawlDatabase(databasePath)).integrity).toEqual(["ok"]);
    } finally {
      await process?.close().catch(() => undefined);
      await site.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  it("applies a real Retry-After response to later claims on the same origin", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "diaoyan-crawl-retry-after-e2e-"));
    const site = await createDurableCrawlSite({
      pages: 4,
      holdPageResponses: true,
      rateLimitPage: 1,
      retryAfterSeconds: 2,
    });
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
        maxPages: 4,
        maxDepth: 1,
        concurrency: 2,
        crawlBudget,
      });
      await site.waitForPageRequests(1);
      site.releasePage(0);
      const observed = await site.waitForPageRequests(4, 10_000);
      const limitedAt = observed.pageStartTimesMs["1"]?.[0];
      const laterAt = observed.pageStartTimesMs["3"]?.[0];
      expect(limitedAt).toBeTypeOf("number");
      expect(laterAt).toBeTypeOf("number");
      expect(laterAt! - limitedAt!).toBeGreaterThanOrEqual(1_950);

      site.setHoldPageResponses(false);
      const completed = await waitForTerminalCrawl(process, started.id);
      expect(completed).toMatchObject({
        status: "completed",
        progress: { succeededCount: 3, failedCount: 1, publishedCount: 4 },
      });
    } finally {
      await process?.close().catch(() => undefined);
      await site.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  it("schedules two origins independently while spacing starts within each origin", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "diaoyan-crawl-origins-e2e-"));
    const site = await createDurableCrawlSite({
      pages: 5,
      holdPageResponses: true,
      alternateSubdomainPages: true,
    });
    let process: BuiltMcpProcess | null = null;
    try {
      process = await startBuiltMcpProcess({
        dataDirectory,
        environment: {
          ...processEnvironment(site.proxyUrl),
          DIAOYAN_CRAWL_MIN_HOST_INTERVAL_MS: "1000",
        },
      });
      const started = await startCrawl(process, {
        url: site.seedUrl,
        browserAllowed: false,
        cacheMode: "live",
        maxPages: 5,
        maxDepth: 1,
        includeSubdomains: true,
        concurrency: 4,
        crawlBudget,
      });
      await site.waitForPageRequests(1);
      site.releasePage(0);
      const firstChildren = await site.waitForPageRequests(3, 10_000);
      const originStarts = Object.values(firstChildren.pageStartTimesByOrigin)
        .filter((starts) => starts.length > 0)
        .map((starts) => starts[0]!)
        .sort((left, right) => left - right);
      expect(originStarts).toHaveLength(3);
      expect(originStarts[2]! - originStarts[1]!).toBeLessThan(250);

      site.setHoldPageResponses(false);
      await waitForTerminalCrawl(process, started.id);
      const finalOrigins = site.stats().pageStartTimesByOrigin;
      for (const origin of ["http://a.example.com", "http://b.example.com"]) {
        const starts = finalOrigins[origin] ?? [];
        expect(starts).toHaveLength(2);
        expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(950);
      }
    } finally {
      await process?.close().catch(() => undefined);
      await site.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }, 60_000);
});
