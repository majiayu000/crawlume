import { describe, expect, it } from "vitest";

import {
  emptyCrawlResourceUsage,
  remainingCrawlResources,
  reserveCrawlResources,
  settleCrawlResources,
} from "../src/runtime/resource-governor.js";
import type { CrawlBudget, CrawlResourceUsage, ExecutionBudget } from "../src/types.js";

const crawlBudget: CrawlBudget = {
  maxDurationMs: 10_000,
  maxProviderAttempts: 6,
  maxDocumentBytes: 1_000,
  maxBrowserMs: 600,
  maxBrowserContexts: 2,
};

const requestedBudget: ExecutionBudget = {
  deadlineMs: 8_000,
  maxAttempts: 4,
  maxDocumentBytes: 700,
  maxBrowserMs: 500,
  maxBrowserContexts: 1,
  maxOptionalModelTokens: 20,
};

function usage(overrides: Partial<CrawlResourceUsage> = {}): CrawlResourceUsage {
  return { ...emptyCrawlResourceUsage(), ...overrides };
}

describe("crawl resource governor", () => {
  it("calculates remaining resources after committed and concurrent reserved usage", () => {
    expect(remainingCrawlResources({
      budget: crawlBudget,
      usage: usage({
        providerAttempts: 1,
        documentBytesIn: 100,
        browserMilliseconds: 100,
      }),
      reserved: usage({
        providerAttempts: 2,
        documentBytesIn: 300,
        browserMilliseconds: 200,
        browserContextStarts: 1,
      }),
      elapsedMs: 2_500,
    })).toEqual({
      maxDurationMs: 7_500,
      maxProviderAttempts: 3,
      maxDocumentBytes: 600,
      maxBrowserMs: 300,
      maxBrowserContexts: 1,
    });
  });

  it("shrinks a page execution budget and atomically accounts for its reservation", () => {
    const result = reserveCrawlResources({
      budget: crawlBudget,
      usage: usage({ providerAttempts: 1, documentBytesIn: 200 }),
      reserved: usage({ providerAttempts: 2, documentBytesIn: 300 }),
      requested: requestedBudget,
      elapsedMs: 4_000,
    });

    expect(result.budgetSlice).toEqual({
      deadlineMs: 6_000,
      maxAttempts: 3,
      maxDocumentBytes: 500,
      maxBrowserMs: 500,
      maxBrowserContexts: 1,
      maxOptionalModelTokens: 20,
    });
    expect(result.reservation).toEqual(usage({
      providerAttempts: 3,
      documentBytesIn: 500,
      browserMilliseconds: 500,
      browserContextStarts: 1,
    }));
    expect(result.reserved).toEqual(usage({
      providerAttempts: 5,
      documentBytesIn: 800,
      browserMilliseconds: 500,
      browserContextStarts: 1,
    }));
  });

  it("prevents concurrent reservations from oversubscribing a hard budget", () => {
    const first = reserveCrawlResources({
      budget: crawlBudget,
      usage: usage(),
      reserved: usage(),
      requested: requestedBudget,
      elapsedMs: 0,
    });
    const second = reserveCrawlResources({
      budget: crawlBudget,
      usage: usage(),
      reserved: first.reserved,
      requested: requestedBudget,
      elapsedMs: 0,
    });

    expect(second.budgetSlice).toMatchObject({
      maxAttempts: 2,
      maxDocumentBytes: 300,
      maxBrowserMs: 100,
      maxBrowserContexts: 1,
    });
    expect(second.reserved).toEqual(usage({
      providerAttempts: 6,
      documentBytesIn: 1_000,
      browserMilliseconds: 600,
      browserContextStarts: 2,
    }));
    expect(() => reserveCrawlResources({
      budget: crawlBudget,
      usage: usage(),
      reserved: second.reserved,
      requested: requestedBudget,
      elapsedMs: 0,
    })).toThrow(expect.objectContaining({
      code: "BUDGET_EXHAUSTED",
      details: expect.objectContaining({ budgetDimension: "maxProviderAttempts" }),
    }));
  });

  it("settles actual usage and refunds the unused reservation", () => {
    const reserved = usage({
      providerAttempts: 4,
      documentBytesIn: 700,
      browserMilliseconds: 500,
      browserContextStarts: 1,
    });
    const result = settleCrawlResources({
      budget: crawlBudget,
      usage: usage({ providerAttempts: 1, documentBytesIn: 50 }),
      reserved,
      reservation: reserved,
      actual: usage({
        providerAttempts: 2,
        documentBytesIn: 250,
        networkBytesOut: 30,
        browserMilliseconds: 200,
        browserContextStarts: 1,
        retryDelayMilliseconds: 40,
        optionalModelTokens: 5,
      }),
    });

    expect(result.usage).toEqual(usage({
      providerAttempts: 3,
      documentBytesIn: 300,
      networkBytesOut: 30,
      browserMilliseconds: 200,
      browserContextStarts: 1,
      retryDelayMilliseconds: 40,
      optionalModelTokens: 5,
    }));
    expect(result.reserved).toEqual(usage());
    expect(remainingCrawlResources({
      budget: crawlBudget,
      usage: result.usage,
      reserved: result.reserved,
      elapsedMs: 1_000,
    })).toMatchObject({
      maxProviderAttempts: 3,
      maxDocumentBytes: 700,
      maxBrowserMs: 400,
      maxBrowserContexts: 1,
    });
  });

  it("fails visibly when actual usage exceeds its reservation", () => {
    expect(() => settleCrawlResources({
      budget: crawlBudget,
      usage: usage(),
      reserved: usage({ providerAttempts: 1, documentBytesIn: 100 }),
      reservation: usage({ providerAttempts: 1, documentBytesIn: 100 }),
      actual: usage({ providerAttempts: 2, documentBytesIn: 100 }),
    })).toThrow(expect.objectContaining({
      code: "BUDGET_EXHAUSTED",
      details: expect.objectContaining({ budgetDimension: "maxProviderAttempts" }),
    }));
  });

  it("rejects invalid negative, fractional, and internally oversubscribed state", () => {
    expect(() => remainingCrawlResources({
      budget: crawlBudget,
      usage: usage({ providerAttempts: -1 }),
      reserved: usage(),
      elapsedMs: 0,
    })).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));

    expect(() => reserveCrawlResources({
      budget: crawlBudget,
      usage: usage(),
      reserved: usage(),
      requested: { ...requestedBudget, maxDocumentBytes: 1.5 },
      elapsedMs: 0,
    })).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));

    expect(() => remainingCrawlResources({
      budget: crawlBudget,
      usage: usage({ providerAttempts: 5 }),
      reserved: usage({ providerAttempts: 2 }),
      elapsedMs: 0,
    })).toThrow(expect.objectContaining({
      code: "INVALID_ARGUMENT",
      details: expect.objectContaining({ budgetDimension: "maxProviderAttempts" }),
    }));
  });

  it("fails visibly when the shared crawl deadline is exhausted", () => {
    expect(() => reserveCrawlResources({
      budget: crawlBudget,
      usage: usage(),
      reserved: usage(),
      requested: requestedBudget,
      elapsedMs: 10_000,
    })).toThrow(expect.objectContaining({
      code: "BUDGET_EXHAUSTED",
      details: expect.objectContaining({ budgetDimension: "maxDurationMs" }),
    }));
  });
});
