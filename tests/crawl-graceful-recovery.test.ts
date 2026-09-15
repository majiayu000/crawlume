import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PageCache } from "../src/cache.js";
import { FrontierStore } from "../src/frontier-store.js";
import { AttemptLedger } from "../src/jobs.js";
import { ReaderService } from "../src/reader.js";
import { DurableCrawlService } from "../src/runtime/frontier.js";
import { UrlPolicy } from "../src/security/url-policy.js";
import type { PageFetcher } from "../src/types.js";
import { publicResolver, rawPage, testConfig } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

async function createOriginRuntime(
  prefix: string,
  fetcher: PageFetcher,
  crawlLeaseMs = testConfig().crawlLeaseMs,
) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "cache.sqlite");
  const config = {
    ...testConfig(),
    cachePath: databasePath,
    crawlMinHostIntervalMs: 100,
    crawlWorkerConcurrency: 1,
    crawlLeaseMs,
  };
  const policy = new UrlPolicy(async () => publicResolver());
  const ledger = new AttemptLedger(databasePath);
  const reader = new ReaderService(
    config,
    policy,
    new PageCache(databasePath),
    fetcher,
    fetcher,
    null,
    null,
    null,
    null,
    () => "",
    ledger,
  );
  const store = new FrontierStore(databasePath);
  const service = new DurableCrawlService(store, reader, policy, config);
  return {
    service,
    store,
    async close() {
      await service.close();
      await reader.close();
      ledger.close();
    },
  };
}

