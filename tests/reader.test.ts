import { afterEach, describe, expect, it } from "vitest";

import { PageCache } from "../src/cache.js";
import { CrawlRequestPolicy } from "../src/crawl-policy.js";
import { ReadError } from "../src/errors.js";
import { LocalPageIndex } from "../src/index.js";
import { CrawlerMetrics } from "../src/metrics.js";
import { ReaderService } from "../src/reader.js";
import { RslAccessAudit } from "../src/rsl-audit.js";
import { UrlPolicy } from "../src/security/url-policy.js";
import type { PageFetcher, RawPage } from "../src/types.js";
import { publicResolver, rawPage, StubFetcher, testConfig } from "./helpers.js";

const readers: ReaderService[] = [];
const metricsStores: CrawlerMetrics[] = [];
const auditStores: RslAccessAudit[] = [];

function readerWith(
  http: StubFetcher,
  browser: StubFetcher,
  localIndex: LocalPageIndex | null = null,
  crawlPolicy: CrawlRequestPolicy | null = null,
  metrics: CrawlerMetrics | null = null,
  rslAudit: RslAccessAudit | null = null,
): ReaderService {
  const reader = new ReaderService(
    testConfig(),
    new UrlPolicy(async () => publicResolver()),
    new PageCache(":memory:"),
    http,
    browser,
    localIndex,
    crawlPolicy,
    metrics,
    rslAudit,
  );
  readers.push(reader);
  return reader;
}

afterEach(() => {
  while (readers.length > 0) {
    readers.pop()?.close();
  }
  while (metricsStores.length > 0) {
    metricsStores.pop()?.close();
  }
  while (auditStores.length > 0) {
    auditStores.pop()?.close();
  }
});

