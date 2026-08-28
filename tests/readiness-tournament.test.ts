import { describe, expect, it } from "vitest";

import {
  evaluateReadinessRun,
  summarizeReadinessRuns,
  type ReadinessObservation,
  type ReadinessRunRecord,
  type ReadinessTruth,
} from "../benchmarks/readiness/contract.js";

const articleTruth: ReadinessTruth = {
  expectedOutcome: "artifact",
  requiredText: ["READY:article"],
  forbiddenText: ["Loading article"],
  minTextCharacters: 500,
  minItems: 0,
  requiresTerminalMarker: true,
};

function artifact(
  overrides: Partial<Extract<ReadinessObservation, { outcome: "artifact" }>> = {},
): Extract<ReadinessObservation, { outcome: "artifact" }> {
  return {
    outcome: "artifact",
    durationMs: 320,
    text: `READY:article ${"evidence ".repeat(70)}`,
    itemCount: 0,
    terminalMarker: true,
    ...overrides,
  };
}

describe("readiness tournament truth evaluator", () => {
  it("accepts an artifact only when every independent truth assertion passes", () => {
    expect(evaluateReadinessRun(articleTruth, artifact())).toMatchObject({
      valid: true,
      falseSuccess: false,
      reason: "all_assertions_passed",
    });
  });

  it("marks an early skeleton artifact as a false success", () => {
    expect(evaluateReadinessRun(articleTruth, artifact({
      text: "Loading article",
      terminalMarker: false,
    }))).toMatchObject({
      valid: false,
      falseSuccess: true,
      reason: "artifact_assertion_failed",
    });
  });

  it("treats a timeout as correct only when the case truth expects no stable artifact", () => {
    const timeout: ReadinessObservation = {
      outcome: "timeout",
      durationMs: 2_000,
      errorCode: "FETCH_TIMEOUT",
    };
    expect(evaluateReadinessRun({ ...articleTruth, expectedOutcome: "timeout" }, timeout))
      .toMatchObject({ valid: true, falseSuccess: false, reason: "expected_timeout" });
    expect(evaluateReadinessRun(articleTruth, timeout))
      .toMatchObject({ valid: false, falseSuccess: false, reason: "unexpected_timeout" });
  });

  it("marks a returned artifact as false success when timeout is the required outcome", () => {
    expect(evaluateReadinessRun({ ...articleTruth, expectedOutcome: "timeout" }, artifact()))
      .toMatchObject({
        valid: false,
        falseSuccess: true,
        reason: "expected_timeout_but_returned_artifact",
      });
  });

  it("aggregates validity, false success, median, and p95 without hiding invalid runs", () => {
    const records: ReadinessRunRecord[] = [
      { strategy: "adaptive", caseId: "instant", repeat: 1, observation: artifact({ durationMs: 300 }), evaluation: evaluateReadinessRun(articleTruth, artifact()) },
      { strategy: "adaptive", caseId: "instant", repeat: 2, observation: artifact({ durationMs: 500 }), evaluation: evaluateReadinessRun(articleTruth, artifact()) },
      { strategy: "adaptive", caseId: "skeleton", repeat: 1, observation: artifact({ durationMs: 100 }), evaluation: evaluateReadinessRun(articleTruth, artifact({ text: "Loading article", terminalMarker: false })) },
    ];

    expect(summarizeReadinessRuns(records)).toEqual([{
      strategy: "adaptive",
      totalRuns: 3,
      validRuns: 2,
      validRate: 2 / 3,
      falseSuccesses: 1,
      falseSuccessRate: 1 / 3,
      validLatencyMedianMs: 400,
      validLatencyP95Ms: 500,
    }]);
  });
});
