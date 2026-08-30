export const benchmarkMaturityLevels = [
  "experimental",
  "canary-ready",
  "release-candidate",
  "production-proven",
] as const;

export type BenchmarkMaturityLevel = (typeof benchmarkMaturityLevels)[number];

export type BenchmarkLayerCoverage = {
  distinctCases: number;
  minRepeats: number;
};

export type BenchmarkGateInput = {
  layers: {
    controlled: BenchmarkLayerCoverage;
    live: BenchmarkLayerCoverage;
    private: BenchmarkLayerCoverage;
  };
  truthPassRate: number;
  falseSuccesses: number;
  harnessErrors: number;
  provenanceCompleteness: number;
  plannedProviderViolations: number;
  ledgerMismatches: number;
  budgetViolations: number;
  policyViolations: number;
  scopeLeaks: number;
  pairedBaseline: boolean;
  costPerValidDelta: number;
  validRateDelta: number;
  productionRollout?: {
    percentage: number;
    consecutiveDays: number;
  };
};

export type BenchmarkGateViolationCode =
  | "INVALID_INPUT"
  | "PROVENANCE_INCOMPLETE"
  | "PLANNED_PROVIDER_VIOLATION"
  | "LEDGER_MISMATCH"
  | "BUDGET_VIOLATION"
  | "POLICY_VIOLATION"
  | "SCOPE_LEAK"
  | "CANARY_CONTROLLED_CASES"
  | "CANARY_CONTROLLED_REPEATS"
  | "CANARY_LIVE_CASES"
  | "CANARY_LIVE_REPEATS"
  | "TRUTH_NOT_COMPLETE"
  | "FALSE_SUCCESS_PRESENT"
  | "HARNESS_ERROR_PRESENT"
  | "RELEASE_CONTROLLED_CASES"
  | "RELEASE_CONTROLLED_REPEATS"
  | "RELEASE_LIVE_CASES"
  | "RELEASE_LIVE_REPEATS"
  | "RELEASE_PRIVATE_CASES"
  | "RELEASE_PRIVATE_REPEATS"
  | "BASELINE_NOT_PAIRED"
  | "VALID_RATE_REGRESSION"
  | "COST_REGRESSION_UNJUSTIFIED"
  | "PRODUCTION_ROLLOUT_MISSING"
  | "PRODUCTION_ROLLOUT_INCOMPLETE"
  | "PRODUCTION_SOAK_TOO_SHORT";

export type BenchmarkGateViolation = {
  code: BenchmarkGateViolationCode;
  severity: "hard" | "gate";
  gate: "input" | "hard" | "canary" | "release" | "production";
  path: string;
  message: string;
  actual: unknown;
  required: unknown;
};

export type BenchmarkGateEvaluation = {
  level: BenchmarkMaturityLevel;
  hardFailed: boolean;
  gates: {
    canaryReady: boolean;
    releaseCandidate: boolean;
    productionProven: boolean;
  };
  violations: BenchmarkGateViolation[];
};

function layerCoverage(
  runs: BenchmarkCorpusRun[],
  layer: "controlled" | "live",
): BenchmarkLayerCoverage {
  const counts = new Map<string, number>();
  for (const run of runs) {
    if (run.benchmarkCase.layer !== layer) continue;
    counts.set(run.benchmarkCase.id, (counts.get(run.benchmarkCase.id) ?? 0) + 1);
  }
  return {
    distinctCases: counts.size,
    minRepeats: counts.size === 0 ? 0 : Math.min(...counts.values()),
  };
}

function usageEquals(
  left: Record<string, number>,
  right: Record<string, number>,
): boolean {
  return Object.keys(left).every((field) => left[field] === right[field]);
}

