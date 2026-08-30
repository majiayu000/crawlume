import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { defaultExtractorRegistry } from "../../src/extract.js";
import type { RawPage } from "../../src/types.js";
import type { BenchmarkCandidate, BenchmarkEvaluation } from "../harness/contract.js";
import type { BenchmarkCorpusRun } from "../harness/corpus.js";
import type { BenchmarkExecutionCost } from "../harness/metrics.js";

export type ShadowObservation = {
  candidate: BenchmarkCandidate;
  evaluation: BenchmarkEvaluation;
  cost: BenchmarkExecutionCost;
};

export type HttpBrowserShadowPair = {
  category: string;
  primary: ShadowObservation;
  shadow: ShadowObservation;
};

export type HttpBrowserShadowSummary = {
  samples: number;
  primaryValid: number;
  shadowValid: number;
  browserUplift: number;
  falseSuccesses: number;
  browserContextStarts: number;
  browserMilliseconds: number;
  categories: Array<{
    category: string;
    samples: number;
    primaryValid: number;
    shadowValid: number;
    browserUplift: number;
  }>;
};

function shadowCounts(pairs: HttpBrowserShadowPair[]) {
  return {
    samples: pairs.length,
    primaryValid: pairs.filter(({ primary }) => primary.evaluation.passed).length,
    shadowValid: pairs.filter(({ shadow }) => shadow.evaluation.passed).length,
    browserUplift: pairs.filter(
      ({ primary, shadow }) => !primary.evaluation.passed && shadow.evaluation.passed,
    ).length,
  };
}

export function summarizeHttpBrowserShadow(
  pairs: HttpBrowserShadowPair[],
): HttpBrowserShadowSummary {
  if (pairs.length === 0) throw new Error("HTTP/Browser shadow requires at least one pair");
  const categories = [...new Set(pairs.map(({ category }) => category))].sort();
  return {
    ...shadowCounts(pairs),
    falseSuccesses: pairs.filter(
      ({ primary, shadow }) => primary.evaluation.falseSuccess || shadow.evaluation.falseSuccess,
    ).length,
    browserContextStarts: pairs.reduce(
      (sum, { shadow }) => sum + shadow.cost.browserContextStarts,
      0,
    ),
    browserMilliseconds: pairs.reduce(
      (sum, { shadow }) => sum + shadow.cost.browserMilliseconds,
      0,
    ),
    categories: categories.map((category) => ({
      category,
      ...shadowCounts(pairs.filter((pair) => pair.category === category)),
    })),
  };
}

export type RetryCounterfactualReport = {
  runs: number;
  retriedRuns: number;
  noRetryValidRuns: number;
  oneRetryValidRuns: number;
  currentValidRuns: number;
  recoveredRuns: number;
  wastedRuns: number;
  byFirstErrorCode: Array<{
    errorCode: string;
    retriedRuns: number;
    recoveredRuns: number;
    wastedRuns: number;
  }>;
};

function effectiveAttempts(run: BenchmarkCorpusRun) {
  return run.candidate?.provenance.attempts.filter(
    ({ provider, outcome }) => provider !== "cache" && outcome !== "stopped",
  ) ?? [];
}

function isValidArtifact(run: BenchmarkCorpusRun): boolean {
  return run.evaluation.passed && run.candidate?.outcome === "ok";
}

