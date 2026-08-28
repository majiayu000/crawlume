export const readinessStrategyIds = ["fixed-750", "adaptive", "target"] as const;
export type ReadinessStrategyId = (typeof readinessStrategyIds)[number];
export type ReadinessCaseId =
  | "instant"
  | "delayed"
  | "skeleton"
  | "changing"
  | "infinite-scroll";

export type ReadinessTruth = {
  expectedOutcome: "artifact" | "timeout";
  requiredText: string[];
  forbiddenText: string[];
  minTextCharacters: number;
  minItems: number;
  requiresTerminalMarker: boolean;
};

export type ReadinessCase = {
  id: ReadinessCaseId;
  path: string;
  category: "instant" | "delayed" | "skeleton" | "unstable" | "interaction";
  truth: ReadinessTruth;
  targetSelector: string;
  interaction: "none" | "scroll-to-end";
};

export type ReadinessObservation = {
  outcome: "artifact";
  durationMs: number;
  text: string;
  itemCount: number;
  terminalMarker: boolean;
} | {
  outcome: "timeout";
  durationMs: number;
  errorCode: "FETCH_TIMEOUT";
};

export type ReadinessAssertion = {
  name: "outcome" | "required_text" | "forbidden_text" |
    "text_characters" | "items" | "terminal_marker";
  passed: boolean;
  expected: string | number | boolean;
  actual: string | number | boolean;
};

export type ReadinessEvaluation = {
  valid: boolean;
  falseSuccess: boolean;
  reason: "all_assertions_passed" | "artifact_assertion_failed" |
    "expected_timeout" | "unexpected_timeout" | "expected_timeout_but_returned_artifact";
  assertions: ReadinessAssertion[];
};

export type ReadinessRunRecord = {
  strategy: ReadinessStrategyId;
  caseId: ReadinessCaseId;
  repeat: number;
  observation: ReadinessObservation;
  evaluation: ReadinessEvaluation;
};

export type ReadinessStrategySummary = {
  strategy: ReadinessStrategyId;
  totalRuns: number;
  validRuns: number;
  validRate: number;
  falseSuccesses: number;
  falseSuccessRate: number;
  validLatencyMedianMs: number | null;
  validLatencyP95Ms: number | null;
};

function readinessAssertion(
  name: ReadinessAssertion["name"],
  passed: boolean,
  expected: ReadinessAssertion["expected"],
  actual: ReadinessAssertion["actual"],
): ReadinessAssertion {
  return { name, passed, expected, actual };
}

export function evaluateReadinessRun(
  truth: ReadinessTruth,
  observation: ReadinessObservation,
): ReadinessEvaluation {
  if (truth.expectedOutcome === "timeout") {
    return observation.outcome === "timeout"
      ? { valid: true, falseSuccess: false, reason: "expected_timeout", assertions: [] }
      : {
          valid: false,
          falseSuccess: true,
          reason: "expected_timeout_but_returned_artifact",
          assertions: [readinessAssertion("outcome", false, "timeout", "artifact")],
        };
  }
  if (observation.outcome === "timeout") {
    return {
      valid: false,
      falseSuccess: false,
      reason: "unexpected_timeout",
      assertions: [readinessAssertion("outcome", false, "artifact", "timeout")],
    };
  }
  const text = observation.text.replace(/\s+/gu, " ").trim();
  const assertions = [
    ...truth.requiredText.map((value) =>
      readinessAssertion("required_text", text.includes(value), value, text)),
    ...truth.forbiddenText.map((value) =>
      readinessAssertion("forbidden_text", !text.includes(value), `not:${value}`, text)),
    readinessAssertion(
      "text_characters",
      text.length >= truth.minTextCharacters,
      truth.minTextCharacters,
      text.length,
    ),
    readinessAssertion(
      "items",
      observation.itemCount >= truth.minItems,
      truth.minItems,
      observation.itemCount,
    ),
    readinessAssertion(
      "terminal_marker",
      !truth.requiresTerminalMarker || observation.terminalMarker,
      truth.requiresTerminalMarker,
      observation.terminalMarker,
    ),
  ];
  const valid = assertions.every((value) => value.passed);
  return {
    valid,
    falseSuccess: !valid,
    reason: valid ? "all_assertions_passed" : "artifact_assertion_failed",
    assertions,
  };
}

function readinessMedian(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return null;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2;
}

export function summarizeReadinessRuns(
  records: ReadinessRunRecord[],
): ReadinessStrategySummary[] {
  return readinessStrategyIds.flatMap((strategy) => {
    const selected = records.filter((record) => record.strategy === strategy);
    if (selected.length === 0) return [];
    const valid = selected.filter((record) => record.evaluation.valid);
    const falseSuccesses = selected.filter((record) => record.evaluation.falseSuccess).length;
    const latencies = valid.map((record) => record.observation.durationMs).sort((a, b) => a - b);
    return [{
      strategy,
      totalRuns: selected.length,
      validRuns: valid.length,
      validRate: valid.length / selected.length,
      falseSuccesses,
      falseSuccessRate: falseSuccesses / selected.length,
      validLatencyMedianMs: readinessMedian(latencies),
      validLatencyP95Ms: latencies[Math.max(0, Math.ceil(0.95 * latencies.length) - 1)] ?? null,
    }];
  });
}
