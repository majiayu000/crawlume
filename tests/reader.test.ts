import { afterEach, describe, expect, it } from "vitest";

import { PageCache } from "../src/cache.js";
import { ReadError } from "../src/errors.js";
import { ReaderService } from "../src/reader.js";
import { UrlPolicy } from "../src/security/url-policy.js";
import { publicResolver, rawPage, StubFetcher, testConfig } from "./helpers.js";

const readers: ReaderService[] = [];

function readerWith(http: StubFetcher, browser: StubFetcher): ReaderService {
  const reader = new ReaderService(
    testConfig(),
    new UrlPolicy(async () => publicResolver()),
    new PageCache(":memory:"),
    http,
    browser,
  );
  readers.push(reader);
  return reader;
}

afterEach(() => {
  while (readers.length > 0) {
    readers.pop()?.close();
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

  it("reports a cache-only miss", async () => {
    const reader = readerWith(new StubFetcher(rawPage()), new StubFetcher(rawPage()));
    await expect(
      reader.readPage({
        url: "https://example.com/new",
        cacheMode: "cache-only",
      }),
    ).rejects.toMatchObject({ code: "CACHE_MISS" });
  });
});