export function analyzeRetryCounterfactual(
  runs: BenchmarkCorpusRun[],
): RetryCounterfactualReport {
  if (runs.length === 0) throw new Error("retry counterfactual requires recorded runs");
  const retryEvidence = runs.flatMap((run) => {
    const attempts = effectiveAttempts(run);
    const stageGroups = new Map<string, typeof attempts>();
    for (const attempt of attempts) {
      const selected = stageGroups.get(attempt.stageId) ?? [];
      selected.push(attempt);
      stageGroups.set(attempt.stageId, selected);
    }
    const retried = [...stageGroups.values()].find((group) => group.length > 1);
    if (retried === undefined) return [];
    const first = retried[0];
    const second = retried[1];
    if (first === undefined) return [];
    const currentValid = isValidArtifact(run);
    const noRetryValid = currentValid && first.outcome === "succeeded";
    const oneRetryValid = currentValid &&
      (first.outcome === "succeeded" || second?.outcome === "succeeded");
    return [{
      errorCode: first.errorCode ?? "NONE",
      currentValid,
      noRetryValid,
      oneRetryValid,
      recovered: !noRetryValid && currentValid,
      wasted: !currentValid,
    }];
  });
  const errorCodes = [...new Set(retryEvidence.map(({ errorCode }) => errorCode))].sort();
  return {
    runs: runs.length,
    retriedRuns: retryEvidence.length,
    noRetryValidRuns: runs.filter((run) => {
      const attempts = effectiveAttempts(run);
      const repeatedStage = attempts.find((attempt, index) =>
        attempts.slice(0, index).some(({ stageId }) => stageId === attempt.stageId));
      return isValidArtifact(run) && repeatedStage === undefined;
    }).length + retryEvidence.filter(({ noRetryValid }) => noRetryValid).length,
    oneRetryValidRuns: runs.filter((run) => {
      const attempts = effectiveAttempts(run);
      const repeatedStage = attempts.find((attempt, index) =>
        attempts.slice(0, index).some(({ stageId }) => stageId === attempt.stageId));
      return isValidArtifact(run) && repeatedStage === undefined;
    }).length + retryEvidence.filter(({ oneRetryValid }) => oneRetryValid).length,
    currentValidRuns: runs.filter(isValidArtifact).length,
    recoveredRuns: retryEvidence.filter(({ recovered }) => recovered).length,
    wastedRuns: retryEvidence.filter(({ wasted }) => wasted).length,
    byFirstErrorCode: errorCodes.map((errorCode) => {
      const selected = retryEvidence.filter((record) => record.errorCode === errorCode);
      return {
        errorCode,
        retriedRuns: selected.length,
        recoveredRuns: selected.filter(({ recovered }) => recovered).length,
        wastedRuns: selected.filter(({ wasted }) => wasted).length,
      };
    }),
  };
}

export type ExtractorTournamentTruth = {
  requiredText: string[];
  forbiddenText: string[];
  minContentCharacters: number;
};

export type ExtractorTournamentReport = {
  rawRef: string;
  durationMs: number;
  candidates: Array<{
    extractorId: string;
    extractorVersion: string;
    extractionMethod: string;
    contentCharacters: number;
    valid: boolean;
    falseSuccess: boolean;
    failedAssertions: string[];
  }>;
  attempts: Array<{
    extractorId: string;
    extractorVersion: string;
    outcome: "candidate" | "not-applicable" | "failed";
    errorCode: string | null;
  }>;
};

export async function runExtractorTournament(
  rawRef: string,
  page: RawPage,
  truth: ExtractorTournamentTruth,
): Promise<ExtractorTournamentReport> {
  if (!/^sha256:[a-f0-9]{64}$/u.test(rawRef)) throw new Error("rawRef must be a sha256 digest");
  if (truth.requiredText.length === 0) throw new Error("extractor truth requires text anchors");
  const startedAt = performance.now();
  const batch = await defaultExtractorRegistry.extractForTournament(page);
  return {
    rawRef,
    durationMs: Math.max(0, performance.now() - startedAt),
    candidates: batch.candidates.map((candidate) => {
      const failures = [
        ...truth.requiredText.filter((text) => !candidate.artifact.markdown.includes(text))
          .map((text) => `missing:${text}`),
        ...truth.forbiddenText.filter((text) => candidate.artifact.markdown.includes(text))
          .map((text) => `forbidden:${text}`),
        ...(candidate.artifact.contentCharacters < truth.minContentCharacters
          ? [`minContentCharacters:${truth.minContentCharacters}`]
          : []),
      ];
      return {
        extractorId: candidate.extractorId,
        extractorVersion: candidate.extractorVersion,
        extractionMethod: candidate.artifact.extractionMethod,
        contentCharacters: candidate.artifact.contentCharacters,
        valid: failures.length === 0,
        falseSuccess: failures.length > 0,
        failedAssertions: failures,
      };
    }),
    attempts: batch.attempts,
  };
}

export type OptimizationDecisions = {
  browserEscalation: string;
  readiness: string;
  retry: string;
  extractor: string;
};

export type PolicyCandidate = {
  schemaVersion: 1;
  policyId: string;
  parentPolicyId: string | null;
  plannerVersion: string;
  evidenceHashes: string[];
  decisions: OptimizationDecisions;
  generatedAt: string;
};

export type PolicyReview = {
  schemaVersion: 1;
  reviewId: string;
  policyId: string;
  reviewer: string;
  decision: "approved" | "rejected";
  reviewedAt: string;
  rationale: string;
};

export type PolicyRelease = {
  schemaVersion: 1;
  releaseId: string;
  policyId: string;
  reviewId: string;
  previousReleaseId: string | null;
};

export type PolicyRollback = {
  schemaVersion: 1;
  rollbackId: string;
  fromReleaseId: string;
  toReleaseId: string;
  requestedBy: string;
  requestedAt: string;
  reason: string;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonical(entry)]));
}