describe("durable crawl graceful recovery", () => {
  it("records an origin start once at the fetch boundary", async () => {
    let externalRequests = 0;
    const fetcher: PageFetcher = {
      async fetch(_url, options) {
        options?.onNetworkRequestStart?.();
        options?.onNetworkRequestStart?.();
        externalRequests += 1;
        return rawPage({ finalUrl: "https://example.com/" });
      },
    };
    const runtime = await createOriginRuntime("diaoyan-crawl-origin-start-", fetcher);
    const { service, store } = runtime;
    const markOriginStarted = vi.spyOn(store, "markOriginStarted");
    const job = service.start({
      url: "https://example.com/",
      browserAllowed: false,
      cacheMode: "live",
      maxPages: 1,
      concurrency: 1,
    });

    try {
      for (let attempt = 0; attempt < 100 && service.pages(job.id, 0, 10).pages.length === 0;
        attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(externalRequests).toBe(1);
      expect(markOriginStarted.mock.calls.map(([, intervalMs]) => intervalMs)).toEqual([0, 100, 0]);
      expect(service.pages(job.id, 0, 10).pages).toEqual([
        expect.objectContaining({ status: "succeeded", error: null }),
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("fences a second dispatch after the lease generation is recovered", async () => {
    let externalDispatches = 0;
    let jobId = "";
    let runtime: Awaited<ReturnType<typeof createOriginRuntime>>;
    let observeSecondCallback: (() => void) | undefined;
    const secondCallbackObserved = new Promise<void>((resolve) => {
      observeSecondCallback = resolve;
    });
    const fetcher: PageFetcher = {
      async fetch(_url, options) {
        options?.onNetworkRequestStart?.();
        externalDispatches += 1;
        await new Promise((resolve) => setTimeout(resolve, 75));
        runtime.store.recoverExpiredLeases(jobId);
        runtime.store.requestPause(jobId);
        try {
          options?.onNetworkRequestStart?.();
          externalDispatches += 1;
        } finally {
          observeSecondCallback?.();
        }
        return rawPage({ finalUrl: "https://example.com/" });
      },
    };
    runtime = await createOriginRuntime("diaoyan-crawl-stale-dispatch-", fetcher, 50);
    const markOriginStarted = vi.spyOn(runtime.store, "markOriginStarted");
    const job = runtime.service.start({
      url: "https://example.com/",
      browserAllowed: false,
      cacheMode: "live",
      maxPages: 1,
      concurrency: 1,
    });
    jobId = job.id;

    try {
      await secondCallbackObserved;
      expect(externalDispatches).toBe(1);
      expect(markOriginStarted.mock.calls.map(([, intervalMs]) => intervalMs)).toEqual([0, 100, 0]);
      expect(runtime.store.getJob(job.id)).toMatchObject({
        status: "paused",
        progress: { queued: 1, leased: 0 },
      });
    } finally {
      await runtime.close();
    }
  });

  it("rejects background stale revalidation for durable crawls", async () => {
    const fetcher: PageFetcher = {
      async fetch() {
        throw new Error("background fetch must not start");
      },
    };
    const runtime = await createOriginRuntime("diaoyan-crawl-stale-refresh-", fetcher);
    try {
      expect(() => runtime.service.start({
        url: "https://example.com/stale",
        cacheMode: "prefer-cache",
        staleWhileRevalidateSeconds: 1,
        maxPages: 1,
      })).toThrow(expect.objectContaining({
        code: "INVALID_ARGUMENT",
        message: "Durable crawls do not support stale-while-revalidate background requests.",
      }));
    } finally {
      await runtime.close();
    }
  });

  it("does not retry or dispatch when origin-start persistence fails", async () => {
    let externalRequests = 0;
    const fetcher: PageFetcher = {
      async fetch(_url, options) {
        options?.onNetworkRequestStart?.();
        externalRequests += 1;
        return rawPage({ finalUrl: "https://example.com/" });
      },
    };
    const runtime = await createOriginRuntime("diaoyan-crawl-origin-failure-", fetcher);
    const { service, store } = runtime;
    const persistOriginStart = store.markOriginStarted.bind(store);
    const markOriginStarted = vi.spyOn(store, "markOriginStarted").mockImplementation(
      (lease, intervalMs) => {
        if (intervalMs === 0) return persistOriginStart(lease, intervalMs);
        throw new Error("controlled SQLite write failure");
      },
    );
    const job = service.start({
      url: "https://example.com/",
      browserAllowed: false,
      cacheMode: "live",
      maxPages: 1,
      concurrency: 1,
    });

    try {
      for (let attempt = 0; attempt < 100 && service.pages(job.id, 0, 10).pages.length === 0;
        attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(externalRequests).toBe(0);
      expect(markOriginStarted.mock.calls.map(([, intervalMs]) => intervalMs)).toEqual([0, 100]);
      expect(service.pages(job.id, 0, 10).pages).toEqual([
        expect.objectContaining({
          status: "failed",
          error: expect.objectContaining({ code: "INTERNAL_ERROR", retryable: false }),
        }),
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("does no reader work when the lease is stale before preflight", async () => {
    let fetchCalls = 0;
    const fetcher: PageFetcher = {
      async fetch() {
        fetchCalls += 1;
        return rawPage({ finalUrl: "https://example.com/" });
      },
    };
    const runtime = await createOriginRuntime("diaoyan-crawl-stale-lease-", fetcher);
    const { service, store } = runtime;
    const markOriginStarted = vi.spyOn(store, "markOriginStarted").mockReturnValue(false);
    service.start({
      url: "https://example.com/",
      browserAllowed: false,
      cacheMode: "live",
      maxPages: 1,
      concurrency: 1,
    });

    try {
      for (let attempt = 0; attempt < 100 && markOriginStarted.mock.calls.length === 0;
        attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(markOriginStarted).toHaveBeenCalledOnce();
      expect(markOriginStarted.mock.calls[0]?.[1]).toBe(0);
      expect(fetchCalls).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("retries a released page instead of replaying the shutdown attempt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crawlume-crawl-graceful-recovery-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "cache.sqlite");
    const config = {
      ...testConfig(),
      cachePath: databasePath,
      crawlMaxAttempts: 1,
      crawlWorkerConcurrency: 1,
    };
    const policy = new UrlPolicy(async () => publicResolver());
    let markStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const delayedFetcher: PageFetcher = {
      async fetch(_url, options) {
        markStarted?.();
        if (options?.signal === undefined) {
          throw new Error("The crawl fetch must include its cancellation signal.");
        }
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
        throw new Error("The delayed fetch should only finish through cancellation.");
      },
    };

    const firstLedger = new AttemptLedger(databasePath);
    const firstReader = new ReaderService(
      config,
      policy,
      new PageCache(databasePath),
      delayedFetcher,
      delayedFetcher,
      null,
      null,
      null,
      null,
      () => "",
      firstLedger,
    );
    const first = new DurableCrawlService(
      new FrontierStore(databasePath),
      firstReader,
      policy,
      config,
    );
    const job = first.start({
      url: "https://example.com/",
      browserAllowed: false,
      cacheMode: "live",
      maxPages: 1,
      concurrency: 1,
    });

    await started;
    await first.close();
    await firstReader.close();
    firstLedger.close();

    let freshFetches = 0;
    const freshFetcher: PageFetcher = {
      async fetch() {
        freshFetches += 1;
        return rawPage({ finalUrl: "https://example.com/" });
      },
    };
    const secondLedger = new AttemptLedger(databasePath);
    const secondReader = new ReaderService(
      config,
      policy,
      new PageCache(databasePath),
      freshFetcher,
      freshFetcher,
      null,
      null,
      null,
      null,
      () => "",
      secondLedger,
    );
    const second = new DurableCrawlService(
      new FrontierStore(databasePath),
      secondReader,
      policy,
      config,
    );

    try {
      for (let attempt = 0; attempt < 100 && second.pages(job.id, 0, 10).pages.length === 0;
        attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(freshFetches).toBe(1);
      expect(second.pages(job.id, 0, 10).pages).toEqual([
        expect.objectContaining({ status: "succeeded", error: null }),
      ]);
    } finally {
      await second.close();
      await secondReader.close();
      secondLedger.close();
    }
  });
});
