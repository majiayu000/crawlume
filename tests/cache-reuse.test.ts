import { afterEach, describe, expect, it } from "vitest";

import { PageCache } from "../src/cache.js";
import { ReaderService } from "../src/reader.js";
import { UrlPolicy } from "../src/security/url-policy.js";
import type { PageFetchOptions, PageFetcher, RawPage } from "../src/types.js";
import { publicResolver, rawPage, StubFetcher, testConfig } from "./helpers.js";

const readers: ReaderService[] = [];

afterEach(async () => {
  while (readers.length > 0) await readers.pop()?.close();
});

function reader(http: PageFetcher): ReaderService {
  const value = new ReaderService(
    testConfig(),
    new UrlPolicy(async () => publicResolver()),
    new PageCache(":memory:"),
    http,
    new StubFetcher(new Error("browser must not run")),
  );
  readers.push(value);
  return value;
}

describe("cache reuse", () => {
  it("revalidates a stale artifact with ETag/Last-Modified and a 304 response", async () => {
    const calls: PageFetchOptions[] = [];
    const pages: RawPage[] = [
      rawPage({
        fetchedAt: new Date(Date.now() - 60_000).toISOString(),
        etag: '"article-v1"',
        lastModified: "Sun, 30 Aug 2026 08:00:00 GMT",
      }),
      rawPage({
        body: "",
        bodyBytes: new Uint8Array(),
        responseBytes: 0,
        httpStatus: 304,
        notModified: true,
        fetchedAt: new Date().toISOString(),
        etag: '"article-v1"',
        lastModified: "Sun, 30 Aug 2026 08:00:00 GMT",
      }),
    ];
    const http: PageFetcher = {
      async fetch(_url, options = {}) {
        calls.push(options);
        const page = pages.shift();
        if (page === undefined) throw new Error("unexpected fetch");
        return page;
      },
    };
    const service = reader(http);

    const live = await service.readPage({
      url: "https://example.com/article",
      cacheMode: "live",
      browserAllowed: false,
      maxAgeSeconds: 1,
    });
    const revalidated = await service.readPage({
      url: "https://example.com/article",
      browserAllowed: false,
      maxAgeSeconds: 1,
    });

    expect(revalidated.contentHash).toBe(live.contentHash);
    expect(revalidated.cached).toBe(true);
    expect(revalidated.evidence.cacheStatus).toBe("revalidated");
    expect(calls[1]?.revalidate).toEqual({
      url: "https://example.com/article",
      etag: '"article-v1"',
      lastModified: "Sun, 30 Aug 2026 08:00:00 GMT",
    });
  });

  it("coalesces concurrent live reads with the same plan and cache key", async () => {
    let calls = 0;
    const http: PageFetcher = {
      async fetch() {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return rawPage({ fetchedAt: new Date().toISOString() });
      },
    };
    const service = reader(http);

    const [first, second] = await Promise.all([
      service.readPage({
        url: "https://example.com/article",
        cacheMode: "live",
        browserAllowed: false,
      }),
      service.readPage({
        url: "https://example.com/article",
        cacheMode: "live",
        browserAllowed: false,
      }),
    ]);

    expect(first.contentHash).toBe(second.contentHash);
    expect(calls).toBe(1);
  });

  it("serves explicitly marked stale content while one background refresh runs", async () => {
    let calls = 0;
    const first = rawPage({
      fetchedAt: new Date(Date.now() - 60_000).toISOString(),
      body: rawPage().body.replace("Example article", "Old article"),
    });
    const refreshed = rawPage({
      fetchedAt: new Date().toISOString(),
      body: rawPage().body.replace("Example article", "Fresh article"),
    });
    const http: PageFetcher = {
      async fetch() {
        calls += 1;
        if (calls === 1) return first;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return refreshed;
      },
    };
    const service = reader(http);
    await service.readPage({
      url: "https://example.com/article",
      cacheMode: "live",
      browserAllowed: false,
      maxAgeSeconds: 1,
    });

    const stale = await service.readPage({
      url: "https://example.com/article",
      browserAllowed: false,
      maxAgeSeconds: 1,
      staleWhileRevalidateSeconds: 120,
    });
    expect(stale.title).toContain("Old article");
    expect(stale.cached).toBe(true);
    expect(stale.evidence.cacheStatus).toBe("stale");

    await service.drainBackgroundRevalidations();
    const fresh = await service.readPage({
      url: "https://example.com/article",
      browserAllowed: false,
      maxAgeSeconds: 1,
    });
    expect(fresh.title).toContain("Fresh article");
    expect(fresh.evidence.cacheStatus).toBe("fresh");
    expect(calls).toBe(2);
  });

  it("surfaces revalidation failures instead of silently treating stale content as fresh", async () => {
    let calls = 0;
    const http: PageFetcher = {
      async fetch() {
        calls += 1;
        if (calls === 1) {
          return rawPage({ fetchedAt: new Date(Date.now() - 60_000).toISOString() });
        }
        throw new Error("revalidation failed");
      },
    };
    const service = reader(http);
    await service.readPage({
      url: "https://example.com/article",
      cacheMode: "live",
      browserAllowed: false,
      maxAgeSeconds: 1,
    });

    await expect(service.readPage({
      url: "https://example.com/article",
      browserAllowed: false,
      maxAgeSeconds: 1,
    })).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    const stale = await service.readPage({
      url: "https://example.com/article",
      browserAllowed: false,
      maxAgeSeconds: 1,
      staleWhileRevalidateSeconds: 120,
    });
    expect(stale.evidence.cacheStatus).toBe("stale");
    await expect(service.drainBackgroundRevalidations()).rejects.toThrow(
      "stale cache revalidations failed",
    );
  });
});
