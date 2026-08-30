import { describe, expect, it } from "vitest";

import type { FrontierStore } from "../src/frontier-store.js";
import { DurableCrawlService, type FrontierJob } from "../src/runtime/frontier.js";
import type { FrontierPublicationBatch } from "../src/runtime/frontier.js";
import type { ReaderService } from "../src/reader.js";
import { UrlPolicy } from "../src/security/url-policy.js";
import { emptyCrawlResourceUsage } from "../src/runtime/resource-governor.js";
import { publicResolver, testConfig } from "./helpers.js";

const jobId = "00000000-0000-4000-8000-000000000001";

function frontierJob(overrides: Partial<FrontierJob> = {}): FrontierJob {
  return {
    id: jobId,
    status: "running",
    input: { url: "https://example.com/root", maxPages: 1 },
    maxPages: 1,
    createdAtMs: 0,
    startedAtMs: 0,
    completedAtMs: null,
    progress: {
      discovered: 1,
      queued: 1,
      leased: 0,
      succeeded: 0,
      failed: 0,
      stopped: 0,
      published: 0,
    },
    pauseRequested: false,
    cancelRequested: false,
    truncated: false,
    concurrency: 1,
    budget: {
      maxDurationMs: 10_000,
      maxProviderAttempts: 1,
      maxDocumentBytes: 1_000,
      maxBrowserMs: 0,
      maxBrowserContexts: 0,
    },
    deadlineAtMs: 10_000,
    usage: emptyCrawlResourceUsage(),
    reservedUsage: emptyCrawlResourceUsage(),
    error: null,
    ...overrides,
  };
}

function publicationBatch(done = false): FrontierPublicationBatch {
  return {
    crawlId: jobId,
    pages: done ? [{
      sequence: 1,
      page: {
        id: "page-1",
        crawlId: jobId,
        requestedUrl: "https://example.com/root",
        normalizedUrl: "https://example.com/root",
        origin: "https://example.com",
        depth: 0,
        discoveredFrom: null,
        discoverySequence: 1,
        state: "stopped",
        nextEligibleAtMs: 0,
        executionCount: 0,
        createdAtMs: 0,
        startedAtMs: null,
        completedAtMs: 1,
      },
      result: null,
      error: { code: "CRAWL_CANCELLED", message: "cancelled", retryable: false, details: {} },
    }] : [],
    nextSequence: done ? 1 : 0,
    done,
  };
}

function service(store: Partial<FrontierStore>): DurableCrawlService {
  return new DurableCrawlService(
    store as FrontierStore,
    {} as ReaderService,
    new UrlPolicy(async () => publicResolver()),
    testConfig(),
    false,
  );
}

describe("crawl publication waiting", () => {
  it("reads again after registering so a publication cannot be missed", async () => {
    let reads = 0;
    const crawl = service({
      getJob: () => frontierJob(),
      listPublications: () => publicationBatch(++reads >= 2),
      close: () => undefined,
    });

    const batch = await crawl.waitForPages(jobId, 0, 10, 1_000);
    expect(batch).toMatchObject({ nextSequence: 1, done: true });
    expect(batch.pages).toHaveLength(1);
    await crawl.close();
  });

  it("wakes waiters when cancellation publishes terminal pages", async () => {
    let cancelled = false;
    const cancelledJob = frontierJob({
      status: "cancelled",
      completedAtMs: 1,
      cancelRequested: true,
      progress: {
        discovered: 1, queued: 0, leased: 0, succeeded: 0, failed: 0, stopped: 1, published: 1,
      },
    });
    const crawl = service({
      getJob: () => cancelled ? cancelledJob : frontierJob(),
      listPublications: () => publicationBatch(cancelled),
      requestCancel: () => {
        cancelled = true;
        return cancelledJob;
      },
      close: () => undefined,
    });

    const pending = crawl.waitForPages(jobId, 0, 10, 1_000);
    await Promise.resolve();
    crawl.cancel(jobId);

    await expect(pending).resolves.toMatchObject({ nextSequence: 1, done: true });
    await crawl.close();
  });

  it("returns the unchanged cursor on timeout and rejects request cancellation", async () => {
    const crawl = service({
      getJob: () => frontierJob(),
      listPublications: () => publicationBatch(false),
      close: () => undefined,
    });

    await expect(crawl.waitForPages(jobId, 0, 10, 10)).resolves.toEqual({
      jobId,
      pages: [],
      nextSequence: 0,
      done: false,
    });
    const controller = new AbortController();
    const cancelled = crawl.waitForPages(jobId, 0, 10, 1_000, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "CRAWL_CANCELLED" });
    await crawl.close();
  });

  it("replays committed publications immediately after reconnect", async () => {
    const stored = {
      getJob: () => frontierJob({ status: "cancelled", completedAtMs: 1 }),
      listPublications: () => publicationBatch(true),
      close: () => undefined,
    };
    const reconnected = service(stored);

    await expect(reconnected.waitForPages(jobId, 0, 10, 1_000)).resolves.toMatchObject({
      nextSequence: 1,
      done: true,
      pages: [expect.objectContaining({ publicationSequence: 1 })],
    });
    await reconnected.close();
  });

  it("caps concurrent publication waiters at 256", async () => {
    const crawl = service({
      getJob: () => frontierJob(),
      listPublications: () => publicationBatch(false),
      close: () => undefined,
    });
    const controllers = Array.from({ length: 256 }, () => new AbortController());
    const waits = controllers.map((controller) =>
      crawl.waitForPages(jobId, 0, 10, 1_000, controller.signal));
    await Promise.resolve();

    await expect(crawl.waitForPages(jobId, 0, 10, 1_000)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(waits);
    await crawl.close();
  });
});
