import type {
  BenchmarkCandidate,
  BenchmarkCase,
  BenchmarkEvaluation,
  CandidateOutcome,
} from "./contract.js";

export type BenchmarkExecutionCost = {
  httpRequests: number;
  networkBytesIn: number;
  browserMilliseconds: number;
  browserContextStarts: number;
  retryAttempts: number;
  retryDelayMilliseconds: number;
  totalDurationMilliseconds: number;
};

export type BenchmarkRunRecord = {
  benchmarkCase: BenchmarkCase;
  candidate: BenchmarkCandidate;
  evaluation: BenchmarkEvaluation;
  cost: BenchmarkExecutionCost;
};

type BenchmarkOutcomeCounts = {
  valid: number;
  uncertain: number;
  invalid: number;
  failed: number;
  policyStop: number;
  unsupported: number;
  harnessError: number;
};

type BenchmarkCategorySummary = {
  category: string;
  runs: number;
  measuredRuns: number;
  eligibleRuns: number;
  validArtifacts: number;
  validResultRate: number | null;
  falseSuccesses: number;
  falseSuccessRate: number | null;
};

export type BenchmarkAggregateSummary = {
  totalRuns: number;
  measuredRuns: number;
  eligibleRuns: number;
  truthPassedRuns: number;
  truthPassRate: number | null;
  outcomes: BenchmarkOutcomeCounts;
  quality: {
    validArtifacts: number;
    returnedOk: number;
    validResultRate: number | null;
    falseSuccesses: number;
    falseSuccessRate: number | null;
    uncertainRate: number | null;
    validLatencyP50Ms: number | null;
    validLatencyP95Ms: number | null;
  };
  browser: {
    starts: number;
    escalationRate: number | null;
    recoveredAfterHttp: number;
    uplift: number | null;
  };
  retry: {
    retriedRuns: number;
    recoveredRuns: number;
    wastedRuns: number;
    recoveryRate: number | null;
    wasteRate: number | null;
  };
  totalCost: BenchmarkExecutionCost;
  costPerValidArtifact: BenchmarkExecutionCost | null;
  categories: BenchmarkCategorySummary[];
};

type ClassifiedRecord = BenchmarkRunRecord & {
  eligible: boolean;
  measured: boolean;
  outcome: keyof BenchmarkOutcomeCounts;
  validArtifact: boolean;
};

type FailureCostDetails = Record<string, boolean | number | string | null>;

const countCostFields = new Set<keyof BenchmarkExecutionCost>([
  "httpRequests",
  "browserContextStarts",
  "retryAttempts",
]);

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function emptyCost(): BenchmarkExecutionCost {
  return {
    httpRequests: 0,
    networkBytesIn: 0,
    browserMilliseconds: 0,
    browserContextStarts: 0,
    retryAttempts: 0,
    retryDelayMilliseconds: 0,
    totalDurationMilliseconds: 0,
  };
}

function assertCost(cost: BenchmarkExecutionCost): void {
  for (const [field, value] of Object.entries(cost) as Array<
    [keyof BenchmarkExecutionCost, number]
  >) {
    const valid = Number.isFinite(value) && value >= 0 &&
      (!countCostFields.has(field) || Number.isSafeInteger(value));
    if (!valid) {
      throw new Error(`cost.${field} must be a finite non-negative${
        countCostFields.has(field) ? " integer" : " number"
      }`);
    }
  }
}

