import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDurableCrawlSite } from "../../benchmarks/controlled-site/durable-crawl.js";
import {
  collectCrawlPages,
  startCrawl,
  waitForTerminalCrawl,
  type JsonRecord,
} from "../../benchmarks/harness/crawl-e2e.js";
import {
  startBuiltMcpProcess,
  type BuiltMcpProcess,
} from "../../benchmarks/harness/mcp-process.js";

function environment(proxyUrl: string): Record<string, string> {
  return {
    CRAWLUME_ALLOW_DNS_FAKE_IP: "1",
    CRAWLUME_CRAWL_MAX_ATTEMPTS: "1",
    CRAWLUME_CRAWL_MIN_HOST_INTERVAL_MS: "0",
    CRAWLUME_CRAWL_RETRY_BASE_MS: "0",
    CRAWLUME_CRAWL_WORKER_CONCURRENCY: "4",
    CRAWLUME_LOCAL_INDEX_ENABLED: "0",
    CRAWLUME_PROXY_URLS: proxyUrl,
    CRAWLUME_REQUEST_TIMEOUT_MS: "10000",
  };
}

function usageValue(job: JsonRecord, field: string): number {
  const usage = job.usage;
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return 0;
  const value = (usage as JsonRecord)[field];
  return typeof value === "number" ? value : 0;
}

describe("durable crawl cumulative budgets through real providers", () => {
  it("stops queued pages when measured document bytes consume the crawl budget", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "crawlume-crawl-bytes-e2e-"));
    const site = await createDurableCrawlSite({ pages: 4, bodyBytes: 4_096 });
    let process: BuiltMcpProcess | null = null;
    try {
      process = await startBuiltMcpProcess({
        dataDirectory,
        environment: environment(site.proxyUrl),
      });
      const calibration = await startCrawl(process, {
        url: site.seedUrl,
        browserAllowed: false,
        cacheMode: "live",
        maxPages: 1,
        maxDepth: 0,
        concurrency: 1,
        crawlBudget: {
          maxDurationMs: 30_000,
          maxProviderAttempts: 10,
          maxDocumentBytes: 1_000_000,
          maxBrowserMs: 0,
          maxBrowserContexts: 0,
        },
      });
      const calibrated = await waitForTerminalCrawl(process, calibration.id);
      const exactBytes = usageValue(calibrated, "documentBytesIn");
      expect(exactBytes).toBeGreaterThan(4_000);

      const started = await startCrawl(process, {
        url: site.seedUrl,
        browserAllowed: false,
        cacheMode: "live",
        maxPages: 4,
        maxDepth: 1,
        concurrency: 1,
        crawlBudget: {
          maxDurationMs: 30_000,
          maxProviderAttempts: 10,
          maxDocumentBytes: exactBytes,
          maxBrowserMs: 0,
          maxBrowserContexts: 0,
        },
      });
      const terminal = await waitForTerminalCrawl(process, started.id);
      expect(terminal).toMatchObject({
        status: "failed",
        error: { code: "BUDGET_EXHAUSTED" },
        usage: { documentBytesIn: exactBytes },
        progress: { succeededCount: 1, stoppedCount: 3, publishedCount: 4 },
      });
      const pages = await collectCrawlPages(process, started.id, 2);
      expect(pages.filter((page) => page.status === "succeeded")).toHaveLength(1);
      expect(pages.filter((page) => page.status === "stopped")).toHaveLength(3);
    } finally {
      await process?.close().catch(() => undefined);
      await site.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  it("turns queued pages into explicit stops when the crawl deadline expires", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "crawlume-crawl-deadline-e2e-"));
    const site = await createDurableCrawlSite({ pages: 4, holdPageResponses: true });
    let process: BuiltMcpProcess | null = null;
    try {
      process = await startBuiltMcpProcess({
        dataDirectory,
        environment: environment(site.proxyUrl),
      });
      const started = await startCrawl(process, {
        url: site.seedUrl,
        browserAllowed: false,
        cacheMode: "live",
        maxPages: 4,
        maxDepth: 1,
        concurrency: 1,
        crawlBudget: {
          maxDurationMs: 1_000,
          maxProviderAttempts: 10,
          maxDocumentBytes: 1_000_000,
          maxBrowserMs: 0,
          maxBrowserContexts: 0,
        },
      });
      await site.waitForPageRequests(1);
      site.releasePage(0);
      await site.waitForPageRequests(2);
      const terminal = await waitForTerminalCrawl(process, started.id, 10_000);
      expect(terminal).toMatchObject({
        status: "failed",
        error: { code: "BUDGET_EXHAUSTED" },
        progress: { succeededCount: 1, queuedCount: 0, leasedCount: 0 },
      });
      expect((await collectCrawlPages(process, started.id, 2))).toHaveLength(4);
    } finally {
      await process?.close().catch(() => undefined);
      await site.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }, 30_000);

  it("stops new browser work after the real Chrome context budget is consumed", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "crawlume-crawl-browser-budget-e2e-"));
    const site = await createDurableCrawlSite({ pages: 3, dynamicPages: true });
    let process: BuiltMcpProcess | null = null;
    try {
      process = await startBuiltMcpProcess({
        dataDirectory,
        environment: {
          ...environment(site.proxyUrl),
          CRAWLUME_BROWSER_POOL_SIZE: "1",
          CRAWLUME_BROWSER_CONTEXTS_PER_INSTANCE: "2",
          CRAWLUME_BROWSER_TIMEOUT_MS: "10000",
        },
      });
      const started = await startCrawl(process, {
        url: site.seedUrl,
        browserAllowed: true,
        cacheMode: "live",
        maxPages: 3,
        maxDepth: 1,
        concurrency: 2,
        browserReadiness: {
          target: { selector: "[data-browser-ready]", state: "attached", minCount: 1 },
          timeoutMs: 5_000,
        },
        crawlBudget: {
          maxDurationMs: 30_000,
          maxProviderAttempts: 10,
          maxDocumentBytes: 1_000_000,
          maxBrowserMs: 20_000,
          maxBrowserContexts: 1,
        },
      });
      const terminal = await waitForTerminalCrawl(process, started.id, 30_000);
      expect(terminal).toMatchObject({
        status: "failed",
        error: { code: "BUDGET_EXHAUSTED" },
        usage: { browserContextStarts: 1 },
        progress: { succeededCount: 1, stoppedCount: 2, publishedCount: 3 },
      });
      expect(site.stats().pageRequests).toBe(1);
    } finally {
      await process?.close().catch(() => undefined);
      await site.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }, 60_000);
});
