import { afterEach, describe, expect, it, vi } from "vitest";

import { ReadError } from "../src/errors.js";
import { createApp } from "../src/app.js";
import { VerticalSearchService } from "../src/search.js";
import { UrlPolicy } from "../src/security/url-policy.js";
import type { CrawlJob, DurableCrawlOptions, SearchWebResult } from "../src/types.js";
import { testConfig } from "./helpers.js";

const services: VerticalSearchService[] = [];

type ServiceOptions = {
  searchWeb?: (options: import("../src/types.js").SearchWebOptions) => Promise<SearchWebResult>;
  start?: (options: DurableCrawlOptions) => CrawlJob;
  get?: (id: string) => CrawlJob;
  indexCount?: () => number;
  recrawlPriority?: (url: string, nowMs: number) => number;
  now?: () => number;
};

function crawlJob(id: string, status: CrawlJob["status"] = "queued"): CrawlJob {
  return {
    id,
    status,
    input: { url: "https://docs.example.com/" },
    createdAt: "2026-08-31T00:00:00.000Z",
    startedAt: status === "queued" ? null : "2026-08-31T00:00:01.000Z",
    completedAt: ["completed", "failed", "cancelled"].includes(status)
      ? "2026-08-31T00:01:00.000Z"
      : null,
    result: status === "completed" ? {
      status: "ok",
      sourceUrl: "https://docs.example.com/",
      startedAt: "2026-08-31T00:00:01.000Z",
      completedAt: "2026-08-31T00:01:00.000Z",
      scannedPages: 1,
      pages: [],
      failures: [],
      truncated: false,
    } : null,
    error: status === "failed"
      ? { code: "UPSTREAM_ERROR", message: "failed", retryable: true, details: {} }
      : null,
    progress: {
      discoveredCount: 1,
      queuedCount: status === "queued" ? 1 : 0,
      leasedCount: status === "running" ? 1 : 0,
      succeededCount: status === "completed" ? 1 : 0,
      failedCount: status === "failed" ? 1 : 0,
      stoppedCount: status === "cancelled" ? 1 : 0,
      publishedCount: ["completed", "failed", "cancelled"].includes(status) ? 1 : 0,
    },
    usage: {
      providerAttempts: ["completed", "failed"].includes(status) ? 1 : 0,
      documentBytesIn: 0,
      networkBytesOut: 0,
      browserMilliseconds: 0,
      browserContextStarts: 0,
      retryDelayMilliseconds: 0,
      optionalModelTokens: 0,
    },
    budget: {
      maxDurationMs: 86_400_000,
      maxProviderAttempts: 1,
      maxDocumentBytes: 5_000_000,
      maxBrowserMs: 30_000,
      maxBrowserContexts: 1,
    },
    termination: null,
  };
}

