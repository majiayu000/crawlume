import { describe, expect, it } from "vitest";

import {
  candidateFromPageArtifact,
  evaluateBenchmarkCase,
  parseBenchmarkCase,
  type BenchmarkCase,
  type BenchmarkCandidate,
  type BenchmarkExecutionProvenance,
} from "../benchmarks/harness/contract.js";
import { benchmarkOutcomeForErrorCode } from "../benchmarks/controlled-site/server.js";
import { AttemptLedger } from "../src/jobs.js";

function benchmarkCase(overrides: Partial<BenchmarkCase> = {}): BenchmarkCase {
  return {
    schemaVersion: 2,
    id: "article-static-001",
    layer: "fixture",
    category: "article",
    input: {
      url: "https://example.com/article",
      intent: "read",
      freshnessSeconds: 0,
    },
    policy: {
      browserAllowed: true,
      authProfile: null,
      maxAttempts: 2,
      maxDurationMs: 10_000,
      maxBrowserMs: 3_000,
    },
    truth: {
      required: [
        { type: "title_equals", value: "Example Article" },
        { type: "contains_text", value: "ground truth paragraph" },
        { type: "min_content_characters", value: 40 },
      ],
      forbidden: [
        { type: "contains_text", value: "Sign in to continue" },
      ],
    },
    reviewedAt: "2026-08-28T00:00:00.000Z",
    expiresAt: null,
    ...overrides,
  };
}

function provenance(overrides: Partial<BenchmarkExecutionProvenance> = {}): BenchmarkExecutionProvenance {
  const usage = {
    documentBytesIn: 1_024,
    networkBytesOut: 0,
    browserMilliseconds: 0,
    browserContextStarts: 0,
    retryDelayMilliseconds: 0,
    optionalModelTokens: 0,
  };
  return {
    schemaVersion: 1,
    requestId: "request-test",
    plan: {
      planId: `plan_${"a".repeat(64)}`,
      plannerVersion: "access-planner-v1",
      plannedStages: [{ stageId: "http-read", provider: "http", reasonCode: "HTTP_PRIMARY" }],
    },
    executedStages: ["http-read"],
    attempts: [{
      sequence: 1,
      stageId: "http-read",
      provider: "http",
      providerVersion: "reader-http-v1",
      outcome: "succeeded",
      errorCode: null,
      usage,
      startedAt: "2026-08-28T00:00:00.000Z",
      completedAt: "2026-08-28T00:00:00.100Z",
    }],
    projection: {
      attempts: 1,
      lastSequence: 1,
      lastOutcome: "succeeded",
      lastStageId: "http-read",
      usage,
    },
    ...overrides,
  };
}

function candidate(overrides: Partial<BenchmarkCandidate> = {}): BenchmarkCandidate {
  return {
    outcome: "ok",
    provenance: provenance(),
    artifact: {
      sourceUrl: "https://example.com/article",
      finalUrl: "https://example.com/article",
      title: "Example Article",
      content: "A ground truth paragraph with enough independently evaluated content.",
      contentHash: "sha256-example",
      fetchedAt: "2026-08-28T00:00:00.000Z",
      fetchMethod: "http",
      cached: false,
      discoveredUrls: [],
      evidence: {
        httpStatus: 200,
        contentType: "text/html; charset=utf-8",
        responseBytes: 1_024,
        attempts: 1,
        retryAttempts: 0,
        totalRetryDelayMs: 0,
        fetchAttempts: { http: 1, browser: 0 },
        responseBytesByMethod: { http: 1_024, browser: 0 },
        fetchDurationMsByMethod: { http: 100, browser: 0 },
      },
    },
    ...overrides,
  };
}

describe("benchmark case schema", () => {
  it("accepts a complete fixture case", () => {
    expect(parseBenchmarkCase(benchmarkCase())).toEqual(benchmarkCase());
  });

  it("requires live cases to expire", () => {
    expect(() => parseBenchmarkCase(benchmarkCase({ layer: "live" }))).toThrow(
      "live cases require expiresAt",
    );
  });

  it("rejects browser budget that contradicts policy", () => {
    const value = benchmarkCase({
      policy: {
        ...benchmarkCase().policy,
        browserAllowed: false,
        maxBrowserMs: 1,
      },
    });

    expect(() => parseBenchmarkCase(value)).toThrow(
      "maxBrowserMs must be zero when browser is disallowed",
    );
  });

  it("rejects non-HTTP inputs and reversed review windows", () => {
    expect(() => parseBenchmarkCase(benchmarkCase({
      input: { ...benchmarkCase().input, url: "file:///tmp/private.html" },
    }))).toThrow("HTTP or HTTPS");
    expect(() => parseBenchmarkCase(benchmarkCase({
      expiresAt: "2026-08-27T00:00:00.000Z",
    }))).toThrow("expiresAt must be later than reviewedAt");
  });
});

