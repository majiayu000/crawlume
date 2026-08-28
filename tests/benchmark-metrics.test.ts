import { describe, expect, it } from "vitest";

import type {
  BenchmarkCase,
  BenchmarkCandidate,
  BenchmarkEvaluation,
} from "../benchmarks/harness/contract.js";
import {
  aggregateBenchmarkRuns,
  executionCostForBenchmarkRun,
  type BenchmarkExecutionCost,
  type BenchmarkRunRecord,
} from "../benchmarks/harness/metrics.js";

function benchmarkCase(
  id: string,
  category = "article",
  expectedOutcome?: "policy_stop" | "unsupported",
): BenchmarkCase {
  return {
    schemaVersion: 1,
    id,
    layer: "fixture",
    category,
    input: {
      url: `https://example.com/${id}`,
      intent: "read",
      mode: "auto",
      freshnessSeconds: 0,
    },
    policy: {
      browserAllowed: true,
      authProfile: null,
      maxAttempts: 3,
      maxDurationMs: 10_000,
      maxBrowserMs: 3_000,
    },
    truth: {
      required: expectedOutcome === undefined
        ? [{ type: "contains_text", value: "expected" }]
        : [{ type: "outcome_equals", value: expectedOutcome }],
      forbidden: [],
    },
    reviewedAt: "2026-08-28T00:00:00.000Z",
    expiresAt: null,
  };
}

function cost(overrides: Partial<BenchmarkExecutionCost> = {}): BenchmarkExecutionCost {
  return {
    httpRequests: 1,
    networkBytesIn: 1_000,
    browserMilliseconds: 0,
    browserContextStarts: 0,
    retryAttempts: 0,
    retryDelayMilliseconds: 0,
    totalDurationMilliseconds: 100,
    ...overrides,
  };
}

function candidate(
  fetchMethod: "http" | "browser" = "http",
  fetchAttempts: { http: number; browser: number } = { http: 1, browser: 0 },
): BenchmarkCandidate {
  return {
    outcome: "ok",
    artifact: {
      sourceUrl: "https://example.com/article",
      finalUrl: "https://example.com/article",
      title: "Example",
      content: "expected content",
      contentHash: "sha256-example",
      fetchedAt: "2026-08-28T00:00:00.000Z",
      fetchMethod,
      cached: false,
      discoveredUrls: [],
      evidence: {
        httpStatus: 200,
        contentType: "text/html",
        responseBytes: 1_000,
        attempts: 1,
        totalRetryDelayMs: 0,
        fetchAttempts,
        responseBytesByMethod: { http: 1_000, browser: fetchMethod === "browser" ? 2_000 : 0 },
        fetchDurationMsByMethod: {
          http: 100,
          browser: fetchMethod === "browser" ? 600 : 0,
        },
        ...(fetchMethod === "browser" ? {
          browserReadiness: {
            policy: "generic" as const,
            waitedMs: 250,
            reason: "meaningful-content-stable" as const,
            textCharacters: 800,
          },
        } : {}),
      },
    },
  };
}

function evaluation(
  outcome: BenchmarkEvaluation["outcome"],
  passed: boolean,
  falseSuccess = false,
): BenchmarkEvaluation {
  return {
    caseId: "ignored-by-aggregator",
    outcome,
    passed,
    falseSuccess,
    reason: outcome === "harness_error" ? "malformed_candidate" :
      passed ? "all_assertions_passed" : "assertion_failed",
    assertions: [],
  };
}

function record(overrides: Partial<BenchmarkRunRecord> = {}): BenchmarkRunRecord {
  const selectedCase = overrides.benchmarkCase ?? benchmarkCase("article-valid");
  const selectedEvaluation = overrides.evaluation ?? evaluation("valid", true);
  return {
    candidate: candidate(),
    cost: cost(),
    ...overrides,
    benchmarkCase: selectedCase,
    evaluation: {
      ...selectedEvaluation,
      caseId: selectedEvaluation.caseId === "ignored-by-aggregator"
        ? selectedCase.id
        : selectedEvaluation.caseId,
    },
  };
}