export function benchmarkGateInputFromReports(
  reports: BenchmarkCorpusReport[],
  comparison: BenchmarkReleaseComparison | null,
): BenchmarkGateInput {
  const runs = reports.flatMap(({ runs: reportRuns }) => reportRuns);
  if (runs.length === 0) throw new Error("benchmark gate requires at least one report run");
  const seenRunKeys = new Set<string>();
  for (const report of reports) {
    for (const run of report.runs) {
      const key = `${report.caseSetVersion}:${report.caseSetHash}:${run.benchmarkCase.id}#${run.repeat}`;
      if (seenRunKeys.has(key)) throw new Error(`duplicate benchmark gate run: ${key}`);
      seenRunKeys.add(key);
    }
  }

  let completeProvenance = 0;
  let measuredRuns = 0;
  let plannedProviderViolations = 0;
  let ledgerMismatches = 0;
  let budgetViolations = 0;
  let policyViolations = 0;
  let scopeLeaks = 0;
  for (const run of runs) {
    if (run.evaluation.outcome === "harness_error") continue;
    measuredRuns += 1;
    if (run.candidate === null) continue;
    if (parseBenchmarkCandidate(run.candidate) !== undefined) completeProvenance += 1;
    const { provenance } = run.candidate;
    const planned = new Map(provenance.plan.plannedStages.map((stage) => [stage.stageId, stage.provider]));
    plannedProviderViolations += provenance.attempts.filter(
      (attempt) => planned.get(attempt.stageId) !== attempt.provider,
    ).length;
    const summedUsage = Object.fromEntries(
      Object.keys(provenance.projection.usage).map((field) => [
        field,
        provenance.attempts.reduce(
          (sum, attempt) => sum + attempt.usage[field as keyof typeof attempt.usage],
          0,
        ),
      ]),
    ) as Record<string, number>;
    if (
      provenance.projection.attempts !== provenance.attempts.length ||
      !usageEquals(summedUsage, provenance.projection.usage)
    ) ledgerMismatches += 1;
    const usage = provenance.projection.usage;
    if (
      provenance.attempts.length > run.benchmarkCase.policy.maxAttempts ||
      usage.documentBytesIn > run.benchmarkCase.policy.maxDocumentBytes ||
      usage.browserMilliseconds > run.benchmarkCase.policy.maxBrowserMs
    ) budgetViolations += 1;
    if (
      !run.benchmarkCase.policy.browserAllowed &&
      provenance.attempts.some(({ provider }) => provider === "browser")
    ) policyViolations += 1;
    if (
      run.candidate.outcome === "ok" && run.candidate.artifact !== undefined &&
      new URL(run.candidate.artifact.sourceUrl).origin !==
        new URL(run.candidate.artifact.finalUrl).origin
    ) scopeLeaks += 1;
  }

  return {
    layers: {
      controlled: layerCoverage(runs, "controlled"),
      live: layerCoverage(runs, "live"),
      private: { distinctCases: 0, minRepeats: 0 },
    },
    truthPassRate: runs.filter(({ evaluation }) => evaluation.passed).length / runs.length,
    falseSuccesses: runs.filter(({ evaluation }) => evaluation.falseSuccess).length,
    harnessErrors: runs.filter(({ evaluation }) => evaluation.outcome === "harness_error").length,
    provenanceCompleteness: measuredRuns === 0 ? 0 : completeProvenance / measuredRuns,
    plannedProviderViolations,
    ledgerMismatches,
    budgetViolations,
    policyViolations,
    scopeLeaks,
    pairedBaseline: comparison !== null,
    costPerValidDelta: comparison?.costPerValidDelta ?? 0,
    validRateDelta: comparison?.validRateDelta ?? 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(path: string, actual: unknown, required: string): BenchmarkGateViolation {
  return {
    code: "INVALID_INPUT",
    severity: "hard",
    gate: "input",
    path,
    message: `${path} ${required}`,
    actual,
    required,
  };
}

function readFiniteNumber(
  record: Record<string, unknown>,
  field: string,
  violations: BenchmarkGateViolation[],
  path = field,
): number | null {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    violations.push(invalid(path, value, "must be a finite number"));
    return null;
  }
  return value;
}

function readRate(
  record: Record<string, unknown>,
  path: string,
  violations: BenchmarkGateViolation[],
): number | null {
  const value = readFiniteNumber(record, path, violations);
  if (value !== null && (value < 0 || value > 1)) {
    violations.push(invalid(path, value, "must be between 0 and 1"));
    return null;
  }
  return value;
}

function readCount(
  record: Record<string, unknown>,
  field: string,
  violations: BenchmarkGateViolation[],
  path = field,
): number | null {
  const value = readFiniteNumber(record, field, violations, path);
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    violations.push(invalid(path, value, "must be a non-negative safe integer"));
    return null;
  }
  return value;
}

