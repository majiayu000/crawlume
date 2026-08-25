import { afterEach, describe, expect, it } from "vitest";

import { PageCache } from "../src/cache.js";
import { ReadError } from "../src/errors.js";
import { ReaderService } from "../src/reader.js";
import { UrlPolicy } from "../src/security/url-policy.js";
import { SiteService } from "../src/site.js";
import type { PageFetcher, RawPage } from "../src/types.js";
import { publicResolver, rawPage, testConfig } from "./helpers.js";

class RoutingFetcher implements PageFetcher {
  readonly calls: string[] = [];

  constructor(private readonly routes: Map<string, RawPage | Error>) {}

  async fetch(url: URL): Promise<RawPage> {
    this.calls.push(url.toString());
    const route = this.routes.get(url.toString());
    if (route === undefined) {
      throw new ReadError("ACCESS_DENIED", "Missing test route.", {
        details: { url: url.toString() },
      });
    }
    if (route instanceof Error) {
      throw route;
    }
    return { ...route, finalUrl: url.toString() };
  }
}

const readers: ReaderService[] = [];

function serviceWith(routes: Map<string, RawPage | Error>) {
  const urlPolicy = new UrlPolicy(async () => publicResolver());
  const http = new RoutingFetcher(routes);
  const browser = new RoutingFetcher(new Map());
  const reader = new ReaderService(
    testConfig(),
    urlPolicy,
    new PageCache(":memory:"),
    http,
    browser,
  );
  readers.push(reader);
  return { service: new SiteService(urlPolicy, reader, http, browser), http, browser };
}

function page(url: string, links: string[], complete = false): RawPage {
  const content = complete
    ? `<p>${"Evidence and context make this page sufficiently complete for reliable extraction. ".repeat(8)}</p>`
    : "";
  const body = `<html><head><title>${url}</title></head><body><main>${content}${links
    .map((link) => `<a href="${link}">${link}</a>`)
    .join("")}</main></body></html>`;
  return rawPage({ body, finalUrl: url, responseBytes: Buffer.byteLength(body) });
}

afterEach(() => {
  while (readers.length > 0) {
    readers.pop()?.close();
  }
});

describe("SiteService", () => {
  it("maps same-host links and deduplicates fragments and query parameters", async () => {
    const root = "https://example.com/";
    const routes = new Map<string, RawPage | Error>([
      [
        root,
        page(root, [
          "/a?utm=one#top",
          "/a?utm=two",
          "/leaf",
          "https://sub.example.com/private",
          "https://outside.example/path",
        ]),
      ],
      ["https://example.com/a", page("https://example.com/a", [])],
      ["https://example.com/leaf", page("https://example.com/leaf", [])],
    ]);
    const { service, http, browser } = serviceWith(routes);

    const result = await service.mapSite({ url: `${root}?campaign=x`, maxPages: 10 });

    expect(result.status).toBe("ok");
    expect(result.urls.map(({ url }) => url)).toEqual([
      root,
      "https://example.com/a",
      "https://example.com/leaf",
    ]);
    expect(result.scannedPages).toBe(3);
    expect(http.calls).toHaveLength(3);
    expect(browser.calls).toHaveLength(0);
  });

  it("reports child failures instead of silently dropping pages", async () => {
    const root = "https://example.com/";
    const routes = new Map<string, RawPage | Error>([
      [root, page(root, ["/ok", "/denied"])],
      ["https://example.com/ok", page("https://example.com/ok", [])],
      ["https://example.com/denied", new ReadError("ACCESS_DENIED", "Denied by test site.")],
    ]);
    const { service } = serviceWith(routes);

    const result = await service.mapSite({ url: root, maxPages: 10 });

    expect(result.status).toBe("partial");
    expect(result.failures).toEqual([
      expect.objectContaining({ url: "https://example.com/denied", code: "ACCESS_DENIED" }),
    ]);
    expect(result.scannedPages).toBe(3);
  });

  it("crawls complete content once per page and preserves discovery evidence", async () => {
    const root = "https://example.com/";
    const child = "https://example.com/guide";
    const routes = new Map<string, RawPage | Error>([
      [root, page(root, ["/guide#intro", "https://outside.example/no"], true)],
      [child, page(child, [], true)],
    ]);
    const { service, http } = serviceWith(routes);

    const result = await service.crawlSite({
      url: root,
      mode: "http",
      cacheMode: "live",
      maxPages: 5,
      maxDepth: 1,
    });

    expect(result.status).toBe("ok");
    expect(result.pages).toHaveLength(2);
    expect(result.pages[1]).toMatchObject({
      url: child,
      depth: 1,
      discoveredFrom: root,
      result: { completeness: "complete", fetchMethod: "http" },
    });
    expect(http.calls).toEqual([root, child]);
  });

  it("enforces crawl limits and reports truncation", async () => {
    const root = "https://example.com/";
    const routes = new Map<string, RawPage | Error>([
      [root, page(root, ["/one", "/two"], true)],
      ["https://example.com/one", page("https://example.com/one", [], true)],
      ["https://example.com/two", page("https://example.com/two", [], true)],
    ]);
    const { service } = serviceWith(routes);

    const result = await service.crawlSite({ url: root, mode: "http", maxPages: 2 });

    expect(result.scannedPages).toBe(2);
    expect(result.pages).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("stops a crawl before fetching when its job signal is cancelled", async () => {
    const root = "https://example.com/";
    const { service, http } = serviceWith(new Map([[root, page(root, [], true)]]));
    const controller = new AbortController();
    controller.abort();

    await expect(
      service.crawlSite({ url: root, mode: "http", signal: controller.signal }),
    ).rejects.toMatchObject({ code: "CRAWL_CANCELLED" });
    expect(http.calls).toEqual([]);
  });
});
