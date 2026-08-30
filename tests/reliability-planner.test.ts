import { describe, expect, it } from "vitest";

import { planAccess } from "../src/reliability/planner.js";
import type { PlanningFacts, ReadIntent } from "../src/types.js";

function intent(overrides: Partial<ReadIntent> = {}): ReadIntent {
  return {
    url: "https://example.com/article",
    operation: "read",
    output: { format: "markdown" },
    freshness: { maxAgeSeconds: 900, allowStaleWhileRevalidate: false },
    authorization: { profileId: null, allowedOrigins: ["https://example.com"] },
    completion: { type: "content" },
    budget: {
      deadlineMs: 30_000,
      maxAttempts: 3,
      maxDocumentBytes: 5_000_000,
      maxBrowserMs: 10_000,
      maxBrowserContexts: 1,
      maxOptionalModelTokens: 0,
    },
    ...overrides,
  };
}

function facts(overrides: Partial<PlanningFacts> = {}): PlanningFacts {
  return {
    cachePolicy: "prefer-cache",
    providers: { cache: true, http: true, browser: true },
    ...overrides,
  };
}

describe("deterministic access planner", () => {
  it("plans cache, HTTP, then browser only after an incomplete HTTP result", () => {
    const plan = planAccess(intent(), facts());

    expect(plan.id).toMatch(/^plan_[a-f0-9]{64}$/u);
    expect(plan.plannerVersion).toBe("access-planner-v1");
    expect(plan.stages.map(({ id, provider, reasonCode, runWhen }) => ({
      id, provider, reasonCode, runWhen,
    }))).toEqual([
      {
        id: "cache-read",
        provider: "cache",
        reasonCode: "CACHE_PREFERRED",
        runWhen: { type: "always" },
      },
      {
        id: "http-read",
        provider: "http",
        reasonCode: "HTTP_PRIMARY",
        runWhen: {
          type: "after-failure",
          stageId: "cache-read",
          errorCodes: ["CACHE_MISS"],
        },
      },
      {
        id: "browser-read",
        provider: "browser",
        reasonCode: "BROWSER_AFTER_INCOMPLETE_HTTP",
        runWhen: { type: "after-invalid", stageId: "http-read" },
      },
    ]);
    expect(plan.stages[2]?.input).toEqual({
      url: "https://example.com/article",
      operation: "read",
      authorizationProfileId: null,
      allowedOrigins: ["https://example.com"],
      completion: { type: "content" },
    });
  });

  it("produces the same content-addressed id for semantically equivalent inputs", () => {
    const first = planAccess(intent({
      authorization: {
        profileId: null,
        allowedOrigins: ["https://www.example.com", "https://example.com"],
      },
    }), facts());
    const second = planAccess(intent({
      authorization: {
        profileId: null,
        allowedOrigins: ["https://example.com", "https://www.example.com"],
      },
    }), facts());

    expect(first.id).toBe(second.id);
    expect(first).toEqual(second);
  });

  it("routes explicit DOM completion directly to browser with traceable readiness input", () => {
    const completion = {
      type: "dom" as const,
      readiness: {
        target: { selector: "[data-terminal='true']", state: "visible" as const, minCount: 2 },
        interaction: { type: "scroll-to-end" as const, maxSteps: 4, stepDelayMs: 50 },
        timeoutMs: 8_000,
      },
    };
    const plan = planAccess(intent({ completion }), facts({ cachePolicy: "live" }));

    expect(plan.stages).toHaveLength(1);
    expect(plan.stages[0]).toMatchObject({
      id: "browser-read",
      provider: "browser",
      reasonCode: "BROWSER_REQUIRED_BY_COMPLETION",
      runWhen: { type: "always" },
      input: { completion },
    });
  });

  it("preserves discovery completion as a first-class map intent", () => {
    const plan = planAccess(intent({
      operation: "map",
      completion: { type: "discovery" } as never,
    }), facts({ cachePolicy: "live" }));

    expect(plan.stages[0]).toMatchObject({
      provider: "http",
      input: {
        operation: "map",
        completion: { type: "discovery" },
      },
    });
  });

  it("routes an authorized read directly to browser", () => {
    const plan = planAccess(intent({
      authorization: {
        profileId: "research-profile",
        allowedOrigins: ["https://example.com"],
      },
    }), facts({ cachePolicy: "live" }));

    expect(plan.stages.map(({ provider, reasonCode }) => ({ provider, reasonCode }))).toEqual([
      { provider: "browser", reasonCode: "BROWSER_REQUIRED_BY_AUTHORIZATION" },
    ]);
    expect(plan.stages[0]?.input).toMatchObject({
      authorizationProfileId: "research-profile",
      allowedOrigins: ["https://example.com"],
    });
  });

  it.each([
    facts({ providers: { cache: true, http: true, browser: false } }),
    facts(),
  ])("does not plan browser when browser capability is unavailable or budgeted to zero", (inputFacts) => {
    const inputIntent = inputFacts.providers.browser
      ? intent({ budget: { ...intent().budget, maxBrowserMs: 0, maxBrowserContexts: 0 } })
      : intent();
    const plan = planAccess(inputIntent, inputFacts);

    expect(plan.stages.map(({ provider }) => provider)).toEqual(["cache", "http"]);
  });

  it("uses only cache for cache-only requests", () => {
    const plan = planAccess(intent(), facts({ cachePolicy: "cache-only" }));

    expect(plan.stages.map(({ provider }) => provider)).toEqual(["cache"]);
    expect(plan.stages[0]?.reasonCode).toBe("CACHE_ONLY");
  });

  it("bounds each conditional stage while leaving the executor to enforce the shared attempt budget", () => {
    const inputIntent = intent({ budget: { ...intent().budget, maxAttempts: 2 } });
    const plan = planAccess(inputIntent, facts());
    const http = plan.stages.find(({ provider }) => provider === "http");
    const browser = plan.stages.find(({ provider }) => provider === "browser");

    expect(plan.stages.map(({ provider }) => provider)).toEqual(["cache", "http", "browser"]);
    expect(http?.retryPolicy.maxAttempts).toBe(2);
    expect(browser?.retryPolicy.maxAttempts).toBe(1);
  });

  it("allocates all attempts to HTTP when browser fallback is unavailable", () => {
    const plan = planAccess(
      intent({ budget: { ...intent().budget, maxAttempts: 2 } }),
      facts({ providers: { cache: true, http: true, browser: false } }),
    );

    expect(plan.stages.map(({ provider, retryPolicy }) => ({
      provider,
      maxAttempts: retryPolicy.maxAttempts,
    }))).toEqual([
      { provider: "cache", maxAttempts: 1 },
      { provider: "http", maxAttempts: 2 },
    ]);
  });

  it("lets a browser fallback use attempts left by an early HTTP shell", () => {
    const plan = planAccess(intent(), facts());
    const http = plan.stages.find(({ provider }) => provider === "http");
    const browser = plan.stages.find(({ provider }) => provider === "browser");

    expect(http?.retryPolicy.maxAttempts).toBe(3);
    expect(browser?.retryPolicy.maxAttempts).toBe(2);
    expect(browser?.retryPolicy.retryableErrorCodes).toContain("BROWSER_UNAVAILABLE");
  });

  it("allocates the full network attempt budget to a required browser primary", () => {
    const plan = planAccess(intent({
      authorization: {
        profileId: "research-profile",
        allowedOrigins: ["https://example.com"],
      },
    }), facts({ cachePolicy: "live" }));

    expect(plan.stages[0]?.retryPolicy.maxAttempts).toBe(3);
  });

  it.each([
    {
      name: "explicit DOM completion without browser availability",
      inputIntent: intent({
        completion: { type: "dom", readiness: { target: { selector: "main" } } },
      }),
      inputFacts: facts({ providers: { cache: true, http: true, browser: false } }),
    },
    {
      name: "authorized read without browser budget",
      inputIntent: intent({
        authorization: {
          profileId: "research-profile",
          allowedOrigins: ["https://example.com"],
        },
        budget: { ...intent().budget, maxBrowserMs: 0 },
      }),
      inputFacts: facts(),
    },
    {
      name: "live read without a network provider",
      inputIntent: intent(),
      inputFacts: facts({
        cachePolicy: "live",
        providers: { cache: true, http: false, browser: false },
      }),
    },
    {
      name: "cache-only read without cache availability",
      inputIntent: intent(),
      inputFacts: facts({
        cachePolicy: "cache-only",
        providers: { cache: false, http: true, browser: true },
      }),
    },
  ])("fails visibly for an unsatisfiable intent: $name", ({ inputIntent, inputFacts }) => {
    expect(() => planAccess(inputIntent, inputFacts)).toThrowError(expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }));
  });
});
