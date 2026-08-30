import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  analyzeRetryCounterfactual,
  createPolicyCandidate,
  releasePolicy,
  reviewPolicy,
  rollbackPolicy,
  runExtractorTournament,
  summarizeHttpBrowserShadow,
} from "../benchmarks/optimization/loop.js";
import type { BenchmarkCandidate, BenchmarkEvaluation } from "../benchmarks/harness/contract.js";
import type { BenchmarkCorpusRun } from "../benchmarks/harness/corpus.js";
import type { BenchmarkExecutionCost } from "../benchmarks/harness/metrics.js";
import type { RawPage } from "../src/types.js";

const zeroCost: BenchmarkExecutionCost = {
  httpProviderAttempts: 0,
  documentBytesIn: 0,
  browserMilliseconds: 0,
  browserContextStarts: 0,
  retryAttempts: 0,
  retryDelayMilliseconds: 0,
  totalDurationMilliseconds: 0,
};

function evaluation(passed: boolean, falseSuccess = false): BenchmarkEvaluation {
  return {
    caseId: "sample",
    outcome: passed ? "valid" : "invalid",
    passed,
    falseSuccess,
    reason: passed ? "all_assertions_passed" : "assertion_failed",
    assertions: [],
  };
}

describe("optimization evidence loop", () => {
  it("aggregates HTTP/Browser shadow uplift without retaining sensitive candidates", () => {
    const sensitiveCandidate = {
      outcome: "ok",
      artifact: { content: "SECRET BODY", sourceUrl: "https://private.example/token=secret" },
      provenance: { requestId: "request-secret" },
    } as BenchmarkCandidate;
    const summary = summarizeHttpBrowserShadow([{
      category: "dynamic",
      primary: {
        candidate: { outcome: "failed", errorCode: "SHELL_ONLY" } as BenchmarkCandidate,
        evaluation: evaluation(false),
        cost: { ...zeroCost, httpProviderAttempts: 1, totalDurationMilliseconds: 20 },
      },
      shadow: {
        candidate: sensitiveCandidate,
        evaluation: evaluation(true),
        cost: { ...zeroCost, browserContextStarts: 1, browserMilliseconds: 200,
          totalDurationMilliseconds: 220 },
      },
    }]);

    expect(summary).toMatchObject({
      samples: 1,
      primaryValid: 0,
      shadowValid: 1,
      browserUplift: 1,
      falseSuccesses: 0,
      browserContextStarts: 1,
    });
    expect(JSON.stringify(summary)).not.toMatch(/SECRET|private\.example|request-secret|token/u);
  });

  it("computes retry counterfactuals only from recorded attempts", () => {
    const run = {
      repeat: 1,
      benchmarkCase: { id: "retry", category: "retry" },
      evaluation: evaluation(true),
      candidate: {
        outcome: "ok",
        provenance: {
          attempts: [
            { stageId: "http", provider: "http", outcome: "failed", errorCode: "UPSTREAM_ERROR" },
            { stageId: "http", provider: "http", outcome: "succeeded", errorCode: null },
          ],
        },
      },
      cost: { ...zeroCost, retryAttempts: 1 },
    } as BenchmarkCorpusRun;

    expect(analyzeRetryCounterfactual([run])).toEqual({
      runs: 1,
      retriedRuns: 1,
      noRetryValidRuns: 0,
      oneRetryValidRuns: 1,
      currentValidRuns: 1,
      recoveredRuns: 1,
      wastedRuns: 0,
      byFirstErrorCode: [{ errorCode: "UPSTREAM_ERROR", retriedRuns: 1, recoveredRuns: 1,
        wastedRuns: 0 }],
    });
  });

  it("compares all HTML extractors on the same raw object without emitting content", async () => {
    const body = `<html><head><title>Tournament</title></head><body><main><h1>Expected title</h1><p>${
      "independent truth evidence ".repeat(40)
    }</p></main><div>navigation noise</div></body></html>`;
    const raw: RawPage = {
      body,
      bodyBytes: new Uint8Array(Buffer.from(body)),
      fetchedAt: "2026-08-30T00:00:00.000Z",
      method: "http",
      httpStatus: 200,
      contentType: "text/html; charset=utf-8",
      responseBytes: Buffer.byteLength(body),
      finalUrl: "https://example.com/article",
    };
    const rawRef = `sha256:${createHash("sha256").update(body).digest("hex")}`;

    const report = await runExtractorTournament(rawRef, raw, {
      requiredText: ["Expected title", "independent truth evidence"],
      forbiddenText: ["navigation noise"],
      minContentCharacters: 400,
    });

    expect(report.rawRef).toBe(rawRef);
    expect(report.candidates.map(({ extractorId }) => extractorId)).toEqual([
      "article",
      "document",
    ]);
    expect(report.candidates[0]).toMatchObject({ valid: true, falseSuccess: false });
    expect(report.candidates[1]).toMatchObject({ valid: false, falseSuccess: true });
    expect(JSON.stringify(report)).not.toContain("independent truth evidence");
  });

  it("requires explicit approval before release and rolls back only to a released ancestor", () => {
    const first = createPolicyCandidate({
      parentPolicyId: null,
      plannerVersion: "access-planner-v1",
      evidenceHashes: [`sha256:${"a".repeat(64)}`],
      decisions: { browserEscalation: "after-invalid", readiness: "target-first",
        retry: "stage-bounded", extractor: "registry-order" },
      generatedAt: "2026-08-30T00:00:00.000Z",
    });
    const rejected = reviewPolicy(first, {
      reviewer: "human-reviewer",
      decision: "rejected",
      reviewedAt: "2026-08-30T01:00:00.000Z",
      rationale: "insufficient evidence",
    });
    expect(() => releasePolicy(first, rejected, null)).toThrow("approved review");

    const approved = reviewPolicy(first, {
      reviewer: "human-reviewer",
      decision: "approved",
      reviewedAt: "2026-08-30T01:00:00.000Z",
      rationale: "controlled evidence accepted",
    });
    expect(() => reviewPolicy({ ...first, plannerVersion: "tampered" }, {
      reviewer: "human-reviewer",
      decision: "approved",
      reviewedAt: "2026-08-30T01:00:00.000Z",
      rationale: "must not pass",
    })).toThrow("integrity");
    expect(() => releasePolicy(first, { ...approved, rationale: "tampered" }, null))
      .toThrow("integrity");
    const firstRelease = releasePolicy(first, approved, null);
    const second = createPolicyCandidate({
      ...first,
      parentPolicyId: first.policyId,
      evidenceHashes: [`sha256:${"b".repeat(64)}`],
      generatedAt: "2026-08-30T02:00:00.000Z",
    });
    const secondRelease = releasePolicy(second, reviewPolicy(second, {
      reviewer: "human-reviewer",
      decision: "approved",
      reviewedAt: "2026-08-30T03:00:00.000Z",
      rationale: "paired benchmark accepted",
    }), firstRelease.releaseId);

    expect(rollbackPolicy(secondRelease, firstRelease, [secondRelease, firstRelease], {
      requestedBy: "human-reviewer",
      requestedAt: "2026-08-30T04:00:00.000Z",
      reason: "regression",
    })).toMatchObject({
      fromReleaseId: secondRelease.releaseId,
      toReleaseId: firstRelease.releaseId,
      reason: "regression",
    });
    expect(first.policyId).toMatch(/^policy_[a-f0-9]{64}$/u);
    expect(firstRelease.releaseId).toMatch(/^release_[a-f0-9]{64}$/u);
  });
});
