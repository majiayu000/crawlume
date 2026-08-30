import { describe, expect, it } from "vitest";

import {
  evaluateBenchmarkGate,
  type BenchmarkGateInput,
} from "../benchmarks/harness/gates.js";

function gateInput(overrides: Partial<BenchmarkGateInput> = {}): BenchmarkGateInput {
  return {
    layers: {
      controlled: { distinctCases: 40, minRepeats: 5 },
      live: { distinctCases: 10, minRepeats: 5 },
      private: { distinctCases: 0, minRepeats: 0 },
    },
    truthPassRate: 1,
    falseSuccesses: 0,
    harnessErrors: 0,
    provenanceCompleteness: 1,
    plannedProviderViolations: 0,
    ledgerMismatches: 0,
    budgetViolations: 0,
    policyViolations: 0,
    scopeLeaks: 0,
    pairedBaseline: false,
    costPerValidDelta: 0,
    validRateDelta: 0,
    ...overrides,
  };
}

function releaseInput(overrides: Partial<BenchmarkGateInput> = {}): BenchmarkGateInput {
  return gateInput({
    layers: {
      controlled: { distinctCases: 40, minRepeats: 30 },
      live: { distinctCases: 30, minRepeats: 30 },
      private: { distinctCases: 30, minRepeats: 30 },
    },
    pairedBaseline: true,
    ...overrides,
  });
}

describe("benchmark production gates", () => {
  it("classifies the exact first production-like corpus as canary-ready", () => {
    const result = evaluateBenchmarkGate(gateInput());

    expect(result).toMatchObject({
      level: "canary-ready",
      hardFailed: false,
      gates: {
        canaryReady: true,
        releaseCandidate: false,
        productionProven: false,
      },
    });
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "RELEASE_CONTROLLED_REPEATS" }),
      expect.objectContaining({ code: "PRODUCTION_ROLLOUT_MISSING" }),
    ]));
  });

  it("requires the release corpus and a paired non-regressing baseline", () => {
    expect(evaluateBenchmarkGate(releaseInput())).toMatchObject({
      level: "release-candidate",
      gates: { canaryReady: true, releaseCandidate: true, productionProven: false },
    });

    const unpaired = evaluateBenchmarkGate(releaseInput({ pairedBaseline: false }));
    expect(unpaired.level).toBe("canary-ready");
    expect(unpaired.violations).toContainEqual(expect.objectContaining({
      code: "BASELINE_NOT_PAIRED",
      path: "pairedBaseline",
    }));

    const regressed = evaluateBenchmarkGate(releaseInput({ validRateDelta: -0.001 }));
    expect(regressed.level).toBe("canary-ready");
    expect(regressed.violations).toContainEqual(expect.objectContaining({
      code: "VALID_RATE_REGRESSION",
    }));
  });

  it("accepts a cost regression over ten percent only with two points of valid-rate uplift", () => {
    const insufficient = evaluateBenchmarkGate(releaseInput({
      costPerValidDelta: 0.101,
      validRateDelta: 0.019,
    }));
    expect(insufficient.level).toBe("canary-ready");
    expect(insufficient.violations).toContainEqual(expect.objectContaining({
      code: "COST_REGRESSION_UNJUSTIFIED",
    }));

    expect(evaluateBenchmarkGate(releaseInput({
      costPerValidDelta: 0.101,
      validRateDelta: 0.02,
    })).level).toBe("release-candidate");
  });

  it("requires seven consecutive days at full rollout for production-proven", () => {
    expect(evaluateBenchmarkGate(releaseInput({
      productionRollout: { percentage: 100, consecutiveDays: 7 },
    }))).toMatchObject({
      level: "production-proven",
      gates: { canaryReady: true, releaseCandidate: true, productionProven: true },
    });

    const partial = evaluateBenchmarkGate(releaseInput({
      productionRollout: { percentage: 99, consecutiveDays: 7 },
    }));
    expect(partial.level).toBe("release-candidate");
    expect(partial.violations).toContainEqual(expect.objectContaining({
      code: "PRODUCTION_ROLLOUT_INCOMPLETE",
    }));

    const short = evaluateBenchmarkGate(releaseInput({
      productionRollout: { percentage: 100, consecutiveDays: 6 },
    }));
    expect(short.level).toBe("release-candidate");
    expect(short.violations).toContainEqual(expect.objectContaining({
      code: "PRODUCTION_SOAK_TOO_SHORT",
    }));
  });

  it.each([
    ["provenanceCompleteness", 0.999, "PROVENANCE_INCOMPLETE"],
    ["plannedProviderViolations", 1, "PLANNED_PROVIDER_VIOLATION"],
    ["ledgerMismatches", 1, "LEDGER_MISMATCH"],
    ["budgetViolations", 1, "BUDGET_VIOLATION"],
    ["policyViolations", 1, "POLICY_VIOLATION"],
    ["scopeLeaks", 1, "SCOPE_LEAK"],
  ] as const)("hard-fails on %s", (field, value, code) => {
    const result = evaluateBenchmarkGate(gateInput({ [field]: value }));

    expect(result).toMatchObject({ level: "experimental", hardFailed: true });
    expect(result.violations).toContainEqual(expect.objectContaining({ code, severity: "hard" }));
  });

  it("blocks canary readiness on any false success or harness error", () => {
    const falseSuccess = evaluateBenchmarkGate(gateInput({ falseSuccesses: 1 }));
    expect(falseSuccess.level).toBe("experimental");
    expect(falseSuccess.violations).toContainEqual(expect.objectContaining({
      code: "FALSE_SUCCESS_PRESENT",
    }));

    const harnessError = evaluateBenchmarkGate(gateInput({ harnessErrors: 1 }));
    expect(harnessError.level).toBe("experimental");
    expect(harnessError.violations).toContainEqual(expect.objectContaining({
      code: "HARNESS_ERROR_PRESENT",
    }));
  });

  it("reports missing required evidence instead of defaulting it to zero", () => {
    const incomplete = { ...gateInput() } as Record<string, unknown>;
    delete incomplete.ledgerMismatches;

    const result = evaluateBenchmarkGate(incomplete);

    expect(result).toMatchObject({ level: "experimental", hardFailed: true });
    expect(result.violations).toContainEqual(expect.objectContaining({
      code: "INVALID_INPUT",
      path: "ledgerMismatches",
      severity: "hard",
    }));
  });
});
