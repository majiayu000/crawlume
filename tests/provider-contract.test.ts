import { afterEach, describe, expect, it } from "vitest";

import { PageCache } from "../src/cache.js";
import { AttemptLedger } from "../src/jobs.js";
import {
  createBuiltinProviderRegistry,
  ProviderRegistry,
  type AccessProvider,
} from "../src/runtime/providers.js";
import { StageExecutor } from "../src/runtime/executor.js";
import { RuntimeResourceGovernor } from "../src/runtime/runtime-resource-governor.js";
import type {
  AccessPlan,
  AccessProviderId,
  ExecutionBudget,
  PlannedStage,
  ReadIntent,
} from "../src/types.js";
import { rawPage, StubFetcher, testConfig } from "./helpers.js";

const caches: PageCache[] = [];
const ledgers: AttemptLedger[] = [];

afterEach(() => {
  while (caches.length > 0) caches.pop()?.close();
  while (ledgers.length > 0) ledgers.pop()?.close();
});

const budget: ExecutionBudget = {
  deadlineMs: 2_000,
  maxAttempts: 2,
  maxDocumentBytes: 1_000_000,
  maxBrowserMs: 1_000,
  maxBrowserContexts: 1,
  maxOptionalModelTokens: 0,
};

function intent(): ReadIntent {
  return {
    url: "https://example.com/feed.xml",
    operation: "read",
    output: { format: "markdown" },
    freshness: { maxAgeSeconds: 900, allowStaleWhileRevalidate: false },
    authorization: { profileId: null, allowedOrigins: ["https://example.com"] },
    completion: { type: "content" },
    budget,
  };
}

function stage(provider: AccessProviderId): PlannedStage {
  return {
    id: `${provider}-read`,
    provider,
    reasonCode: "HTTP_PRIMARY",
    input: {
      url: "https://example.com/feed.xml",
      operation: "read",
      authorizationProfileId: null,
      allowedOrigins: ["https://example.com"],
      completion: { type: "content" },
    },
    runWhen: { type: "always" },
    retryPolicy: { maxAttempts: 1, retryableErrorCodes: [] },
    budgetSlice: budget,
  };
}

function plan(provider: AccessProviderId): AccessPlan {
  return {
    id: `plan_${provider}_${"a".repeat(64 - provider.length - 1)}`,
    plannerVersion: "provider-contract-test-v1",
    stages: [stage(provider)],
    terminalConditions: ["valid-artifact", "policy-stop", "budget-exhausted"],
  };
}

