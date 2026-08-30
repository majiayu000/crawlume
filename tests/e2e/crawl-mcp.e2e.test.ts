import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { createDurableCrawlSite } from "../../benchmarks/controlled-site/durable-crawl.js";
import {
  collectCrawlPages,
  startCrawl,
  waitForTerminalCrawl,
} from "../../benchmarks/harness/crawl-e2e.js";
import {
  startBuiltMcpProcess,
  type BuiltMcpProcess,
} from "../../benchmarks/harness/mcp-process.js";
import { inspectCrawlDatabase } from "../../benchmarks/harness/sqlite-inspector.js";

function processEnvironment(proxyUrl: string): Record<string, string> {
  return {
    DIAOYAN_ALLOW_DNS_FAKE_IP: "1",
    DIAOYAN_CRAWL_MAX_ATTEMPTS: "1",
    DIAOYAN_CRAWL_MIN_HOST_INTERVAL_MS: "0",
    DIAOYAN_CRAWL_RETRY_BASE_MS: "0",
    DIAOYAN_LOCAL_INDEX_ENABLED: "0",
    DIAOYAN_PROXY_URLS: proxyUrl,
    DIAOYAN_REQUEST_TIMEOUT_MS: "5000",
  };
}

describe("durable crawl MCP process", () => {
  it("drives the built stdio server through a real proxy and file-backed SQLite", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "diaoyan-crawl-mcp-e2e-"));
    const site = await createDurableCrawlSite({ pages: 3 });
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
        maxPages: 3,
        maxDepth: 2,
      });
      const completed = await waitForTerminalCrawl(process, started.id);

      expect(completed).toMatchObject({
        status: "completed",
        result: { status: "ok", scannedPages: 3 },
      });
      expect(site.stats()).toMatchObject({
        pageRequests: 3,
        requestsByPage: { "0": 1, "1": 1, "2": 1 },
      });
      const database = await inspectCrawlDatabase(join(dataDirectory, "cache.sqlite"));
      expect(database.integrity).toEqual(["ok"]);
      expect(database.tables).toContain("crawl_jobs");
    } finally {
      await process?.close().catch(() => undefined);
      await site.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }, 30_000);

  it("advertises durable controls and preserves the new start contract over real MCP stdio", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "diaoyan-crawl-contract-e2e-"));
    const site = await createDurableCrawlSite({ pages: 2 });
    let process: BuiltMcpProcess | null = null;
    try {
      process = await startBuiltMcpProcess({
        dataDirectory,
        environment: processEnvironment(site.proxyUrl),
      });

      expect(await process.listTools()).toEqual(expect.arrayContaining([
        "pause_crawl",
        "resume_crawl",
        "get_crawl_pages",
      ]));

      const started = await startCrawl(process, {
        url: site.seedUrl,
        browserAllowed: false,
        cacheMode: "live",
        maxPages: 2,
        maxDepth: 1,
        concurrency: 2,
        crawlBudget: {
          maxDurationMs: 30_000,
          maxProviderAttempts: 20,
          maxDocumentBytes: 1_000_000,
          maxBrowserMs: 0,
          maxBrowserContexts: 0,
        },
      });
      expect(started.input).toMatchObject({
        concurrency: 2,
        crawlBudget: { maxProviderAttempts: 20 },
      });
    } finally {
      await process?.close().catch(() => undefined);
      await site.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }, 30_000);

  it("crawls a JavaScript-rendered graph through a real Chrome process", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "diaoyan-crawl-chrome-e2e-"));
    const site = await createDurableCrawlSite({
      pages: 3,
      dynamicPages: true,
      holdPageResponses: true,
    });
    let process: BuiltMcpProcess | null = null;
    try {
      process = await startBuiltMcpProcess({
        dataDirectory,
        environment: {
          ...processEnvironment(site.proxyUrl),
          DIAOYAN_BROWSER_POOL_SIZE: "1",
          DIAOYAN_BROWSER_CONTEXTS_PER_INSTANCE: "2",
          DIAOYAN_BROWSER_TIMEOUT_MS: "10000",
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
          maxDurationMs: 60_000,
          maxProviderAttempts: 10,
          maxDocumentBytes: 2_000_000,
          maxBrowserMs: 30_000,
          maxBrowserContexts: 3,
        },
      });
      await site.waitForPageRequests(1);
      site.releasePage(0);
      const concurrent = await site.waitForPageRequests(3);
      expect(concurrent.activePageRequests).toBe(2);
      site.releaseAllPages();
      const completed = await waitForTerminalCrawl(process, started.id, 60_000);
      expect(completed).toMatchObject({
        status: "completed",
        progress: { succeededCount: 3, publishedCount: 3 },
      });
      const publications = await collectCrawlPages(process, started.id, 2);
      expect(publications).toHaveLength(3);
      expect(publications.every((page) => {
        const result = page.result;
        return result !== null && typeof result === "object" &&
          !Array.isArray(result) && "fetchMethod" in result && result.fetchMethod === "browser";
      })).toBe(true);
      expect(site.stats().peakActivePageRequests).toBeGreaterThanOrEqual(2);
    } finally {
      await process?.close().catch(() => undefined);
      await site.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }, 90_000);
});