describe("benchmark runner outcome mapping", () => {
  it.each([
    ["ROBOTS_DISALLOWED", "policy_stop"],
    ["LOGIN_WALL_DETECTED", "policy_stop"],
    ["HUMAN_VERIFICATION_REQUIRED", "policy_stop"],
    ["UNSUPPORTED_CONTENT_TYPE", "unsupported"],
    ["FETCH_TIMEOUT", "failed"],
  ] as const)("maps %s to %s", (errorCode, expected) => {
    expect(benchmarkOutcomeForErrorCode(errorCode)).toBe(expected);
  });

  it("distinguishes a policy denial from a missing page sharing the same error code", () => {
    expect(benchmarkOutcomeForErrorCode("ACCESS_DENIED", 403)).toBe("policy_stop");
    expect(benchmarkOutcomeForErrorCode("ACCESS_DENIED", 404)).toBe("failed");
  });
});

describe("independent benchmark truth evaluator", () => {
  it("passes only when every required and forbidden assertion passes", () => {
    const result = evaluateBenchmarkCase(benchmarkCase(), candidate(), {
      now: new Date("2026-08-29T00:00:00.000Z"),
    });

    expect(result).toMatchObject({ outcome: "valid", passed: true });
    expect(result.assertions).toHaveLength(4);
    expect(result.assertions.every((assertion) => assertion.passed)).toBe(true);
  });

  it("marks a returned login wall as a false success", () => {
    const result = evaluateBenchmarkCase(
      benchmarkCase(),
      candidate({
        artifact: {
          ...candidate().artifact!,
          content: "Sign in to continue",
        },
      }),
    );

    expect(result).toMatchObject({ outcome: "invalid", passed: false, falseSuccess: true });
    expect(result.assertions).toContainEqual(expect.objectContaining({
      type: "contains_text",
      polarity: "forbidden",
      passed: false,
    }));
  });

  it("treats an expired live case as a harness error", () => {
    const liveCase = benchmarkCase({
      layer: "live",
      expiresAt: "2026-09-01T00:00:00.000Z",
    });

    expect(evaluateBenchmarkCase(liveCase, candidate(), {
      now: new Date("2026-09-02T00:00:00.000Z"),
    })).toMatchObject({
      outcome: "harness_error",
      passed: false,
      falseSuccess: false,
      reason: "case_expired",
    });
  });

  it("uses deterministic word overlap instead of a model judge", () => {
    const value = benchmarkCase({
      truth: {
        required: [{
          type: "word_f1_at_least",
          reference: "alpha beta gamma",
          value: 0.8,
        }],
        forbidden: [],
      },
    });
    const result = evaluateBenchmarkCase(value, candidate({
      artifact: { ...candidate().artifact!, content: "alpha beta noise" },
    }));

    expect(result).toMatchObject({ outcome: "invalid", falseSuccess: true });
    expect(result.assertions[0]).toMatchObject({
      passed: false,
      metrics: { precision: 2 / 3, recall: 2 / 3, f1: 2 / 3 },
    });
  });

  it("accepts an explicit policy stop but rejects an ok response for the same case", () => {
    const gateCase = benchmarkCase({
      truth: {
        required: [{ type: "outcome_equals", value: "policy_stop" }],
        forbidden: [],
      },
    });

    expect(evaluateBenchmarkCase(gateCase, {
      outcome: "policy_stop", errorCode: "ROBOTS_DENIED", provenance: provenance(),
    }))
      .toMatchObject({ outcome: "valid", passed: true });
    expect(evaluateBenchmarkCase(gateCase, candidate()))
      .toMatchObject({ outcome: "invalid", passed: false, falseSuccess: true });
  });

  it("requires the typed failure reason when truth declares it", () => {
    const failureCase = benchmarkCase({
      truth: {
        required: [
          { type: "outcome_equals", value: "failed" },
          { type: "error_code_equals", value: "UPSTREAM_ERROR" },
        ],
        forbidden: [],
      },
    });

    expect(evaluateBenchmarkCase(failureCase, {
      outcome: "failed",
      errorCode: "UPSTREAM_ERROR",
      provenance: provenance(),
    })).toMatchObject({ outcome: "valid", passed: true });
    expect(evaluateBenchmarkCase(failureCase, {
      outcome: "failed",
      errorCode: "SSRF_BLOCKED",
      provenance: provenance(),
    })).toMatchObject({ outcome: "invalid", passed: false });
  });

  it("rejects an ok candidate with incomplete provenance", () => {
    const incomplete = candidate();
    delete (incomplete.artifact as Partial<NonNullable<BenchmarkCandidate["artifact"]>>).contentHash;

    expect(evaluateBenchmarkCase(benchmarkCase(), incomplete)).toMatchObject({
      outcome: "harness_error",
      reason: "malformed_candidate",
      falseSuccess: false,
    });
  });

  it("rejects provenance whose ledger projection cannot be reproduced", () => {
    const malformed = candidate();
    malformed.provenance.projection.usage = {
      ...malformed.provenance.projection.usage,
      documentBytesIn: malformed.provenance.projection.usage.documentBytesIn + 1,
    };

    expect(evaluateBenchmarkCase(benchmarkCase(), malformed)).toMatchObject({
      outcome: "harness_error",
      reason: "malformed_candidate",
      falseSuccess: false,
    });
  });

  it("rejects a browser candidate that omits readiness provenance", () => {
    const browserCandidate = candidate({
      artifact: { ...candidate().artifact!, fetchMethod: "browser" },
    });

    expect(evaluateBenchmarkCase(benchmarkCase(), browserCandidate)).toMatchObject({
      outcome: "harness_error",
      reason: "malformed_candidate",
      falseSuccess: false,
    });
  });

  it("maps the public Reader artifact without trusting production validation", () => {
    const ledger = new AttemptLedger(":memory:");
    const usage = {
      documentBytesIn: 512, networkBytesOut: 0, browserMilliseconds: 0,
      browserContextStarts: 0, retryDelayMilliseconds: 0, optionalModelTokens: 0,
    };
    for (const [stageId, provider, outcome, errorCode, stageUsage] of [
      ["http-read", "http", "failed", "SHELL_ONLY", usage],
      ["browser-read", "browser", "succeeded", null, {
        ...usage, documentBytesIn: 2_048, browserMilliseconds: 860,
        browserContextStarts: 1, retryDelayMilliseconds: 50,
      }],
    ] as const) {
      ledger.append({
        requestId: "request-test", planId: `plan_${"a".repeat(64)}`, stageId, provider,
        providerVersion: `reader-${provider}-v1`, outcome, errorCode,
        rawRef: null, traceRef: null, usage: stageUsage,
        startedAt: "2026-08-28T00:00:00.000Z", completedAt: "2026-08-28T00:00:00.100Z",
      });
    }
    const mapped = candidateFromPageArtifact({
      status: "ok",
      sourceUrl: "https://example.com/article",
      finalUrl: "https://example.com/article",
      fetchedAt: "2026-08-28T00:00:00.000Z",
      fetchMethod: "browser",
      authProfile: null,
      cached: false,
      title: "Example Article",
      byline: null,
      publishedTime: null,
      contentMarkdown: "ground truth paragraph",
      contentHash: "sha256-example",
      completeness: "complete",
      validation: { status: "usable", warnings: [] },
      discoveredLinks: ["https://example.com/next"],
      evidence: {
        httpStatus: 200,
        contentType: "text/html",
        responseBytes: 2_048,
        contentCharacters: 22,
        extractionMethod: "readability",
        requestId: "request-test",
        accessPlan: {
          planId: `plan_${"a".repeat(64)}`,
          plannerVersion: "access-planner-v1",
          plannedStages: [
            { stageId: "http-read", provider: "http", reasonCode: "HTTP_PRIMARY" },
            { stageId: "browser-read", provider: "browser", reasonCode: "BROWSER_AFTER_INCOMPLETE_HTTP" },
          ],
          executedStages: ["http-read", "browser-read"],
        },
        attempts: 2,
        retryAttempts: 0,
        totalRetryDelayMs: 50,
        fetchAttempts: { http: 1, browser: 1 },
        responseBytesByMethod: { http: 512, browser: 2_048 },
        fetchDurationMsByMethod: { http: 120, browser: 860 },
        browserReadiness: {
          policy: "generic",
          waitedMs: 1_200,
          reason: "meaningful-content-stable",
          textCharacters: 800,
        },
      },
    }, ledger.list("request-test"), ledger.project("request-test"));
    ledger.close();

    expect(mapped).toMatchObject({
      outcome: "ok",
      provenance: {
        requestId: "request-test",
        executedStages: ["http-read", "browser-read"],
        projection: { attempts: 2, usage: { documentBytesIn: 2_560 } },
      },
      artifact: {
        content: "ground truth paragraph",
        fetchMethod: "browser",
        discoveredUrls: ["https://example.com/next"],
        evidence: { attempts: 2, retryAttempts: 0, totalRetryDelayMs: 50 },
      },
    });
  });
});