describe("provider registry contract", () => {
  it("uses one registry and immutable StageResult contract for every provider id", async () => {
    const registry = new ProviderRegistry();
    const ids: AccessProviderId[] = ["cache", "http", "browser", "feed", "pdf", "adapter"];
    for (const id of ids) {
      const provider: AccessProvider = {
        capabilities: () => ({
          id,
          version: `${id}-test-v1`,
          output: "raw",
          credentialHandling: id === "browser" ? "profile" : "none",
          mediaTypes: ["text/plain"],
        }),
        execute: async (request) => Object.freeze({
          stageId: request.stage.id,
          providerVersion: `${id}-test-v1`,
          outcome: "succeeded" as const,
          rawRef: `raw:${id}`,
          traceRef: null,
          candidateArtifactRef: null,
          candidate: { kind: "raw" as const, page: rawPage() },
          error: null,
          usage: {
            documentBytesIn: 1,
            networkBytesOut: 0,
            browserMilliseconds: 0,
            browserContextStarts: 0,
            retryDelayMilliseconds: 0,
            optionalModelTokens: 0,
          },
          startedAt: "2026-08-30T00:00:00.000Z",
          completedAt: "2026-08-30T00:00:00.001Z",
        }),
      };
      registry.register(provider);
    }

    for (const id of ids) {
      const result = await registry.execute({
        stage: stage(id),
        url: new URL("https://example.com/feed.xml"),
        cacheKey: "cache-key",
        maxAgeSeconds: 900,
        authProfile: null,
        intent: intent(),
        maxResponseBytes: 1_000_000,
        timeoutMs: 2_000,
      }, new AbortController().signal);
      expect(result).toMatchObject({
        stageId: `${id}-read`,
        providerVersion: `${id}-test-v1`,
        outcome: "succeeded",
      });
      expect(Object.isFrozen(result)).toBe(true);
    }
  });

  it("declares built-in availability and fails unknown or unavailable providers explicitly", () => {
    const cache = new PageCache(":memory:");
    caches.push(cache);
    const registry = createBuiltinProviderRegistry(
      cache,
      new StubFetcher(rawPage()),
      new StubFetcher(rawPage({ method: "browser" })),
    );

    expect(registry.list().map(({ id, availability }) => ({ id, availability }))).toEqual([
      { id: "cache", availability: "available" },
      { id: "http", availability: "available" },
      { id: "browser", availability: "available" },
      { id: "feed", availability: "available" },
      { id: "pdf", availability: "available" },
      { id: "adapter", availability: "unavailable" },
    ]);
    expect(() => registry.resolve("adapter")).toThrow(expect.objectContaining({
      code: "PROVIDER_UNAVAILABLE",
    }));
    expect(() => registry.resolve("unknown" as AccessProviderId)).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
  });

  it("executes a feed stage through its provider identity without misrouting to browser", async () => {
    const description = "Feed evidence with concrete context and source details. ".repeat(12);
    const body = `<?xml version="1.0"?><rss version="2.0"><channel><title>Research feed</title><item><title>Entry</title><link>https://example.com/entry</link><description>${description}</description></item></channel></rss>`;
    const cache = new PageCache(":memory:");
    const ledger = new AttemptLedger(":memory:");
    caches.push(cache);
    ledgers.push(ledger);
    const http = new StubFetcher(rawPage({
      body,
      contentType: "application/rss+xml",
      responseBytes: Buffer.byteLength(body),
    }));
    const browser = new StubFetcher(new Error("browser must not run"));
    const accessPlan = plan("feed");

    const result = await new StageExecutor(
      createBuiltinProviderRegistry(cache, http, browser),
      null,
      ledger,
    ).execute({
      url: new URL("https://example.com/feed.xml"),
      cacheKey: "feed-cache-key",
      maxAgeSeconds: 900,
      authProfile: null,
      requestId: "provider-feed-request",
      intent: intent(),
      plan: accessPlan,
      budget,
    });

    expect(result.artifact.title).toBe("Research feed");
    expect(http.calls).toBe(1);
    expect(browser.calls).toBe(0);
    expect(ledger.list("provider-feed-request")).toMatchObject([
      { provider: "feed", outcome: "succeeded", errorCode: null },
    ]);
  });

  it("does not route an unavailable adapter stage to browser", async () => {
    const cache = new PageCache(":memory:");
    caches.push(cache);
    const http = new StubFetcher(new Error("HTTP must not run"));
    const browser = new StubFetcher(new Error("browser must not run"));

    await expect(new StageExecutor(
      createBuiltinProviderRegistry(cache, http, browser),
      null,
      null,
    ).execute({
      url: new URL("https://example.com/feed.xml"),
      cacheKey: "adapter-cache-key",
      maxAgeSeconds: 900,
      authProfile: null,
      requestId: "provider-adapter-request",
      intent: intent(),
      plan: plan("adapter"),
      budget,
    })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(http.calls).toBe(0);
    expect(browser.calls).toBe(0);
  });

  it("applies the shared runtime governor on the built-in provider path", async () => {
    const cache = new PageCache(":memory:");
    caches.push(cache);
    let calls = 0;
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const http = {
      async fetch() {
        calls += 1;
        if (calls === 1) await firstGate;
        return rawPage();
      },
    };
    const resources = new RuntimeResourceGovernor({
      ...testConfig(),
      crawlWorkerConcurrency: 1,
    });
    const registry = createBuiltinProviderRegistry(
      cache,
      http,
      new StubFetcher(rawPage({ method: "browser" })),
      resources,
    );
    const execute = async (url: string, cacheKey: string) => registry.execute({
      stage: stage("http"),
      url: new URL(url),
      cacheKey,
      maxAgeSeconds: 900,
      authProfile: null,
      intent: intent(),
      maxResponseBytes: 1_000_000,
      timeoutMs: 2_000,
    }, new AbortController().signal);

    const first = execute("https://one.example/page", "first");
    const second = execute("https://two.example/page", "second");
    await Promise.resolve();
    expect(calls).toBe(1);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(calls).toBe(2);
  });
});