function readLayer(
  layers: Record<string, unknown>,
  name: "controlled" | "live" | "private",
  violations: BenchmarkGateViolation[],
): BenchmarkLayerCoverage | null {
  const raw = layers[name];
  if (!isRecord(raw)) {
    violations.push(invalid(`layers.${name}`, raw, "must be an object"));
    return null;
  }
  const distinctCases = readCount(
    raw,
    "distinctCases",
    violations,
    `layers.${name}.distinctCases`,
  );
  const minRepeats = readCount(raw, "minRepeats", violations, `layers.${name}.minRepeats`);
  if (distinctCases === null || minRepeats === null) return null;
  return { distinctCases, minRepeats };
}

function parseInput(input: unknown): {
  value: BenchmarkGateInput | null;
  violations: BenchmarkGateViolation[];
} {
  const violations: BenchmarkGateViolation[] = [];
  if (!isRecord(input)) {
    return { value: null, violations: [invalid("input", input, "must be an object")] };
  }
  const rawLayers = input.layers;
  if (!isRecord(rawLayers)) {
    violations.push(invalid("layers", rawLayers, "must be an object"));
  }
  const layers = isRecord(rawLayers)
    ? {
        controlled: readLayer(rawLayers, "controlled", violations),
        live: readLayer(rawLayers, "live", violations),
        private: readLayer(rawLayers, "private", violations),
      }
    : { controlled: null, live: null, private: null };

  const truthPassRate = readRate(input, "truthPassRate", violations);
  const falseSuccesses = readCount(input, "falseSuccesses", violations);
  const harnessErrors = readCount(input, "harnessErrors", violations);
  const provenanceCompleteness = readRate(input, "provenanceCompleteness", violations);
  const plannedProviderViolations = readCount(input, "plannedProviderViolations", violations);
  const ledgerMismatches = readCount(input, "ledgerMismatches", violations);
  const budgetViolations = readCount(input, "budgetViolations", violations);
  const policyViolations = readCount(input, "policyViolations", violations);
  const scopeLeaks = readCount(input, "scopeLeaks", violations);
  const pairedBaseline = input.pairedBaseline;
  if (typeof pairedBaseline !== "boolean") {
    violations.push(invalid("pairedBaseline", pairedBaseline, "must be a boolean"));
  }
  const costPerValidDelta = readFiniteNumber(input, "costPerValidDelta", violations);
  const validRateDelta = readFiniteNumber(input, "validRateDelta", violations);

  let productionRollout: BenchmarkGateInput["productionRollout"];
  if (input.productionRollout !== undefined) {
    if (!isRecord(input.productionRollout)) {
      violations.push(invalid("productionRollout", input.productionRollout, "must be an object"));
    } else {
      const percentage = readFiniteNumber(
        input.productionRollout,
        "percentage",
        violations,
        "productionRollout.percentage",
      );
      const consecutiveDays = readCount(
        input.productionRollout,
        "consecutiveDays",
        violations,
        "productionRollout.consecutiveDays",
      );
      if (percentage !== null && (percentage < 0 || percentage > 100)) {
        violations.push(invalid(
          "productionRollout.percentage",
          percentage,
          "must be between 0 and 100",
        ));
      } else if (percentage !== null && consecutiveDays !== null) {
        productionRollout = { percentage, consecutiveDays };
      }
    }
  }

  if (
    violations.length > 0 || layers.controlled === null || layers.live === null ||
    layers.private === null || truthPassRate === null || falseSuccesses === null ||
    harnessErrors === null || provenanceCompleteness === null ||
    plannedProviderViolations === null || ledgerMismatches === null ||
    budgetViolations === null || policyViolations === null || scopeLeaks === null ||
    typeof pairedBaseline !== "boolean" || costPerValidDelta === null || validRateDelta === null
  ) return { value: null, violations };

  return {
    value: {
      layers: {
        controlled: layers.controlled,
        live: layers.live,
        private: layers.private,
      },
      truthPassRate,
      falseSuccesses,
      harnessErrors,
      provenanceCompleteness,
      plannedProviderViolations,
      ledgerMismatches,
      budgetViolations,
      policyViolations,
      scopeLeaks,
      pairedBaseline,
      costPerValidDelta,
      validRateDelta,
      ...(productionRollout === undefined ? {} : { productionRollout }),
    },
    violations,
  };
}