describe("ReaderService", () => {
  it("uses browser only when HTTP content is incomplete", async () => {
    const http = new StubFetcher(rawPage({ body: "<html><body>Loading...</body></html>" }));
    const browser = new StubFetcher(rawPage({ method: "browser" }));
    const result = await readerWith(http, browser).readPage({
      url: "https://example.com/article",
      mode: "auto",
      cacheMode: "live",
    });
    expect(result.fetchMethod).toBe("browser");
    expect(result.validation.status).toBe("usable");
    expect(http.calls).toBe(1);
    expect(browser.calls).toBe(1);
  });

  it("does not use browser to bypass access denial", async () => {
    const http = new StubFetcher(new ReadError("ACCESS_DENIED", "denied"));
    const browser = new StubFetcher(rawPage({ method: "browser" }));
    await expect(
      readerWith(http, browser).readPage({
        url: "https://example.com/article",
        mode: "auto",
        cacheMode: "live",
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(browser.calls).toBe(0);
  });

  it("returns a successful cached result without refetching", async () => {
    const http = new StubFetcher(rawPage({ fetchedAt: new Date().toISOString() }));
    const browser = new StubFetcher(new Error("unused"));
    const reader = readerWith(http, browser);
    const first = await reader.readPage({ url: "https://example.com/article", mode: "http" });
    const second = await reader.readPage({ url: "https://example.com/article", mode: "http" });
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(http.calls).toBe(1);
  });

  it("records live and cached reads in crawler statistics", async () => {
    const metrics = new CrawlerMetrics(":memory:");
    metricsStores.push(metrics);
    const http = new StubFetcher(rawPage({ fetchedAt: new Date().toISOString() }));
    const reader = readerWith(http, new StubFetcher(new Error("unused")), null, null, metrics);

    await reader.readPage({ url: "https://example.com/article", mode: "http" });
    await reader.readPage({ url: "https://example.com/article", mode: "http" });

    expect(metrics.getStats(1)).toMatchObject({
      totals: { requests: 2, successes: 2, failures: 0, cacheHits: 1 },
      fetchMethods: { http: 1, browser: 0 },
      cost: { attempts: 1 },
    });
  });

  it("records normalized reader failures in crawler statistics", async () => {
    const metrics = new CrawlerMetrics(":memory:");
    metricsStores.push(metrics);
    const reader = readerWith(
      new StubFetcher(new ReadError("ACCESS_DENIED", "denied")),
      new StubFetcher(new Error("unused")),
      null,
      null,
      metrics,
    );

    await expect(reader.readPage({
      url: "https://example.com/denied",
      mode: "http",
      cacheMode: "live",
    })).rejects.toMatchObject({ code: "ACCESS_DENIED" });

    expect(metrics.getStats(1)).toMatchObject({
      totals: { requests: 1, successes: 0, failures: 1 },
      failureReasons: [{ code: "ACCESS_DENIED", count: 1 }],
    });
  });

  it("reports a cache-only miss", async () => {
    const reader = readerWith(new StubFetcher(rawPage()), new StubFetcher(rawPage()));
    await expect(
      reader.readPage({
        url: "https://example.com/new",
        cacheMode: "cache-only",
      }),
    ).rejects.toMatchObject({ code: "CACHE_MISS" });
  });

  it("automatically indexes public reads but excludes authorized reads", async () => {
    const index = new LocalPageIndex(":memory:");
    const reader = readerWith(
      new StubFetcher(rawPage({ fetchedAt: new Date().toISOString() })),
      new StubFetcher(rawPage({ method: "browser", fetchedAt: new Date().toISOString() })),
      index,
    );
    try {
      await reader.readPage({
        url: "https://example.com/article",
        mode: "http",
        cacheMode: "live",
      });
      await reader.readPage({
        url: "https://example.com/private",
        mode: "browser",
        authProfile: "research",
        cacheMode: "live",
      });

      expect(index.count()).toBe(1);
      expect(index.search("complete article", 10, 1)).toHaveLength(1);
    } finally {
      index.close();
    }
  });

  it("retries a transient page failure and exposes attempt evidence", async () => {
    const responses: Array<RawPage | ReadError> = [
      new ReadError("UPSTREAM_ERROR", "temporary", { retryable: true }),
      rawPage({ fetchedAt: new Date().toISOString() }),
    ];
    const http: PageFetcher = {
      async fetch() {
        const response = responses.shift();
        if (response instanceof Error) {
          throw response;
        }
        if (response === undefined) {
          throw new Error("test response exhausted");
        }
        return response;
      },
    };
    const config = testConfig();
    const reader = new ReaderService(
      config,
      new UrlPolicy(async () => publicResolver()),
      new PageCache(":memory:"),
      http,
      new StubFetcher(new Error("unused")),
      null,
      new CrawlRequestPolicy(config),
    );
    readers.push(reader);

    const page = await reader.readPage({
      url: "https://example.com/article",
      mode: "http",
      cacheMode: "live",
    });

    expect(page.evidence).toMatchObject({ attempts: 2, totalRetryDelayMs: 0 });
    expect(responses).toEqual([]);
  });

  it("reports proxy use without exposing proxy configuration", async () => {
    const page = await readerWith(
      new StubFetcher(rawPage({ proxyUsed: true })),
      new StubFetcher(new Error("unused")),
    ).readPage({
      url: "https://example.com/article",
      mode: "http",
      cacheMode: "live",
    });

    expect(page.evidence.proxyUsed).toBe(true);
    expect(JSON.stringify(page)).not.toContain("proxy.example");
  });

  it("preserves public Agent identity evidence", async () => {
    const agentIdentity = {
      userAgent: "DiaoyanCrawler/0.10 (+https://crawler.example)",
      identityUrl: "https://crawler.example/identity",
      signed: true,
      profile: "cloudflare-legacy" as const,
    };
    const page = await readerWith(
      new StubFetcher(rawPage({ agentIdentity })),
      new StubFetcher(new Error("unused")),
    ).readPage({
      url: "https://example.com/article",
      mode: "http",
      cacheMode: "live",
    });

    expect(page.evidence.agentIdentity).toEqual(agentIdentity);
  });

  it("preserves RSL policy evidence", async () => {
    const rsl = {
      status: "permitted" as const,
      usage: "ai-input" as const,
      discoveredBy: ["robots" as const],
      licenseUrls: ["https://example.com/license.xml"],
      licenseHashes: ["sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      approvalsApplied: 0,
    };
    const page = await readerWith(
      new StubFetcher(rawPage({ rsl })),
      new StubFetcher(new Error("unused")),
    ).readPage({
      url: "https://example.com/article",
      mode: "http",
      cacheMode: "live",
    });

    expect(page.evidence.rsl).toEqual(rsl);
  });

  it("records one final audit entry for successful and failed reads", async () => {
    const audit = new RslAccessAudit(":memory:", "ai-input");
    auditStores.push(audit);
    await readerWith(
      new StubFetcher(rawPage()),
      new StubFetcher(new Error("unused")),
      null,
      null,
      null,
      audit,
    ).readPage({
      url: "https://example.com/success",
      mode: "http",
      cacheMode: "live",
    });
    await expect(
      readerWith(
        new StubFetcher(new ReadError("ACCESS_DENIED", "denied")),
        new StubFetcher(new Error("unused")),
        null,
        null,
        null,
        audit,
      ).readPage({
        url: "https://example.com/failure",
        mode: "http",
        cacheMode: "live",
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });

    expect(audit.list().entries).toMatchObject([
      { requestUrl: "https://example.com/failure", outcome: "failure" },
      { requestUrl: "https://example.com/success", outcome: "success" },
    ]);
  });
});
