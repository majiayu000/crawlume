import { afterEach, describe, expect, it } from "vitest";

import { PageCache } from "../src/cache.js";
import type { AppConfig } from "../src/config.js";
import { CrawlRequestPolicy } from "../src/crawl-policy.js";
import { ReadError } from "../src/errors.js";
import { AttemptLedger } from "../src/jobs.js";
import { ReaderService } from "../src/reader.js";
import { UrlPolicy } from "../src/security/url-policy.js";
import type { ExecutionBudget, PageFetcher, RawPage } from "../src/types.js";
import { publicResolver, rawPage, testConfig } from "./helpers.js";

const readers: ReaderService[] = [];
const ledgers: AttemptLedger[] = [];

const budget: ExecutionBudget = {
  deadlineMs: 10_000,
  maxAttempts: 3,
  maxDocumentBytes: 3_000_000,
  maxBrowserMs: 5_000,
  maxBrowserContexts: 1,
  maxOptionalModelTokens: 0,
};

function sequenceFetcher(sequence: Array<RawPage | Error>): PageFetcher & { calls: number } {
  return {
    calls: 0,
    async fetch() {
      this.calls += 1;
      const next = sequence.shift();
      if (next === undefined) throw new Error("fetch sequence exhausted");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function delayedFetcher(
  delayMs: number,
  page: RawPage,
): PageFetcher & { calls: number } {
  return {
    calls: 0,
    async fetch(_url, options) {
      this.calls += 1;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        options?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new ReadError("CRAWL_CANCELLED", "cancelled"));
        }, { once: true });
      });
      return page;
    },
  };
}

function runtimeReader(
  http: PageFetcher,
  browser: PageFetcher,
  ledger: AttemptLedger,
  configOverrides: Partial<AppConfig> = {},
): ReaderService {
  const config = { ...testConfig(), ...configOverrides };
  const reader = new ReaderService(
    config,
    new UrlPolicy(async () => publicResolver()),
    new PageCache(":memory:"),
    http,
    browser,
    null,
    new CrawlRequestPolicy(config),
    null,
    null,
    () => "",
    ledger,
  );
  readers.push(reader);
  ledgers.push(ledger);
  return reader;
}

afterEach(() => {
  while (readers.length > 0) readers.pop()?.close();
  while (ledgers.length > 0) ledgers.pop()?.close();
});