describe("benchmark truth and cost aggregation", () => {
  it("derives resource cost from successful and failed public run evidence", () => {
    expect(executionCostForBenchmarkRun(candidate("browser", { http: 1, browser: 1 }), 900))
      .toEqual({
        httpRequests: 1,
        networkBytesIn: 3_000,
        browserMilliseconds: 600,
        browserContextStarts: 1,
        retryAttempts: 0,
        retryDelayMilliseconds: 0,
        totalDurationMilliseconds: 900,
      });

    expect(executionCostForBenchmarkRun(
      { outcome: "failed", errorCode: "FETCH_TIMEOUT" },
      1_200,
      {
        attempts: 3,
        totalRetryDelayMs: 75,
        httpFetchAttempts: 3,
        browserFetchAttempts: 0,
        httpResponseBytes: 2_000,
        browserResponseBytes: 0,
        httpFetchDurationMs: 1_000,
        browserFetchDurationMs: 0,
      },
    )).toEqual({
      httpRequests: 3,
      networkBytesIn: 2_000,
      browserMilliseconds: 0,
      browserContextStarts: 0,
      retryAttempts: 2,
      retryDelayMilliseconds: 75,
      totalDurationMilliseconds: 1_200,
    });
  });

  it("reports validity, false success, browser uplift, retry recovery, and resource cost", () => {
    const records: BenchmarkRunRecord[] = [
      record(),
      record({
        benchmarkCase: benchmarkCase("article-false-success"),
        evaluation: evaluation("invalid", false, true),
      }),
      record({
        benchmarkCase: benchmarkCase("article-browser-recovery"),
        candidate: candidate("browser", { http: 1, browser: 1 }),
        cost: cost({
          httpRequests: 1,
          networkBytesIn: 3_000,
          browserMilliseconds: 600,
          browserContextStarts: 1,
          totalDurationMilliseconds: 800,
        }),
      }),
      record({
        benchmarkCase: benchmarkCase("article-retry-recovery"),
        cost: cost({ httpRequests: 2, retryAttempts: 1, retryDelayMilliseconds: 50 }),
      }),
      record({
        benchmarkCase: benchmarkCase("article-retry-waste"),
        candidate: { outcome: "failed", errorCode: "FETCH_TIMEOUT" },
        evaluation: evaluation("invalid", false),
        cost: cost({ httpRequests: 3, retryAttempts: 2, retryDelayMilliseconds: 100 }),
      }),
      record({
        benchmarkCase: benchmarkCase("login-gate", "gate", "policy_stop"),
        candidate: { outcome: "policy_stop", errorCode: "LOGIN_WALL_DETECTED" },
        evaluation: evaluation("valid", true),
        cost: cost(),
      }),
      record({
        benchmarkCase: benchmarkCase("expired-live"),
        evaluation: evaluation("harness_error", false),
      }),
    ];

    expect(aggregateBenchmarkRuns(records)).toEqual({
      totalRuns: 7,
      measuredRuns: 6,
      eligibleRuns: 5,
      truthPassedRuns: 4,
      truthPassRate: 4 / 6,
      outcomes: {
        valid: 3,
        uncertain: 0,
        invalid: 1,
        failed: 1,
        policyStop: 1,
        unsupported: 0,
        harnessError: 1,
      },
      quality: {
        validArtifacts: 3,
        returnedOk: 4,
        validResultRate: 3 / 5,
        falseSuccesses: 1,
        falseSuccessRate: 1 / 4,
        uncertainRate: 0,
        validLatencyP50Ms: 100,
        validLatencyP95Ms: 800,
      },
      browser: {
        starts: 1,
        escalationRate: 1 / 5,
        recoveredAfterHttp: 1,
        uplift: 1,
      },
      retry: {
        retriedRuns: 2,
        recoveredRuns: 1,
        wastedRuns: 1,
        recoveryRate: 1 / 2,
        wasteRate: 1 / 2,
      },
      totalCost: {
        httpRequests: 9,
        networkBytesIn: 8_000,
        browserMilliseconds: 600,
        browserContextStarts: 1,
        retryAttempts: 3,
        retryDelayMilliseconds: 150,
        totalDurationMilliseconds: 1_300,
      },
      costPerValidArtifact: {
        httpRequests: 3,
        networkBytesIn: 8_000 / 3,
        browserMilliseconds: 200,
        browserContextStarts: 1 / 3,
        retryAttempts: 1,
        retryDelayMilliseconds: 50,
        totalDurationMilliseconds: 1_300 / 3,
      },
      categories: [
        { category: "article", runs: 6, measuredRuns: 5, eligibleRuns: 5, validArtifacts: 3,
          validResultRate: 3 / 5, falseSuccesses: 1, falseSuccessRate: 1 / 4 },
        { category: "gate", runs: 1, measuredRuns: 1, eligibleRuns: 0, validArtifacts: 0,
          validResultRate: null, falseSuccesses: 0, falseSuccessRate: null },
      ],
    });
  });

  it("returns null rates when a denominator is empty", () => {
    const summary = aggregateBenchmarkRuns([
      record({
        benchmarkCase: benchmarkCase("unsupported-format", "format", "unsupported"),
        candidate: { outcome: "unsupported", errorCode: "UNSUPPORTED_CONTENT_TYPE" },
        evaluation: evaluation("valid", true),
      }),
    ]);

    expect(summary.quality.validResultRate).toBeNull();
    expect(summary.quality.falseSuccessRate).toBeNull();
    expect(summary.browser.escalationRate).toBeNull();
    expect(summary.browser.uplift).toBeNull();
    expect(summary.retry.recoveryRate).toBeNull();
    expect(summary.retry.wasteRate).toBeNull();
    expect(summary.costPerValidArtifact).toBeNull();
  });

  it("keeps an indeterminate truth verdict separate from invalid and failed", () => {
    const summary = aggregateBenchmarkRuns([record({
      benchmarkCase: benchmarkCase("article-indeterminate"),
      evaluation: {
        ...evaluation("uncertain", false),
        reason: "assertion_indeterminate",
      },
    })]);

    expect(summary.outcomes).toMatchObject({ uncertain: 1, invalid: 0, failed: 0 });
    expect(summary.quality).toMatchObject({
      validArtifacts: 0,
      returnedOk: 1,
      validResultRate: 0,
      falseSuccesses: 0,
      falseSuccessRate: 0,
      uncertainRate: 1,
    });
  });

  it("rejects malformed or internally contradictory run records", () => {
    expect(() => aggregateBenchmarkRuns([])).toThrow("at least one benchmark run");
    expect(() => aggregateBenchmarkRuns([record({
      cost: cost({ browserContextStarts: -1 }),
    })])).toThrow("browserContextStarts");
    expect(() => aggregateBenchmarkRuns([record({
      benchmarkCase: benchmarkCase("different-id"),
      evaluation: { ...evaluation("valid", true), caseId: "wrong-id" },
    })])).toThrow("evaluation.caseId");
  });
});
