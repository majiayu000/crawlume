import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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

describe("durable crawl graceful recovery", () => {
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