describe("planned reader runtime", () => {
  it("executes the planned HTTP stage once for a complete static artifact", async () => {
    const http = sequenceFetcher([rawPage()]);
    const browser = sequenceFetcher([new Error("browser must not run")]);
    const ledger = new AttemptLedger(":memory:");

    const result = await runtimeReader(http, browser, ledger).readPage({
      url: "https://example.com/article",
      cacheMode: "live",
      browserAllowed: true,
      budget,
    });

    expect(result.evidence.accessPlan).toMatchObject({
      planId: expect.stringMatching(/^plan_[a-f0-9]{64}$/u),
      plannerVersion: "access-planner-v1",
      executedStages: ["http-read"],
    });
    expect(ledger.list(result.evidence.requestId).map(({ provider, outcome }) => ({
      provider, outcome,
    }))).toEqual([{ provider: "http", outcome: "succeeded" }]);
    expect(http.calls).toBe(1);
    expect(browser.calls).toBe(0);
  });

  it("keeps validator-invalid terminal state distinct from provider failure", async () => {
    const shell = "<html><body>Loading...</body></html>";
    const http = sequenceFetcher([rawPage({
      body: shell,
      responseBytes: Buffer.byteLength(shell),
    })]);
    const ledger = new AttemptLedger(":memory:");

    await expect(runtimeReader(
      http,
      sequenceFetcher([new Error("browser must not run")]),
      ledger,
    ).readPage({
      url: "https://example.com/shell",
      requestId: "request-invalid",
      cacheMode: "live",
      browserAllowed: false,
      budget: { ...budget, maxBrowserMs: 0, maxBrowserContexts: 0 },
    })).rejects.toMatchObject({ code: "SHELL_ONLY" });

    expect(ledger.project("request-invalid")?.terminal?.state).toBe("invalid");
  });

  it("escalates an HTTP shell to browser without repeating the completed HTTP attempt", async () => {
    const shell = "<html><body>Loading...</body></html>";
    const http = sequenceFetcher([rawPage({ body: shell, responseBytes: Buffer.byteLength(shell) })]);
    const browser = sequenceFetcher([rawPage({ method: "browser" })]);
    const ledger = new AttemptLedger(":memory:");

    const result = await runtimeReader(http, browser, ledger).readPage({
      url: "https://example.com/article",
      cacheMode: "live",
      browserAllowed: true,
      budget,
    });

    expect(result.fetchMethod).toBe("browser");
    expect(result.evidence.accessPlan.executedStages).toEqual(["http-read", "browser-read"]);
    expect(ledger.list(result.evidence.requestId).map(({ provider, outcome, errorCode }) => ({
      provider, outcome, errorCode,
    }))).toEqual([
      { provider: "http", outcome: "succeeded", errorCode: null },
      { provider: "browser", outcome: "succeeded", errorCode: null },
    ]);
    expect(http.calls).toBe(1);
    expect(browser.calls).toBe(1);
  });

  it("returns an uncertain candidate without claiming complete content", async () => {
    const body = "Useful but brief evidence. ".repeat(13);
    const http = sequenceFetcher([rawPage({
      body,
      contentType: "text/plain",
      responseBytes: Buffer.byteLength(body),
    })]);
    const browser = sequenceFetcher([new Error("uncertain content must not trigger hidden fallback")]);
    const ledger = new AttemptLedger(":memory:");

    const result = await runtimeReader(http, browser, ledger).readPage({
      url: "https://example.com/brief",
      cacheMode: "live",
      browserAllowed: true,
      budget,
    });

    expect(result.completeness).toBe("uncertain");
    expect(result.validation).toMatchObject({
      outcome: "uncertain",
      validatorVersion: "generic-content-v1",
    });
    expect(result.evidence.accessPlan.executedStages).toEqual(["http-read"]);
    expect(browser.calls).toBe(0);
  });

  it("validates multiple extractors from one HTTP fetch", async () => {
    const body = `<html><head><title>Multi candidate</title><script type="application/ld+json">${JSON.stringify({
      "@type": "Article",
      headline: "Structured candidate",
      articleBody: "Structured evidence ".repeat(40),
    })}</script></head><body><article>${"Visible evidence ".repeat(40)}</article></body></html>`;
    const http = sequenceFetcher([rawPage({ body, responseBytes: Buffer.byteLength(body) })]);
    const browser = sequenceFetcher([new Error("browser must not run")]);
    const ledger = new AttemptLedger(":memory:");

    const result = await runtimeReader(http, browser, ledger).readPage({
      url: "https://example.com/multi",
      cacheMode: "live",
      browserAllowed: false,
      budget: { ...budget, maxBrowserMs: 0, maxBrowserContexts: 0 },
    });

    expect(result.evidence.extractionMethod).toBe("json-ld");
    expect(http.calls).toBe(1);
  });

  it("never starts browser after an access denial", async () => {
    const http = sequenceFetcher([new ReadError("ACCESS_DENIED", "denied")]);
    const browser = sequenceFetcher([new Error("browser must not run")]);
    const ledger = new AttemptLedger(":memory:");

    await expect(runtimeReader(http, browser, ledger).readPage({
      url: "https://example.com/private",
      requestId: "request-denied",
      cacheMode: "live",
      browserAllowed: true,
      budget,
    })).rejects.toMatchObject({ code: "ACCESS_DENIED" });

    expect(ledger.list("request-denied").map(({ provider, outcome, errorCode }) => ({
      provider, outcome, errorCode,
    }))).toEqual([
      { provider: "http", outcome: "failed", errorCode: "ACCESS_DENIED" },
    ]);
    expect(http.calls).toBe(1);
    expect(browser.calls).toBe(0);
    expect(ledger.project("request-denied")?.terminal?.state).toBe("policy_stop");
  });

  it("retries only the HTTP stage when browser is forbidden", async () => {
    const http = sequenceFetcher([
      new ReadError("UPSTREAM_ERROR", "temporary", { retryable: true }),
      rawPage(),
    ]);
    const browser = sequenceFetcher([new Error("browser must not run")]);
    const ledger = new AttemptLedger(":memory:");

    const result = await runtimeReader(http, browser, ledger, {
      crawlRetryBaseMs: 25,
    }).readPage({
      url: "https://example.com/article",
      cacheMode: "live",
      browserAllowed: false,
      budget: { ...budget, maxBrowserMs: 0, maxBrowserContexts: 0, maxAttempts: 2 },
    });

    expect(result.evidence.fetchAttempts).toEqual({ http: 2, browser: 0 });
    expect(result.evidence.totalRetryDelayMs).toBe(25);
    expect(ledger.list(result.evidence.requestId).map(({ provider, outcome }) => ({
      provider, outcome,
    }))).toEqual([
      { provider: "http", outcome: "failed" },
      { provider: "http", outcome: "succeeded" },
    ]);
    expect(ledger.project(result.evidence.requestId)?.usage.retryDelayMilliseconds).toBe(25);
  });

  it("stops with BUDGET_EXHAUSTED when the response crosses the network-byte budget", async () => {
    const http = sequenceFetcher([rawPage({ responseBytes: 2_000 })]);
    const browser = sequenceFetcher([rawPage({ method: "browser" })]);
    const ledger = new AttemptLedger(":memory:");

    await expect(runtimeReader(http, browser, ledger).readPage({
      url: "https://example.com/large",
      requestId: "request-byte-budget",
      cacheMode: "live",
      browserAllowed: true,
      budget: { ...budget, maxDocumentBytes: 1_000 },
    })).rejects.toMatchObject({
      code: "BUDGET_EXHAUSTED",
      details: { budgetDimension: "maxDocumentBytes", budgetLimit: 1_000 },
    });

    expect(http.calls).toBe(1);
    expect(browser.calls).toBe(0);
    expect(ledger.list("request-byte-budget")).toEqual([
      expect.objectContaining({
        provider: "http",
        outcome: "stopped",
        errorCode: "BUDGET_EXHAUSTED",
        usage: expect.objectContaining({ documentBytesIn: 2_000 }),
      }),
    ]);
  });

  it("enforces one global deadline and does not fall through to browser", async () => {
    const http = delayedFetcher(100, rawPage());
    const browser = sequenceFetcher([rawPage({ method: "browser" })]);
    const ledger = new AttemptLedger(":memory:");

    await expect(runtimeReader(http, browser, ledger).readPage({
      url: "https://example.com/slow",
      requestId: "request-deadline-budget",
      cacheMode: "live",
      browserAllowed: true,
      budget: { ...budget, deadlineMs: 10 },
    })).rejects.toMatchObject({
      code: "BUDGET_EXHAUSTED",
      details: { budgetDimension: "deadlineMs", budgetLimit: 10 },
      execution: {
        requestId: "request-deadline-budget",
        plannerVersion: "access-planner-v1",
        executedStages: ["http-read"],
      },
    });

    expect(http.calls).toBe(1);
    expect(browser.calls).toBe(0);
    expect(ledger.list("request-deadline-budget")).toEqual([
      expect.objectContaining({ provider: "http", outcome: "stopped", errorCode: "BUDGET_EXHAUSTED" }),
    ]);
  });

  it("does not start a second browser context after the context budget is spent", async () => {
    const http = sequenceFetcher([new Error("http must not run")]);
    const browser = sequenceFetcher([
      new ReadError("UPSTREAM_ERROR", "temporary", { retryable: true }),
      rawPage({ method: "browser" }),
    ]);
    const ledger = new AttemptLedger(":memory:");

    await expect(runtimeReader(http, browser, ledger, { crawlRetryBaseMs: 0 }).readPage({
      url: "https://example.com/app",
      requestId: "request-context-budget",
      cacheMode: "live",
      browserAllowed: true,
      browserReadiness: { target: { selector: "main" } },
      budget: { ...budget, maxAttempts: 2, maxBrowserContexts: 1 },
    })).rejects.toMatchObject({
      code: "BUDGET_EXHAUSTED",
      details: { budgetDimension: "maxBrowserContexts", budgetLimit: 1 },
    });

    expect(http.calls).toBe(0);
    expect(browser.calls).toBe(1);
    expect(ledger.list("request-context-budget").map(({ outcome, errorCode }) => ({
      outcome, errorCode,
    }))).toEqual([
      { outcome: "failed", errorCode: "UPSTREAM_ERROR" },
      { outcome: "stopped", errorCode: "BUDGET_EXHAUSTED" },
    ]);
  });

  it("charges browser wall time and rejects an artifact produced over budget", async () => {
    const http = sequenceFetcher([new Error("http must not run")]);
    const browser = delayedFetcher(20, rawPage({ method: "browser" }));
    const ledger = new AttemptLedger(":memory:");

    await expect(runtimeReader(http, browser, ledger).readPage({
      url: "https://example.com/rendered",
      requestId: "request-browser-time-budget",
      cacheMode: "live",
      browserAllowed: true,
      browserReadiness: { target: { selector: "main" } },
      budget: { ...budget, maxBrowserMs: 1 },
    })).rejects.toMatchObject({
      code: "BUDGET_EXHAUSTED",
      details: { budgetDimension: "maxBrowserMs", budgetLimit: 1 },
    });

    expect(browser.calls).toBe(1);
    expect(ledger.list("request-browser-time-budget")).toEqual([
      expect.objectContaining({
        provider: "browser",
        outcome: "stopped",
        errorCode: "BUDGET_EXHAUSTED",
        usage: expect.objectContaining({ browserContextStarts: 1 }),
      }),
    ]);
  });

  it("persists a browser failure trace reference on the matching attempt", async () => {
    const traceRef = "browser-trace:00000000-0000-4000-8000-000000000000";
    const browser = sequenceFetcher([
      new ReadError("FETCH_TIMEOUT", "timed out", { traceRef }),
    ]);
    const ledger = new AttemptLedger(":memory:");

    await expect(runtimeReader(
      sequenceFetcher([new Error("http must not run")]),
      browser,
      ledger,
    ).readPage({
      url: "https://example.com/app",
      requestId: "request-browser-trace",
      cacheMode: "live",
      browserAllowed: true,
      browserReadiness: { target: { selector: "main" } },
      budget: { ...budget, maxAttempts: 1 },
    })).rejects.toMatchObject({ code: "FETCH_TIMEOUT", traceRef });

    expect(ledger.list("request-browser-trace")).toEqual([
      expect.objectContaining({ provider: "browser", traceRef }),
    ]);
  });

  it("retries a disconnected browser stage and preserves the failed attempt trace", async () => {
    const traceRef = "browser-trace:00000000-0000-4000-8000-000000000001";
    const browser = sequenceFetcher([
      new ReadError("BROWSER_UNAVAILABLE", "disconnected", { retryable: true, traceRef }),
      rawPage({ method: "browser" }),
    ]);
    const ledger = new AttemptLedger(":memory:");

    const result = await runtimeReader(
      sequenceFetcher([new Error("http must not run")]),
      browser,
      ledger,
      { crawlRetryBaseMs: 0 },
    ).readPage({
      url: "https://example.com/app",
      requestId: "request-browser-recovery",
      cacheMode: "live",
      browserAllowed: true,
      browserReadiness: { target: { selector: "main" } },
      budget: { ...budget, maxAttempts: 2, maxBrowserContexts: 2 },
    });

    expect(result.fetchMethod).toBe("browser");
    expect(browser.calls).toBe(2);
    expect(ledger.list("request-browser-recovery")).toEqual([
      expect.objectContaining({ outcome: "failed", traceRef }),
      expect.objectContaining({ outcome: "succeeded", traceRef: null }),
    ]);
  });
});