function createService(options: ServiceOptions = {}): VerticalSearchService {
  const service = new VerticalSearchService({
    path: ":memory:",
    urlPolicy: new UrlPolicy(async () => [{ address: "93.184.216.34", family: 4 }]),
    jobs: {
      start: vi.fn(options.start ?? (() => {
        throw new Error("not used");
      })),
      get: vi.fn(options.get ?? (() => {
        throw new Error("not used");
      })),
    },
    search: {
      searchWeb: vi.fn(options.searchWeb ?? (async () => { throw new Error("not used"); })),
    },
    index: {
      count: vi.fn(options.indexCount ?? (() => 0)),
      recrawlPriority: vi.fn(options.recrawlPriority ?? (() => 0)),
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  services.push(service);
  return service;
}

afterEach(() => {
  while (services.length > 0) services.pop()?.close();
});

describe("VerticalSearchService source admission", () => {
  it("auto-admits normalized official domains and exact manual URLs with provenance", () => {
    const service = createService();

    const official = service.addOfficialDomain("https://Docs.Example.com/guide?from=seed#intro");
    const manual = service.addManualUrl("https://outside.example/reference?id=1#section");

    expect(official).toMatchObject({
      url: "https://docs.example.com/",
      origin: "https://docs.example.com",
      scope: "domain",
      provenance: "official",
      status: "admitted",
    });
    expect(manual).toMatchObject({
      url: "https://outside.example/reference?id=1",
      origin: "https://outside.example",
      scope: "url",
      provenance: "manual",
      status: "admitted",
    });
    expect(service.listSeeds()).toHaveLength(2);
  });

  it("enforces the 600 official-domain capacity without weakening updates", () => {
    const service = createService();
    for (let index = 0; index < 600; index += 1) {
      service.addOfficialDomain(`https://docs-${index}.example.com/path`);
    }

    expect(() => service.addOfficialDomain("https://overflow.example.com"))
      .toThrowError(expect.objectContaining<Partial<ReadError>>({ code: "BUDGET_EXHAUSTED" }));
    expect(service.addOfficialDomain("https://docs-0.example.com/another")).toMatchObject({
      url: "https://docs-0.example.com/",
      status: "admitted",
    });
  });
});

describe("VerticalSearchService discovery admission", () => {
  it("uses SearXNG only for discovery and auto-admits only allowlisted origins", async () => {
    const service = createService({ searchWeb: async () => ({
      status: "ok",
      query: "agent sdk",
      provider: "searxng",
      searchedAt: "2026-08-31T00:00:00.000Z",
      page: 1,
      results: [
        {
          title: "Official SDK",
          url: "https://docs.example.com/sdk#install",
          snippet: "SDK guide",
          source: "web",
          engines: ["google"],
          score: 1,
          publishedAt: null,
          thumbnailUrl: null,
        },
        {
          title: "Community SDK",
          url: "https://community.example.net/agent-sdk",
          snippet: "Community guide",
          source: "web",
          engines: ["bing"],
          score: 0.8,
          publishedAt: null,
          thumbnailUrl: null,
        },
      ],
      totalResults: 2,
      warnings: [],
    }) });
    service.addOfficialDomain("https://docs.example.com");

    const discovered = await service.discover("agent sdk");

    expect(discovered).toMatchObject({ query: "agent sdk", discovered: 2, admitted: 1, pending: 1 });
    expect(service.listSeeds().map(({ url, provenance, status, discoveryQuery }) => ({
      url, provenance, status, discoveryQuery,
    }))).toEqual(expect.arrayContaining([
      {
        url: "https://docs.example.com/sdk",
        provenance: "searxng",
        status: "admitted",
        discoveryQuery: "agent sdk",
      },
      {
        url: "https://community.example.net/agent-sdk",
        provenance: "searxng",
        status: "pending",
        discoveryQuery: "agent sdk",
      },
    ]));
    const pending = service.listSeeds("pending")[0]!;
    expect(service.decideCandidate(pending.id, "rejected")).toMatchObject({ status: "rejected" });
  });

  it("propagates discovery failure without creating an empty successful candidate batch", async () => {
    const service = createService({ searchWeb: async () => {
      throw new ReadError("SEARCH_PROVIDER_ERROR", "discovery unavailable", { retryable: true });
    } });

    await expect(service.discover("agent sdk")).rejects.toMatchObject({
      code: "SEARCH_PROVIDER_ERROR",
      retryable: true,
    });
    expect(service.listSeeds()).toEqual([]);
  });
});

describe("VerticalSearchService daily incremental runs", () => {
  it("orders admitted exact URLs by deterministic page-history recrawl priority", () => {
    const started: string[] = [];
    const service = createService({
      start: (options) => {
        started.push(options.url);
        return crawlJob(`job-${started.length}`);
      },
      recrawlPriority: (url) => url.endsWith("/fast") ? 10_000 : 10,
      now: () => Date.parse("2026-08-31T08:00:00.000Z"),
    });
    service.addManualUrl("https://docs.example.com/slow");
    service.addManualUrl("https://docs.example.com/fast");

    service.startDailyRun();

    expect(started).toEqual([
      "https://docs.example.com/fast",
      "https://docs.example.com/slow",
    ]);
  });

  it("caps a 600-domain daily plan at 60,000 provider attempts", () => {
    let sequence = 0;
    const start = vi.fn((options: DurableCrawlOptions) => crawlJob(`job-${sequence += 1}`));
    const service = createService({
      start,
      now: () => Date.parse("2026-08-31T08:00:00.000Z"),
    });
    for (let index = 0; index < 600; index += 1) {
      service.addOfficialDomain(`https://docs-${index}.example.com`);
    }

    const run = service.startDailyRun();

    expect(run).toMatchObject({ status: "running", plannedProviderAttempts: 60_000 });
    expect(start).toHaveBeenCalledTimes(600);
    expect(start.mock.calls.reduce(
      (total, [options]) => total + (options.crawlBudget?.maxProviderAttempts ?? 0),
      0,
    )).toBe(60_000);
    expect(start.mock.calls.every(([options]) => options.maxPages === 100)).toBe(true);
  });

  it("uses remaining index capacity as a hard plan limit and rejects a full index", () => {
    const start = vi.fn((options: DurableCrawlOptions) => crawlJob("job-one"));
    const service = createService({
      start,
      indexCount: () => 299_950,
      now: () => Date.parse("2026-08-31T08:00:00.000Z"),
    });
    service.addOfficialDomain("https://docs.example.com");

    expect(service.startDailyRun()).toMatchObject({ plannedProviderAttempts: 50 });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      maxPages: 50,
      crawlBudget: expect.objectContaining({ maxProviderAttempts: 50 }),
    }));

    const full = createService({
      indexCount: () => 300_000,
      now: () => Date.parse("2026-09-01T08:00:00.000Z"),
    });
    full.addManualUrl("https://docs.example.com/page");
    expect(() => full.startDailyRun()).toThrowError(
      expect.objectContaining<Partial<ReadError>>({ code: "BUDGET_EXHAUSTED" }),
    );
  });

  it("rebuilds run state from durable jobs and exposes partial failures", () => {
    const states = new Map<string, CrawlJob>();
    let sequence = 0;
    const service = createService({
      start: () => {
        const id = `job-${sequence += 1}`;
        const job = crawlJob(id);
        states.set(id, job);
        return job;
      },
      get: (id) => states.get(id)!,
      now: () => Date.parse("2026-08-31T08:00:00.000Z"),
    });
    service.addManualUrl("https://docs.example.com/one");
    service.addManualUrl("https://docs.example.com/two");
    const started = service.startDailyRun();
    states.set("job-1", crawlJob("job-1", "completed"));
    states.set("job-2", crawlJob("job-2", "failed"));

    const refreshed = service.refreshRun(started.id);

    expect(refreshed).toMatchObject({
      status: "partial",
      completedJobs: 1,
      failedJobs: 1,
      usedProviderAttempts: 2,
    });
    expect(refreshed.jobs.map((job) => job.status)).toEqual(["completed", "failed"]);
  });
});