function detailNumber(
  details: FailureCostDetails,
  field: string,
): number {
  const value = details[field];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function executionCostForBenchmarkRun(
  candidate: BenchmarkCandidate,
  totalDurationMilliseconds: number,
  failureDetails: FailureCostDetails = {},
): BenchmarkExecutionCost {
  if (candidate.outcome === "ok" && candidate.artifact === undefined) {
    throw new Error("ok benchmark candidates require an artifact");
  }
  const artifact = candidate.artifact;
  const cost = candidate.outcome === "ok" && artifact !== undefined
    ? {
        httpRequests: artifact.evidence.fetchAttempts.http,
        networkBytesIn:
          artifact.evidence.responseBytesByMethod.http +
          artifact.evidence.responseBytesByMethod.browser,
        browserMilliseconds: artifact.evidence.fetchDurationMsByMethod.browser,
        browserContextStarts: artifact.evidence.fetchAttempts.browser,
        retryAttempts: Math.max(0, artifact.evidence.attempts - 1),
        retryDelayMilliseconds: artifact.evidence.totalRetryDelayMs,
        totalDurationMilliseconds,
      }
    : {
        httpRequests: detailNumber(failureDetails, "httpFetchAttempts"),
        networkBytesIn:
          detailNumber(failureDetails, "httpResponseBytes") +
          detailNumber(failureDetails, "browserResponseBytes"),
        browserMilliseconds: detailNumber(failureDetails, "browserFetchDurationMs"),
        browserContextStarts: detailNumber(failureDetails, "browserFetchAttempts"),
        retryAttempts: Math.max(0, detailNumber(failureDetails, "attempts") - 1),
        retryDelayMilliseconds: detailNumber(failureDetails, "totalRetryDelayMs"),
        totalDurationMilliseconds,
      };
  assertCost(cost);
  return cost;
}

function addCost(total: BenchmarkExecutionCost, cost: BenchmarkExecutionCost): void {
  total.httpRequests += cost.httpRequests;
  total.networkBytesIn += cost.networkBytesIn;
  total.browserMilliseconds += cost.browserMilliseconds;
  total.browserContextStarts += cost.browserContextStarts;
  total.retryAttempts += cost.retryAttempts;
  total.retryDelayMilliseconds += cost.retryDelayMilliseconds;
  total.totalDurationMilliseconds += cost.totalDurationMilliseconds;
}

function divideCost(cost: BenchmarkExecutionCost, divisor: number): BenchmarkExecutionCost {
  return {
    httpRequests: cost.httpRequests / divisor,
    networkBytesIn: cost.networkBytesIn / divisor,
    browserMilliseconds: cost.browserMilliseconds / divisor,
    browserContextStarts: cost.browserContextStarts / divisor,
    retryAttempts: cost.retryAttempts / divisor,
    retryDelayMilliseconds: cost.retryDelayMilliseconds / divisor,
    totalDurationMilliseconds: cost.totalDurationMilliseconds / divisor,
  };
}

function terminalExpectedOutcome(benchmarkCase: BenchmarkCase): CandidateOutcome | null {
  for (const assertion of benchmarkCase.truth.required) {
    if (assertion.type === "outcome_equals") return assertion.value;
  }
  return null;
}

function classify(record: BenchmarkRunRecord): ClassifiedRecord {
  if (record.evaluation.caseId !== record.benchmarkCase.id) {
    throw new Error("evaluation.caseId must match benchmarkCase.id");
  }
  assertCost(record.cost);
  const measured = record.evaluation.outcome !== "harness_error";
  const expectedOutcome = terminalExpectedOutcome(record.benchmarkCase);
  const eligible = measured && expectedOutcome !== "policy_stop" && expectedOutcome !== "unsupported";
  const validArtifact = eligible && record.evaluation.passed && record.candidate.outcome === "ok";
  let outcome: keyof BenchmarkOutcomeCounts;
  if (!measured) outcome = "harnessError";
  else if (validArtifact) outcome = "valid";
  else if (record.evaluation.outcome === "uncertain") outcome = "uncertain";
  else if (record.candidate.outcome === "ok") outcome = "invalid";
  else if (record.candidate.outcome === "policy_stop") outcome = "policyStop";
  else outcome = record.candidate.outcome;
  return { ...record, eligible, measured, outcome, validArtifact };
}

function quantile(sortedValues: number[], quantileValue: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.max(0, Math.ceil(quantileValue * sortedValues.length) - 1);
  return sortedValues[index] ?? null;
}

function categorySummary(category: string, records: ClassifiedRecord[]): BenchmarkCategorySummary {
  const selected = records.filter((record) => record.benchmarkCase.category === category);
  const measured = selected.filter((record) => record.measured);
  const eligible = selected.filter((record) => record.eligible);
  const validArtifacts = eligible.filter((record) => record.validArtifact).length;
  const returnedOk = measured.filter((record) => record.candidate.outcome === "ok").length;
  const falseSuccesses = measured.filter((record) => record.evaluation.falseSuccess).length;
  return {
    category,
    runs: selected.length,
    measuredRuns: measured.length,
    eligibleRuns: eligible.length,
    validArtifacts,
    validResultRate: rate(validArtifacts, eligible.length),
    falseSuccesses,
    falseSuccessRate: rate(falseSuccesses, returnedOk),
  };
}

export function aggregateBenchmarkRuns(
  rawRecords: BenchmarkRunRecord[],
): BenchmarkAggregateSummary {
  if (rawRecords.length === 0) {
    throw new Error("at least one benchmark run is required");
  }
  const records = rawRecords.map(classify);
  const measured = records.filter((record) => record.measured);
  const eligible = records.filter((record) => record.eligible);
  const valid = eligible.filter((record) => record.validArtifact);
  const returnedOk = measured.filter((record) => record.candidate.outcome === "ok");
  const falseSuccesses = measured.filter((record) => record.evaluation.falseSuccess).length;
  const truthPassedRuns = measured.filter((record) => record.evaluation.passed).length;
  const browserRuns = eligible.filter((record) => record.cost.browserContextStarts > 0);
  const browserRecovered = browserRuns.filter((record) =>
    record.validArtifact && record.candidate.outcome === "ok" &&
    record.candidate.artifact !== undefined &&
    record.candidate.artifact.evidence.fetchAttempts.http > 0 &&
    record.candidate.artifact.evidence.fetchAttempts.browser > 0
  );
  const retried = eligible.filter((record) => record.cost.retryAttempts > 0);
  const retryRecovered = retried.filter((record) => record.validArtifact);
  const totalCost = emptyCost();
  for (const record of measured) addCost(totalCost, record.cost);
  const outcomes: BenchmarkOutcomeCounts = {
    valid: 0,
    uncertain: 0,
    invalid: 0,
    failed: 0,
    policyStop: 0,
    unsupported: 0,
    harnessError: 0,
  };
  for (const record of records) outcomes[record.outcome] += 1;
  const validLatencies = valid
    .map((record) => record.cost.totalDurationMilliseconds)
    .sort((left, right) => left - right);
  const categories = [...new Set(records.map((record) => record.benchmarkCase.category))]
    .sort((left, right) => left.localeCompare(right))
    .map((category) => categorySummary(category, records));
  return {
    totalRuns: records.length,
    measuredRuns: measured.length,
    eligibleRuns: eligible.length,
    truthPassedRuns,
    truthPassRate: rate(truthPassedRuns, measured.length),
    outcomes,
    quality: {
      validArtifacts: valid.length,
      returnedOk: returnedOk.length,
      validResultRate: rate(valid.length, eligible.length),
      falseSuccesses,
      falseSuccessRate: rate(falseSuccesses, returnedOk.length),
      uncertainRate: rate(outcomes.uncertain, eligible.length),
      validLatencyP50Ms: quantile(validLatencies, 0.5),
      validLatencyP95Ms: quantile(validLatencies, 0.95),
    },
    browser: {
      starts: browserRuns.reduce((sum, record) => sum + record.cost.browserContextStarts, 0),
      escalationRate: rate(browserRuns.length, eligible.length),
      recoveredAfterHttp: browserRecovered.length,
      uplift: rate(browserRecovered.length, browserRuns.length),
    },
    retry: {
      retriedRuns: retried.length,
      recoveredRuns: retryRecovered.length,
      wastedRuns: retried.length - retryRecovered.length,
      recoveryRate: rate(retryRecovered.length, retried.length),
      wasteRate: rate(retried.length - retryRecovered.length, retried.length),
    },
    totalCost,
    costPerValidArtifact: valid.length === 0 ? null : divideCost(totalCost, valid.length),
    categories,
  };
}
