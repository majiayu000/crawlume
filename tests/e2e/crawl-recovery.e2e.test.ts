import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { createDurableCrawlSite } from "../../benchmarks/controlled-site/durable-crawl.js";
import {
  collectCrawlPages,
  getCrawlPageBatch,
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
} from "../../benchmarks/harness/sqlite-inspector.js";

function publishedCount(job: JsonRecord): number {
  const progress = job.progress;
  if (progress === null || Array.isArray(progress) || typeof progress !== "object") return 0;
  const value = (progress as JsonRecord).publishedCount;
  return typeof value === "number" ? value : 0;
}

describe("durable crawl process recovery", () => {
  it("keeps committed publications across SIGKILL and resumes from the same SQLite frontier", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "crawlume-crawl-recovery-e2e-"));
    const databasePath = join(dataDirectory, "cache.sqlite");
    const site = await createDurableCrawlSite({ pages: 6, holdPageResponses: true });
    const environment = {
      CRAWLUME_ALLOW_DNS_FAKE_IP: "1",
      CRAWLUME_CRAWL_MAX_ATTEMPTS: "1",
      CRAWLUME_CRAWL_MIN_HOST_INTERVAL_MS: "0",
      CRAWLUME_CRAWL_RETRY_BASE_MS: "0",
      CRAWLUME_LOCAL_INDEX_ENABLED: "0",
      CRAWLUME_PROXY_URLS: site.proxyUrl,
      CRAWLUME_REQUEST_TIMEOUT_MS: "10000",
    };
    let first: BuiltMcpProcess | null = null;
    let restarted: BuiltMcpProcess | null = null;
    try {
      first = await startBuiltMcpProcess({ dataDirectory, environment });
      const started = await startCrawl(first, {
        url: site.seedUrl,
        browserAllowed: false,
        cacheMode: "live",
        maxPages: 6,
        maxDepth: 1,
        concurrency: 3,
        crawlBudget: {
          maxDurationMs: 60_000,
          maxProviderAttempts: 50,
          maxDocumentBytes: 2_000_000,
          maxBrowserMs: 0,
          maxBrowserContexts: 0,
        },
      });

      await site.waitForPageRequests(1);
      const leasedDatabase = await inspectCrawlDatabase(databasePath);
      expect(leasedDatabase.integrity).toEqual(["ok"]);
      expect(leasedDatabase.tables).toContain("crawl_frontier");
      expect(leasedDatabase.columnsByTable.crawl_frontier).toEqual(expect.arrayContaining([
        "lease_owner",
        "lease_generation",
        "publication_sequence",
      ]));
      expect(await readFrontierRows(databasePath, started.id)).toEqual([
        expect.objectContaining({ normalizedUrl: site.seedUrl, state: "leased" }),
      ]);

      site.releasePage(0);
      await site.waitForPageRequests(4);
      await waitForCrawl(first, started.id, (job) => publishedCount(job) >= 1, {
        description: "the root publication before SIGKILL",
      });
      const beforeKill = await getCrawlPageBatch(first, started.id, 0, 100);
      expect(beforeKill.pages).toHaveLength(1);
      expect(beforeKill.pages[0]).toMatchObject({ url: site.seedUrl });
      expect(site.stats().requestsByPage["0"]).toBe(1);

      await first.kill("SIGKILL");
      first = null;
      site.setHoldPageResponses(false);

      restarted = await startBuiltMcpProcess({ dataDirectory, environment });
      const completed = await waitForTerminalCrawl(restarted, started.id, 60_000);
      if (completed.status !== "completed") {
        throw new Error(`recovered crawl did not complete: ${JSON.stringify(completed)}`);
      }
      const publications = await collectCrawlPages(restarted, started.id, 2);
      expect(publications).toHaveLength(6);
      expect(new Set(publications.map((page) => page.url)).size).toBe(6);
      expect(publications.map((page) => page.publicationSequence)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(site.stats().requestsByPage["0"]).toBe(1);

      const frontier = await readFrontierRows(databasePath, started.id);
      expect(frontier).toHaveLength(6);
      expect(frontier.every((row) => row.state === "succeeded")).toBe(true);
      expect((await inspectCrawlDatabase(databasePath)).integrity).toEqual(["ok"]);
    } finally {
      await first?.close().catch(() => undefined);
      await restarted?.close().catch(() => undefined);
      await site.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }, 90_000);

  it("preserves the same-origin start interval across a worker restart", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "crawlume-crawl-origin-e2e-"));
    const site = await createDurableCrawlSite({ pages: 3, holdPageResponses: true });
    const environment = {
      CRAWLUME_ALLOW_DNS_FAKE_IP: "1",
      CRAWLUME_CRAWL_LEASE_MS: "500",
      CRAWLUME_CRAWL_MAX_ATTEMPTS: "1",
      CRAWLUME_CRAWL_MIN_HOST_INTERVAL_MS: "2000",
      CRAWLUME_CRAWL_RETRY_BASE_MS: "0",
      CRAWLUME_CRAWL_WORKER_CONCURRENCY: "2",
      CRAWLUME_LOCAL_INDEX_ENABLED: "0",
      CRAWLUME_PROXY_URLS: site.proxyUrl,
      CRAWLUME_REQUEST_TIMEOUT_MS: "10000",
    };
    let first: BuiltMcpProcess | null = null;
    let restarted: BuiltMcpProcess | null = null;
    try {
      first = await startBuiltMcpProcess({ dataDirectory, environment });
      const started = await startCrawl(first, {
        url: site.seedUrl,
        browserAllowed: false,
        cacheMode: "live",
        maxPages: 3,
        maxDepth: 1,
        concurrency: 2,
      });
      await site.waitForPageRequests(1);
      site.releasePage(0);
      await site.waitForPageRequests(2, 10_000);
      const beforeRestart = Object.values(site.stats().pageStartTimesMs)
        .flat()
        .sort((left, right) => left - right);
      expect(beforeRestart).toHaveLength(2);

      await first.kill("SIGKILL");
      first = null;
      site.setHoldPageResponses(false);
      restarted = await startBuiltMcpProcess({ dataDirectory, environment });
      await waitForTerminalCrawl(restarted, started.id, 30_000);

      const starts = Object.values(site.stats().pageStartTimesMs)
        .flat()
        .sort((left, right) => left - right);
      expect(starts).toHaveLength(4);
      for (let index = 1; index < starts.length; index += 1) {
        expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(1_950);
      }
    } finally {
      await first?.close().catch(() => undefined);
      await restarted?.close().catch(() => undefined);
      await site.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }, 60_000);
});
