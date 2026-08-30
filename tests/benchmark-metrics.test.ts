import { describe, expect, it } from "vitest";

import type {
  BenchmarkCase,
  BenchmarkCandidate,
  BenchmarkExecutionProvenance,
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
    schemaVersion: 2,
    id,
    layer: "fixture",
    category,
    input: {
      url: `https://example.com/${id}`,
      intent: "read",
      freshnessSeconds: 0,
    },
    policy: {
      browserAllowed: true,
      authProfile: null,
      maxAttempts: 3,
      maxDurationMs: 10_000,
      maxDocumentBytes: 100_000,
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
    httpProviderAttempts: 1,
    documentBytesIn: 1_000,
    browserMilliseconds: 0,
    browserContextStarts: 0,
    retryAttempts: 0,
    retryDelayMilliseconds: 0,
    totalDurationMilliseconds: 100,
    ...overrides,
  };
}

function provenance(
  fetchAttempts: { http: number; browser: number } = { http: 1, browser: 0 },
  overrides: Partial<BenchmarkExecutionProvenance["projection"]["usage"]> = {},
): BenchmarkExecutionProvenance {
  const usage = {
    documentBytesIn: fetchAttempts.browser > 0 ? 3_000 : 1_000,
    networkBytesOut: 0,
    browserMilliseconds: fetchAttempts.browser > 0 ? 600 : 0,
    browserContextStarts: fetchAttempts.browser,
    retryDelayMilliseconds: 0,
    optionalModelTokens: 0,
    ...overrides,
  };
  const attempts: BenchmarkExecutionProvenance["attempts"] = [];
  let sequence = 0;
  for (let index = 0; index < fetchAttempts.http; index += 1) {
    sequence += 1;
    attempts.push({
      sequence, stageId: "http-read", provider: "http", providerVersion: "reader-http-v1",
      outcome: index === fetchAttempts.http - 1 && fetchAttempts.browser === 0 ? "succeeded" : "failed",
      errorCode: index === fetchAttempts.http - 1 && fetchAttempts.browser === 0 ? null : "UPSTREAM_ERROR",
      usage: { ...usage, documentBytesIn: sequence === 1 ? usage.documentBytesIn : 0,
        browserMilliseconds: 0, browserContextStarts: 0,
        retryDelayMilliseconds: sequence === fetchAttempts.http ? usage.retryDelayMilliseconds : 0 },
      startedAt: "2026-08-28T00:00:00.000Z", completedAt: "2026-08-28T00:00:00.100Z",
    });
  }
  for (let index = 0; index < fetchAttempts.browser; index += 1) {
    sequence += 1;
    attempts.push({
      sequence, stageId: "browser-read", provider: "browser", providerVersion: "reader-browser-v1",
      outcome: "succeeded", errorCode: null,
      usage: { ...usage, documentBytesIn: fetchAttempts.http > 0 ? 0 : usage.documentBytesIn,
        browserMilliseconds: usage.browserMilliseconds,
        browserContextStarts: 1, retryDelayMilliseconds: 0 },
      startedAt: "2026-08-28T00:00:00.100Z", completedAt: "2026-08-28T00:00:00.700Z",
    });
  }
  const plannedStages = [
    ...(fetchAttempts.http > 0
      ? [{ stageId: "http-read", provider: "http" as const, reasonCode: "HTTP_PRIMARY" as const }]
      : []),
    ...(fetchAttempts.browser > 0
      ? [{ stageId: "browser-read", provider: "browser" as const,
          reasonCode: "BROWSER_AFTER_INCOMPLETE_HTTP" as const }]
      : []),
  ];
  return {
    schemaVersion: 1,
    requestId: "request-test",
    plan: { planId: `plan_${"a".repeat(64)}`, plannerVersion: "access-planner-v1", plannedStages },
    executedStages: plannedStages.map(({ stageId }) => stageId),
    attempts,
    projection: {
      attempts: attempts.length,
      lastSequence: attempts.length,
      lastOutcome: attempts.at(-1)!.outcome,
      lastStageId: attempts.at(-1)!.stageId,
      usage,
      terminal: null,
    },
  };
}

function candidate(
  fetchMethod: "http" | "browser" = "http",
  fetchAttempts: { http: number; browser: number } = { http: 1, browser: 0 },
): BenchmarkCandidate {
  return {
    outcome: "ok",
    provenance: provenance(fetchAttempts),
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
        retryAttempts: 0,
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
        httpProviderAttempts: 1,
        documentBytesIn: 3_000,
        browserMilliseconds: 600,
        browserContextStarts: 1,
        retryAttempts: 0,
        retryDelayMilliseconds: 0,
        totalDurationMilliseconds: 900,
      });

    expect(executionCostForBenchmarkRun(
      { outcome: "failed", errorCode: "FETCH_TIMEOUT", provenance: provenance(
        { http: 3, browser: 0 },
        { documentBytesIn: 2_000, retryDelayMilliseconds: 75 },
      ) },
      1_200,
    )).toEqual({
      httpProviderAttempts: 3,
      documentBytesIn: 2_000,
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
          httpProviderAttempts: 1,
          documentBytesIn: 3_000,
          browserMilliseconds: 600,
          browserContextStarts: 1,
          totalDurationMilliseconds: 800,
        }),
      }),
      record({
        benchmarkCase: benchmarkCase("article-retry-recovery"),
        cost: cost({ httpProviderAttempts: 2, retryAttempts: 1, retryDelayMilliseconds: 50 }),
      }),
      record({
        benchmarkCase: benchmarkCase("article-retry-waste"),
        candidate: { outcome: "failed", errorCode: "FETCH_TIMEOUT", provenance: provenance() },
        evaluation: evaluation("invalid", false),
        cost: cost({ httpProviderAttempts: 3, retryAttempts: 2, retryDelayMilliseconds: 100 }),
      }),
      record({
        benchmarkCase: benchmarkCase("login-gate", "gate", "policy_stop"),
        candidate: { outcome: "policy_stop", errorCode: "LOGIN_WALL_DETECTED", provenance: provenance() },
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
        httpProviderAttempts: 9,
        documentBytesIn: 8_000,
        browserMilliseconds: 600,
        browserContextStarts: 1,
        retryAttempts: 3,
        retryDelayMilliseconds: 150,
        totalDurationMilliseconds: 1_300,
      },
      costPerValidArtifact: {
        httpProviderAttempts: 3,
        documentBytesIn: 8_000 / 3,
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
        candidate: { outcome: "unsupported", errorCode: "UNSUPPORTED_CONTENT_TYPE", provenance: provenance() },
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