function contentId(prefix: string, value: unknown): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`${field} must be non-empty`);
}

function policyBody(policy: Omit<PolicyCandidate, "policyId">) {
  return {
    schemaVersion: policy.schemaVersion,
    parentPolicyId: policy.parentPolicyId,
    plannerVersion: policy.plannerVersion,
    evidenceHashes: policy.evidenceHashes,
    decisions: policy.decisions,
    generatedAt: policy.generatedAt,
  };
}

function assertPolicyIntegrity(policy: PolicyCandidate): void {
  if (policy.policyId !== contentId("policy", policyBody(policy))) {
    throw new Error("policy artifact integrity check failed");
  }
}

function reviewBody(review: Omit<PolicyReview, "reviewId">) {
  return {
    schemaVersion: review.schemaVersion,
    policyId: review.policyId,
    reviewer: review.reviewer,
    decision: review.decision,
    reviewedAt: review.reviewedAt,
    rationale: review.rationale,
  };
}

function assertReviewIntegrity(review: PolicyReview): void {
  if (review.reviewId !== contentId("review", reviewBody(review))) {
    throw new Error("policy review integrity check failed");
  }
}

function releaseBody(release: Omit<PolicyRelease, "releaseId">) {
  return {
    schemaVersion: release.schemaVersion,
    policyId: release.policyId,
    reviewId: release.reviewId,
    previousReleaseId: release.previousReleaseId,
  };
}

function assertReleaseIntegrity(release: PolicyRelease): void {
  if (release.releaseId !== contentId("release", releaseBody(release))) {
    throw new Error("policy release integrity check failed");
  }
}

export function createPolicyCandidate(input: Omit<PolicyCandidate, "schemaVersion" | "policyId">): PolicyCandidate {
  requireText(input.plannerVersion, "plannerVersion");
  if (input.evidenceHashes.length === 0 || input.evidenceHashes.some(
    (hash) => !/^sha256:[a-f0-9]{64}$/u.test(hash)
  )) throw new Error("evidenceHashes must contain sha256 digests");
  const body = {
    schemaVersion: 1 as const,
    parentPolicyId: input.parentPolicyId,
    plannerVersion: input.plannerVersion,
    evidenceHashes: [...input.evidenceHashes].sort(),
    decisions: input.decisions,
    generatedAt: input.generatedAt,
  };
  return { ...body, policyId: contentId("policy", body) };
}

export function reviewPolicy(
  policy: PolicyCandidate,
  input: Omit<PolicyReview, "schemaVersion" | "reviewId" | "policyId">,
): PolicyReview {
  assertPolicyIntegrity(policy);
  requireText(input.reviewer, "reviewer");
  requireText(input.rationale, "rationale");
  const body = { schemaVersion: 1 as const, policyId: policy.policyId, ...input };
  return { ...body, reviewId: contentId("review", body) };
}

export function releasePolicy(
  policy: PolicyCandidate,
  review: PolicyReview,
  previousReleaseId: string | null,
): PolicyRelease {
  assertPolicyIntegrity(policy);
  assertReviewIntegrity(review);
  if (review.policyId !== policy.policyId || review.decision !== "approved") {
    throw new Error("policy release requires its approved review");
  }
  const body = {
    schemaVersion: 1 as const,
    policyId: policy.policyId,
    reviewId: review.reviewId,
    previousReleaseId,
  };
  return { ...body, releaseId: contentId("release", body) };
}

export function rollbackPolicy(
  current: PolicyRelease,
  target: PolicyRelease,
  releases: PolicyRelease[],
  input: Pick<PolicyRollback, "requestedBy" | "requestedAt" | "reason">,
): PolicyRollback {
  assertReleaseIntegrity(current);
  assertReleaseIntegrity(target);
  for (const release of releases) assertReleaseIntegrity(release);
  requireText(input.requestedBy, "requestedBy");
  requireText(input.reason, "reason");
  const byId = new Map(releases.map((release) => [release.releaseId, release]));
  let ancestorId = current.previousReleaseId;
  while (ancestorId !== null && ancestorId !== target.releaseId) {
    const ancestor = byId.get(ancestorId);
    if (ancestor === undefined) throw new Error("policy release ancestry is incomplete");
    ancestorId = ancestor.previousReleaseId;
  }
  if (ancestorId !== target.releaseId) throw new Error("rollback target must be a released ancestor");
  const body = {
    schemaVersion: 1 as const,
    fromReleaseId: current.releaseId,
    toReleaseId: target.releaseId,
    ...input,
  };
  return { ...body, rollbackId: contentId("rollback", body) };
}
