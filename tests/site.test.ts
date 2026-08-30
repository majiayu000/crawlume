import { afterEach, describe, expect, it } from "vitest";

import { PageCache } from "../src/cache.js";
import { CrawlRequestPolicy } from "../src/crawl-policy.js";
import { ReadError } from "../src/errors.js";
import { AttemptLedger } from "../src/jobs.js";
import { ReaderService } from "../src/reader.js";
import { UrlPolicy } from "../src/security/url-policy.js";
import { SiteService } from "../src/site.js";
import type {
  AttemptInput,
  AttemptRecord,
  PageFetchOptions,
  PageFetcher,
  RawPage,
} from "../src/types.js";
import { publicResolver, rawPage, testConfig } from "./helpers.js";

type Route = RawPage | Error | Array<RawPage | Error>;

class RoutingFetcher implements PageFetcher {
  readonly calls: string[] = [];
  readonly options: PageFetchOptions[] = [];

  constructor(private readonly routes: Map<string, Route>) {}

  async fetch(url: URL, options: PageFetchOptions = {}): Promise<RawPage> {
    this.calls.push(url.toString());
    this.options.push(options);
    const configured = this.routes.get(url.toString());
    const route = Array.isArray(configured) ? configured.shift() : configured;
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

class RecordingAttemptLedger extends AttemptLedger {
  readonly requestIds: string[] = [];

  override append(input: AttemptInput): AttemptRecord {
    if (!this.requestIds.includes(input.requestId)) this.requestIds.push(input.requestId);
    return super.append(input);
  }
}

function ledgerRequestId(ledger: RecordingAttemptLedger, provider: "http" | "browser"): string {
  const requestId = ledger.requestIds.find((value) =>
    ledger.list(value).some((attempt) => attempt.provider === provider)
  );
  if (requestId === undefined) throw new Error(`no ${provider} attempt was recorded`);
  return requestId;
}

const readers: ReaderService[] = [];
const ledgers: AttemptLedger[] = [];

function serviceWith(
  routes: Map<string, Route>,
  browserRoutes: Map<string, Route> = new Map(),
  options: { retries?: boolean } = {},
) {
  const urlPolicy = new UrlPolicy(async () => publicResolver());
  const http = new RoutingFetcher(routes);
  const browser = new RoutingFetcher(browserRoutes);
  const ledger = new RecordingAttemptLedger(":memory:");
  const reader = new ReaderService(
    testConfig(),
    urlPolicy,
    new PageCache(":memory:"),
    http,
    browser,
    null,
    options.retries === true ? new CrawlRequestPolicy(testConfig()) : null,
    null,
    null,
    () => "",
    ledger,
  );
  readers.push(reader);
  ledgers.push(ledger);
  return { service: new SiteService(urlPolicy, reader), reader, http, browser, ledger };
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
  while (ledgers.length > 0) {
    ledgers.pop()?.close();
  }
});

describe("SiteService", () => {
  it("preserves explicit browser readiness intent for every crawled page", async () => {
    const root = "https://example.com/";
    const readiness = { target: { selector: "[data-terminal='true']" } };
    const browserPage = page(root, [], true);
    const { service, http, browser } = serviceWith(
      new Map(),
      new Map([[root, { ...browserPage, method: "browser" }]]),
    );

    await service.crawlSite({
      url: root,
      cacheMode: "live",
      maxPages: 1,
      browserReadiness: readiness,
    });

    expect(http.calls).toEqual([]);
    expect(browser.options).toEqual([expect.objectContaining({
      browserReadiness: expect.objectContaining({
        target: expect.objectContaining({ selector: readiness.target.selector }),
      }),
    })]);
  });

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
    const { service, http, browser, ledger } = serviceWith(routes);

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
    expect(ledger.list(ledgerRequestId(ledger, "http")).map(({ provider, outcome }) => ({
      provider, outcome,
    }))).toEqual([{ provider: "http", outcome: "succeeded" }]);
  });

  it("maps a JavaScript shell through the same planned HTTP-to-browser execution chain", async () => {
    const root = "https://example.com/";
    const child = "https://example.com/child";
    const shellBody = "<html><body>Loading...</body></html>";
    const browserRoot = page(root, ["/child"], true);
    const { service, ledger } = serviceWith(
      new Map([
        [root, rawPage({ body: shellBody, responseBytes: Buffer.byteLength(shellBody) })],
        [child, page(child, [], true)],
      ]),
      new Map([[root, { ...browserRoot, method: "browser" }]]),
    );

    const result = await service.mapSite({ url: root, maxPages: 2, maxDepth: 1 });
    const rootRequestId = ledgerRequestId(ledger, "browser");

    expect(result.urls.map(({ url }) => url)).toEqual([root, child]);
    expect(ledger.list(rootRequestId).map(({ provider, outcome, errorCode }) => ({
      provider, outcome, errorCode,
    }))).toEqual([
      { provider: "http", outcome: "succeeded", errorCode: null },
      { provider: "browser", outcome: "succeeded", errorCode: null },
    ]);
  });

