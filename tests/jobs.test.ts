import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReadError } from "../src/errors.js";
import { CrawlJobService, CrawlJobStore } from "../src/jobs.js";
import type { SiteService } from "../src/site.js";
import type { CrawlSiteOptions, CrawlSiteResult } from "../src/types.js";

const services: CrawlJobService[] = [];
const stores: CrawlJobStore[] = [];
const temporaryDirectories: string[] = [];

function input(url = "https://example.com/"): CrawlSiteOptions {
  return { url, mode: "http", maxPages: 5, maxDepth: 1 };
}

function result(url = "https://example.com/"): CrawlSiteResult {
  const now = new Date().toISOString();
  return {
    status: "ok",
    sourceUrl: url,
    startedAt: now,
    completedAt: now,
    scannedPages: 0,
    pages: [],
    failures: [],
    truncated: false,
  };
}

function executor(
  crawlSite: (options: CrawlSiteOptions & { signal?: AbortSignal }) => Promise<CrawlSiteResult>,
): SiteService {
  return { crawlSite } as unknown as SiteService;
}

afterEach(async () => {
  while (services.length > 0) {
    await services.pop()?.close();
  }
  while (stores.length > 0) {
    stores.pop()?.close();
  }
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("CrawlJobService", () => {
  it("returns a durable job before completion and stores the final result", async () => {
    let finish: ((value: CrawlSiteResult) => void) | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const crawl = vi.fn(async () => new Promise<CrawlSiteResult>((resolve) => {
      finish = resolve;
      notifyStarted?.();
    }));
    const service = new CrawlJobService(new CrawlJobStore(":memory:"), executor(crawl));
    services.push(service);

    const created = service.start(input());
    expect(created.status).toBe("queued");
    await started;
    expect(service.get(created.id).status).toBe("running");

    finish?.(result());
    await vi.waitFor(() => expect(service.get(created.id).status).toBe("completed"));
    expect(service.get(created.id).result).toMatchObject({ status: "ok", scannedPages: 0 });
  });

  it("cooperatively cancels a running crawl", async () => {
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const crawl = async (options: CrawlSiteOptions & { signal?: AbortSignal }) => {
      notifyStarted?.();
      return new Promise<CrawlSiteResult>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(new ReadError("CRAWL_CANCELLED", "cancelled")),
          { once: true },
        );
      });
    };
    const service = new CrawlJobService(new CrawlJobStore(":memory:"), executor(crawl));
    services.push(service);
    const created = service.start(input());
    await started;

    service.cancel(created.id);
    await vi.waitFor(() => expect(service.get(created.id).status).toBe("cancelled"));
    expect(service.get(created.id)).toMatchObject({ result: null, error: null });
  });

  it("cancels a queued crawl without executing it", async () => {
    let releaseFirst: (() => void) | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const crawl = vi.fn(async (options: CrawlSiteOptions & { signal?: AbortSignal }) => {
      notifyStarted?.();
      return new Promise<CrawlSiteResult>((resolve, reject) => {
        releaseFirst = () => resolve(result());
        options.signal?.addEventListener(
          "abort",
          () => reject(new ReadError("CRAWL_CANCELLED", "cancelled")),
          { once: true },
        );
      });
    });
    const service = new CrawlJobService(new CrawlJobStore(":memory:"), executor(crawl));
    services.push(service);
    const first = service.start(input("https://example.com/first"));
    await started;
    const second = service.start(input("https://example.com/second"));

    expect(service.cancel(second.id).status).toBe("cancelled");
    expect(crawl).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await vi.waitFor(() => expect(service.get(first.id).status).toBe("completed"));
    expect(crawl).toHaveBeenCalledTimes(1);
  });

  it("stores normalized failures instead of losing worker errors", async () => {
    const crawl = async () => {
      throw new ReadError("RATE_LIMITED", "slow down", { retryable: true });
    };
    const service = new CrawlJobService(new CrawlJobStore(":memory:"), executor(crawl));
    services.push(service);
    const created = service.start(input());

    await vi.waitFor(() => expect(service.get(created.id).status).toBe("failed"));
    expect(service.get(created.id).error).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });
  });

  it("requeues a running job after an interrupted store is reopened", () => {
    const directory = mkdtempSync(join(tmpdir(), "diaoyan-jobs-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "jobs.sqlite");
    const first = new CrawlJobStore(path);
    const created = first.create(input());
    expect(first.claimNext()?.status).toBe("running");
    first.close();

    const recovered = new CrawlJobStore(path);
    stores.push(recovered);
    recovered.recoverInterrupted();
    expect(recovered.get(created.id)?.status).toBe("queued");
  });

  it("fails visibly for an unknown job", () => {
    const store = new CrawlJobStore(":memory:");
    stores.push(store);
    expect(() => store.require("00000000-0000-4000-8000-000000000000")).toThrowError(
      expect.objectContaining({ code: "JOB_NOT_FOUND" }),
    );
  });

  it("does not recover or execute jobs in an inactive CLI process", async () => {
    const store = new CrawlJobStore(":memory:");
    const created = store.create(input());
    expect(store.claimNext()?.status).toBe("running");
    const crawl = vi.fn(async () => result());
    const service = new CrawlJobService(store, executor(crawl), false);
    services.push(service);

    expect(service.get(created.id).status).toBe("running");
    expect(() => service.start(input("https://example.com/other"))).toThrow(
      "not active in this process",
    );
    expect(crawl).not.toHaveBeenCalled();
  });

  it("requeues the active crawl during graceful service shutdown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "diaoyan-jobs-shutdown-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "jobs.sqlite");
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const crawl = async (options: CrawlSiteOptions & { signal?: AbortSignal }) => {
      notifyStarted?.();
      return new Promise<CrawlSiteResult>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(new ReadError("CRAWL_CANCELLED", "shutdown")),
          { once: true },
        );
      });
    };
    const service = new CrawlJobService(new CrawlJobStore(path), executor(crawl));
    const created = service.start(input());
    await started;
    await service.close();

    const reopened = new CrawlJobStore(path);
    stores.push(reopened);
    expect(reopened.get(created.id)?.status).toBe("queued");
  });
});