function gateViolation(
  code: BenchmarkGateViolationCode,
  gate: BenchmarkGateViolation["gate"],
  path: string,
  message: string,
  actual: unknown,
  required: unknown,
  severity: BenchmarkGateViolation["severity"] = "gate",
): BenchmarkGateViolation {
  return { code, severity, gate, path, message, actual, required };
}

function minimum(
  violations: BenchmarkGateViolation[],
  gate: "canary" | "release",
  path: string,
  actual: number,
  required: number,
  code: BenchmarkGateViolationCode,
): void {
  if (actual < required) {
    violations.push(gateViolation(
      code,
      gate,
      path,
      `${path} must be at least ${required}`,
      actual,
      required,
    ));
  }
}

export function evaluateBenchmarkGate(input: unknown): BenchmarkGateEvaluation {
  const parsed = parseInput(input);
  if (parsed.value === null) {
    return {
      level: "experimental",
      hardFailed: true,
      gates: { canaryReady: false, releaseCandidate: false, productionProven: false },
      violations: parsed.violations,
    };
  }
  const value = parsed.value;
  const violations = parsed.violations;

  const hardEvidence: Array<{
    path: keyof Pick<BenchmarkGateInput,
      "plannedProviderViolations" | "ledgerMismatches" | "budgetViolations" |
      "policyViolations" | "scopeLeaks">;
    code: BenchmarkGateViolationCode;
  }> = [
    { path: "plannedProviderViolations", code: "PLANNED_PROVIDER_VIOLATION" },
    { path: "ledgerMismatches", code: "LEDGER_MISMATCH" },
    { path: "budgetViolations", code: "BUDGET_VIOLATION" },
    { path: "policyViolations", code: "POLICY_VIOLATION" },
    { path: "scopeLeaks", code: "SCOPE_LEAK" },
  ];
  if (value.provenanceCompleteness !== 1) {
    violations.push(gateViolation(
      "PROVENANCE_INCOMPLETE",
      "hard",
      "provenanceCompleteness",
      "provenance must be complete for every measured run",
      value.provenanceCompleteness,
      1,
      "hard",
    ));
  }
  for (const evidence of hardEvidence) {
    if (value[evidence.path] > 0) {
      violations.push(gateViolation(
        evidence.code,
        "hard",
        evidence.path,
        `${evidence.path} must be zero`,
        value[evidence.path],
        0,
        "hard",
      ));
    }
  }

  minimum(violations, "canary", "layers.controlled.distinctCases",
    value.layers.controlled.distinctCases, 40, "CANARY_CONTROLLED_CASES");
  minimum(violations, "canary", "layers.controlled.minRepeats",
    value.layers.controlled.minRepeats, 5, "CANARY_CONTROLLED_REPEATS");
  minimum(violations, "canary", "layers.live.distinctCases",
    value.layers.live.distinctCases, 10, "CANARY_LIVE_CASES");
  minimum(violations, "canary", "layers.live.minRepeats",
    value.layers.live.minRepeats, 5, "CANARY_LIVE_REPEATS");
  if (value.truthPassRate !== 1) {
    violations.push(gateViolation(
      "TRUTH_NOT_COMPLETE", "canary", "truthPassRate",
      "truthPassRate must equal 1", value.truthPassRate, 1,
    ));
  }
  if (value.falseSuccesses > 0) {
    violations.push(gateViolation(
      "FALSE_SUCCESS_PRESENT", "canary", "falseSuccesses",
      "falseSuccesses must be zero", value.falseSuccesses, 0,
    ));
  }
  if (value.harnessErrors > 0) {
    violations.push(gateViolation(
      "HARNESS_ERROR_PRESENT", "canary", "harnessErrors",
      "harnessErrors must be zero", value.harnessErrors, 0,
    ));
  }

  minimum(violations, "release", "layers.controlled.distinctCases",
    value.layers.controlled.distinctCases, 40, "RELEASE_CONTROLLED_CASES");
  minimum(violations, "release", "layers.controlled.minRepeats",
    value.layers.controlled.minRepeats, 30, "RELEASE_CONTROLLED_REPEATS");
  minimum(violations, "release", "layers.live.distinctCases",
    value.layers.live.distinctCases, 30, "RELEASE_LIVE_CASES");
  minimum(violations, "release", "layers.live.minRepeats",
    value.layers.live.minRepeats, 30, "RELEASE_LIVE_REPEATS");
  minimum(violations, "release", "layers.private.distinctCases",
    value.layers.private.distinctCases, 30, "RELEASE_PRIVATE_CASES");
  minimum(violations, "release", "layers.private.minRepeats",
    value.layers.private.minRepeats, 30, "RELEASE_PRIVATE_REPEATS");
  if (!value.pairedBaseline) {
    violations.push(gateViolation(
      "BASELINE_NOT_PAIRED", "release", "pairedBaseline",
      "release evidence requires a paired baseline", value.pairedBaseline, true,
    ));
  }
  if (value.validRateDelta < 0) {
    violations.push(gateViolation(
      "VALID_RATE_REGRESSION", "release", "validRateDelta",
      "valid result rate must not regress from baseline", value.validRateDelta, ">= 0",
    ));
  }
  if (value.costPerValidDelta > 0.1 && value.validRateDelta < 0.02) {
    violations.push(gateViolation(
      "COST_REGRESSION_UNJUSTIFIED", "release", "costPerValidDelta",
      "cost regression above 10% requires at least 2 percentage points of valid-rate uplift",
      value.costPerValidDelta,
      "<= 0.10 or validRateDelta >= 0.02",
    ));
  }

  if (value.productionRollout === undefined) {
    violations.push(gateViolation(
      "PRODUCTION_ROLLOUT_MISSING", "production", "productionRollout",
      "production proof requires rollout evidence", null,
      { percentage: 100, consecutiveDays: 7 },
    ));
  } else {
    if (value.productionRollout.percentage < 100) {
      violations.push(gateViolation(
        "PRODUCTION_ROLLOUT_INCOMPLETE", "production", "productionRollout.percentage",
        "production proof requires full rollout", value.productionRollout.percentage, 100,
      ));
    }
    if (value.productionRollout.consecutiveDays < 7) {
      violations.push(gateViolation(
        "PRODUCTION_SOAK_TOO_SHORT", "production", "productionRollout.consecutiveDays",
        "production proof requires seven consecutive days", value.productionRollout.consecutiveDays, 7,
      ));
    }
  }

  const hardFailed = violations.some((violation) =>
    violation.gate === "hard" || violation.gate === "input");
  const canaryReady = !hardFailed && !violations.some((violation) => violation.gate === "canary");
  const releaseCandidate = canaryReady && !violations.some((violation) => violation.gate === "release");
  const productionProven = releaseCandidate &&
    !violations.some((violation) => violation.gate === "production");
  const level: BenchmarkMaturityLevel = productionProven
    ? "production-proven"
    : releaseCandidate
      ? "release-candidate"
      : canaryReady
        ? "canary-ready"
        : "experimental";
  return {
    level,
    hardFailed,
    gates: { canaryReady, releaseCandidate, productionProven },
    violations,
  };
}
import { parseBenchmarkCandidate } from "./contract.js";
import type {
  BenchmarkCorpusReport,
  BenchmarkCorpusRun,
  BenchmarkReleaseComparison,
} from "./corpus.js";