describe("VerticalSearchService query evaluation", () => {
  it("persists human judgments and calculates Hit@10, Recall@10, and MRR@10 locally", async () => {
    const searchWeb = vi.fn(async (options: import("../src/types.js").SearchWebOptions) => {
      const urls = options.query === "agent sdk"
        ? ["https://docs.example.com/sdk", "https://docs.example.com/other"]
        : ["https://docs.example.com/other", "https://docs.example.com/api"];
      return {
        status: "ok" as const,
        query: options.query,
        provider: "local",
        searchedAt: "2026-08-31T00:00:00.000Z",
        page: 1,
        results: urls.map((url) => ({
          title: url,
          url,
          snippet: "",
          source: "local" as const,
          engines: ["diaoyan-local"],
          score: null,
          publishedAt: null,
          thumbnailUrl: null,
        })),
        totalResults: null,
        warnings: [],
      };
    });
    const service = createService({ searchWeb });
    service.setQueryJudgment("agent sdk", [
      "https://docs.example.com/sdk#install",
      "https://docs.example.com/reference",
    ]);
    service.setQueryJudgment("responses api", ["https://docs.example.com/api"]);

    const report = await service.evaluateQuerySet();

    expect(report).toMatchObject({
      queryCount: 2,
      hitAt10: 1,
      recallAt10: 0.75,
      mrrAt10: 0.75,
    });
    expect(report.cases).toEqual([
      expect.objectContaining({ query: "agent sdk", hitAt10: 1, recallAt10: 0.5, reciprocalRank: 1 }),
      expect.objectContaining({ query: "responses api", hitAt10: 1, recallAt10: 1, reciprocalRank: 0.5 }),
    ]);
    expect(searchWeb).toHaveBeenCalledTimes(2);
    expect(searchWeb.mock.calls.every(([options]) => options.source === "local")).toBe(true);
  });

  it("refuses to report quality when no fixed judgments exist", async () => {
    const service = createService();

    await expect(service.evaluateQuerySet()).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("records a named paired experiment and passes only a measured improvement", async () => {
    const searchWeb = vi.fn(async (options: import("../src/types.js").SearchWebOptions) => {
      const urls = options.query === "agent sdk"
        ? ["https://docs.example.com/other", "https://docs.example.com/sdk"]
        : ["https://docs.example.com/other"];
      return {
        status: "ok" as const,
        query: options.query,
        provider: "local",
        searchedAt: "2026-08-31T00:00:00.000Z",
        page: 1,
        results: urls.map((url) => ({
          title: url,
          url,
          snippet: "",
          source: "local" as const,
          engines: ["diaoyan-local"],
          score: null,
          publishedAt: null,
          thumbnailUrl: null,
        })),
        totalResults: null,
        warnings: [],
      };
    });
    const service = createService({
      searchWeb,
      now: () => Date.parse("2026-08-31T08:00:00.000Z"),
    });
    service.setQueryJudgment("agent sdk", ["https://docs.example.com/sdk"]);
    service.setQueryJudgment("responses api", ["https://docs.example.com/api"]);
    const retrieveCandidate = vi.fn(async (query: string, limit: number) => {
      expect(limit).toBe(10);
      return query === "agent sdk"
        ? ["https://docs.example.com/sdk#install", "https://docs.example.com/other"]
        : ["https://docs.example.com/api"];
    });

    const report = await service.runRetrievalExperiment("  hybrid-v1  ", retrieveCandidate);

    expect(report).toMatchObject({
      name: "hybrid-v1",
      evaluatedAt: "2026-08-31T08:00:00.000Z",
      queryCount: 2,
      baseline: { hitAt10: 0.5, recallAt10: 0.5, mrrAt10: 0.25 },
      candidate: { hitAt10: 1, recallAt10: 1, mrrAt10: 1 },
      delta: { hitAt10: 0.5, recallAt10: 0.5, mrrAt10: 0.75 },
      releaseGate: {
        passed: true,
        noRegression: { hitAt10: true, recallAt10: true, mrrAt10: true },
        improvesAtLeastOneMetric: true,
      },
    });
    expect(report.cases).toEqual([
      expect.objectContaining({
        query: "agent sdk",
        expectedUrls: ["https://docs.example.com/sdk"],
        baseline: expect.objectContaining({
          resultUrls: ["https://docs.example.com/other", "https://docs.example.com/sdk"],
          reciprocalRank: 0.5,
        }),
        candidate: expect.objectContaining({
          resultUrls: ["https://docs.example.com/sdk", "https://docs.example.com/other"],
          reciprocalRank: 1,
        }),
        delta: expect.objectContaining({ reciprocalRank: 0.5 }),
      }),
      expect.objectContaining({
        query: "responses api",
        baseline: expect.objectContaining({ reciprocalRank: 0 }),
        candidate: expect.objectContaining({ reciprocalRank: 1 }),
      }),
    ]);
    expect(searchWeb).toHaveBeenCalledTimes(2);
    expect(searchWeb.mock.calls.every(([options]) => options.source === "local")).toBe(true);
    expect(retrieveCandidate).toHaveBeenCalledTimes(2);
    expect(service.getRetrievalExperiment("hybrid-v1")).toEqual(report);
    await expect(service.runRetrievalExperiment("hybrid-v1", retrieveCandidate)).rejects
      .toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("blocks release when the candidate only reproduces the lexical baseline", async () => {
    const urls = ["https://docs.example.com/sdk"];
    const service = createService({
      searchWeb: async (options) => ({
        status: "ok",
        query: options.query,
        provider: "local",
        searchedAt: "2026-08-31T00:00:00.000Z",
        page: 1,
        results: urls.map((url) => ({
          title: url,
          url,
          snippet: "",
          source: "local",
          engines: ["diaoyan-local"],
          score: null,
          publishedAt: null,
          thumbnailUrl: null,
        })),
        totalResults: null,
        warnings: [],
      }),
    });
    service.setQueryJudgment("agent sdk", urls);

    const report = await service.runRetrievalExperiment("lexical-copy", async () => urls);

    expect(report.releaseGate).toEqual({
      passed: false,
      noRegression: { hitAt10: true, recallAt10: true, mrrAt10: true },
      improvesAtLeastOneMetric: false,
    });
    expect(report.delta).toEqual({ hitAt10: 0, recallAt10: 0, mrrAt10: 0 });
  });
});

describe("VerticalSearchService app lifecycle", () => {
  it("is available with the local index and closes with the app", async () => {
    const app = createApp(
      { ...testConfig(), localIndexEnabled: true },
      { runCrawlWorker: false, runMonitorWorker: false },
    );
    try {
      expect(app.verticalSearch).not.toBeNull();
      expect(app.verticalSearch?.addManualUrl("https://docs.example.com/start"))
        .toMatchObject({ status: "admitted", provenance: "manual" });
    } finally {
      await app.close();
    }
  });
});