  it("retries only the failed browser stage after HTTP identifies a JavaScript shell", async () => {
    const root = "https://example.com/";
    const shellBody = "<html><body>Loading...</body></html>";
    const { service, http, browser } = serviceWith(
      new Map([[root, rawPage({ body: shellBody, responseBytes: Buffer.byteLength(shellBody) })]]),
      new Map([[root, [
        new ReadError("UPSTREAM_ERROR", "temporary browser failure", { retryable: true }),
        { ...page(root, [], true), method: "browser" },
      ]]]),
      { retries: true },
    );

    const result = await service.mapSite({
      url: root,
      maxPages: 1,
      budget: {
        deadlineMs: 1_000,
        maxAttempts: 3,
        maxDocumentBytes: 100_000,
        maxBrowserMs: 1_000,
        maxBrowserContexts: 2,
        maxOptionalModelTokens: 0,
      },
    });

    expect(result.status).toBe("ok");
    expect(http.calls).toEqual([root]);
    expect(browser.calls).toEqual([root, root]);
  });

  it("fails explicitly on a JavaScript shell when browser access is disabled", async () => {
    const root = "https://example.com/";
    const shellBody = "<html><body>Loading...</body></html>";
    const { service, browser } = serviceWith(new Map([[root, rawPage({
      body: shellBody,
      responseBytes: Buffer.byteLength(shellBody),
    })]]));

    await expect(service.mapSite({
      url: root,
      maxPages: 1,
      browserAllowed: false,
    })).rejects.toMatchObject({ code: "SHELL_ONLY" });
    expect(browser.calls).toEqual([]);
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
      browserAllowed: false,
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

  it("applies the caller budget independently to every crawled page", async () => {
    const root = "https://example.com/";
    const child = "https://example.com/oversized";
    const rootPage = page(root, [child], true);
    const childPage = page(child, [], true);
    const { service, ledger } = serviceWith(new Map([
      [root, { ...rootPage, responseBytes: 900 }],
      [child, { ...childPage, responseBytes: 2_000 }],
    ]));

    const result = await service.crawlSite({
      url: root,
      browserAllowed: false,
      cacheMode: "live",
      maxPages: 2,
      maxDepth: 1,
      budget: {
        deadlineMs: 1_000,
        maxAttempts: 1,
        maxDocumentBytes: 1_000,
        maxBrowserMs: 0,
        maxBrowserContexts: 0,
        maxOptionalModelTokens: 0,
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      pages: [expect.objectContaining({ url: root })],
      failures: [expect.objectContaining({
        url: child,
        code: "BUDGET_EXHAUSTED",
        details: expect.objectContaining({ budgetDimension: "maxDocumentBytes" }),
      })],
    });
    expect(ledger.requestIds).toHaveLength(2);
    expect(new Set(ledger.requestIds).size).toBe(2);
  });

  it("applies the caller budget to each mapped page", async () => {
    const root = "https://example.com/";
    const oversized = page(root, [], true);
    const { service } = serviceWith(new Map([[root, { ...oversized, responseBytes: 2_000 }]]));

    await expect(service.mapSite({
      url: root,
      browserAllowed: false,
      maxPages: 1,
      budget: {
        deadlineMs: 1_000,
        maxAttempts: 1,
        maxDocumentBytes: 1_000,
        maxBrowserMs: 0,
        maxBrowserContexts: 0,
        maxOptionalModelTokens: 0,
      },
    })).rejects.toMatchObject({
      code: "BUDGET_EXHAUSTED",
      details: { budgetDimension: "maxDocumentBytes" },
    });
  });

  it("shares cached content between single-page reads and crawls", async () => {
    const root = "https://example.com/";
    const rootPage = {
      ...page(root, ["/guide"], true),
      fetchedAt: new Date().toISOString(),
    };
    const { service, reader, http } = serviceWith(new Map([[root, rootPage]]));

    await reader.readPage({ url: root, browserAllowed: false, cacheMode: "live" });
    const result = await service.crawlSite({
      url: root,
      browserAllowed: false,
      cacheMode: "prefer-cache",
      maxPages: 1,
    });

    expect(result.pages).toHaveLength(1);
    expect(http.calls).toEqual([root]);
  });

  it("enforces crawl limits and reports truncation", async () => {
    const root = "https://example.com/";
    const routes = new Map<string, RawPage | Error>([
      [root, page(root, ["/one", "/two"], true)],
      ["https://example.com/one", page("https://example.com/one", [], true)],
      ["https://example.com/two", page("https://example.com/two", [], true)],
    ]);
    const { service } = serviceWith(routes);

    const result = await service.crawlSite({ url: root, browserAllowed: false, maxPages: 2 });

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
      service.crawlSite({ url: root, browserAllowed: false, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "CRAWL_CANCELLED" });
    expect(http.calls).toEqual([]);
  });
});
