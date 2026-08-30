import { z } from "zod";

import { errorCodes } from "../../src/errors.js";
import type {
  AccessPlanEvidence,
  AttemptProjection,
  AttemptRecord,
  BrowserReadinessEvidence,
  PageReadArtifact,
  ResourceUsage,
} from "../../src/types.js";

export const benchmarkProtocolVersion = 1 as const;

export type RunnerResult = {
  protocolVersion: typeof benchmarkProtocolVersion;
  runner: string;
  language: string;
  runtime: string;
  engine: string;
  seedUrl: string;
  expectedPages: number;
  concurrency: number;
  visitedPages: number;
  validPages: number;
  failedPages: number;
  duplicateFetches: number;
  bytesReceived: number;
  crawlDurationMs: number;
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
  return value;
}

function requirePositiveInteger(record: Record<string, unknown>, field: string): number {
  const value = requireNonNegativeNumber(record, field);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeInteger(record: Record<string, unknown>, field: string): number {
  const value = requireNonNegativeNumber(record, field);
  if (!Number.isInteger(value)) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

export function validateRunnerResult(value: unknown): RunnerResult {
  if (!isJsonObject(value)) {
    throw new Error("runner result must be a JSON object");
  }
  if (value.protocolVersion !== benchmarkProtocolVersion) {
    throw new Error(`protocolVersion must equal ${benchmarkProtocolVersion}`);
  }

  const result: RunnerResult = {
    protocolVersion: benchmarkProtocolVersion,
    runner: requireString(value, "runner"),
    language: requireString(value, "language"),
    runtime: requireString(value, "runtime"),
    engine: requireString(value, "engine"),
    seedUrl: requireString(value, "seedUrl"),
    expectedPages: requirePositiveInteger(value, "expectedPages"),
    concurrency: requirePositiveInteger(value, "concurrency"),
    visitedPages: requireNonNegativeInteger(value, "visitedPages"),
    validPages: requireNonNegativeInteger(value, "validPages"),
    failedPages: requireNonNegativeInteger(value, "failedPages"),
    duplicateFetches: requireNonNegativeInteger(value, "duplicateFetches"),
    bytesReceived: requireNonNegativeInteger(value, "bytesReceived"),
    crawlDurationMs: requireNonNegativeNumber(value, "crawlDurationMs"),
  };

  if (result.validPages > result.visitedPages) {
    throw new Error("validPages cannot exceed visitedPages");
  }
  if (result.failedPages > result.visitedPages) {
    throw new Error("failedPages cannot exceed visitedPages");
  }
  if (result.validPages + result.failedPages !== result.visitedPages) {
    throw new Error("validPages + failedPages must equal visitedPages");
  }
  return result;
}

export function parseRunnerStdout(stdout: string): RunnerResult {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length !== 1) {
    throw new Error("runner stdout must contain exactly one non-empty JSON line");
  }
  const line = lines[0];
  if (line === undefined) {
    throw new Error("runner stdout did not contain a result");
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (cause) {
    throw new Error("runner stdout was not valid JSON", { cause });
  }
  return validateRunnerResult(value);
}

const candidateOutcomes = ["ok", "failed", "policy_stop", "unsupported"] as const;
const httpUrl = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "input URL must use HTTP or HTTPS");
const requiredAssertionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("outcome_equals"), value: z.enum(candidateOutcomes) }).strict(),
  z.object({ type: z.literal("error_code_equals"), value: z.string().min(1) }).strict(),
  z.object({ type: z.literal("title_equals"), value: z.string().min(1) }).strict(),
  z.object({ type: z.literal("final_url_equals"), value: httpUrl }).strict(),
  z.object({ type: z.literal("contains_text"), value: z.string().min(1) }).strict(),
  z.object({ type: z.literal("min_content_characters"), value: z.int().nonnegative() }).strict(),
  z.object({ type: z.literal("http_status_equals"), value: z.int().min(100).max(599) }).strict(),
  z.object({ type: z.literal("content_type_starts_with"), value: z.string().min(1) }).strict(),
  z.object({ type: z.literal("fetch_method_equals"), value: z.enum(["http", "browser"]) }).strict(),
  z.object({
    type: z.literal("word_f1_at_least"),
    reference: z.string().min(1),
    value: z.number().min(0).max(1),
  }).strict(),
]);
const forbiddenAssertionSchema = z.object({
  type: z.literal("contains_text"),
  value: z.string().min(1),
}).strict();

export const benchmarkCaseSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  layer: z.enum(["fixture", "controlled", "live"]),
  category: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  input: z.object({
    url: httpUrl,
    intent: z.enum(["read", "crawl"]),
    freshnessSeconds: z.int().nonnegative(),
  }).strict(),
  policy: z.object({
    browserAllowed: z.boolean(),
    authProfile: z.string().min(1).nullable(),
    maxAttempts: z.int().positive(),
    maxDurationMs: z.int().positive(),
    maxBrowserMs: z.int().nonnegative(),
  }).strict(),
  truth: z.object({
    required: z.array(requiredAssertionSchema).min(1),
    forbidden: z.array(forbiddenAssertionSchema),
  }).strict(),
  reviewedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
}).strict().superRefine((value, context) => {
  const issue = (path: string[], message: string): void => {
    context.addIssue({ code: "custom", path, message });
  };
  if (value.layer === "live" && value.expiresAt === null) {
    issue(["expiresAt"], "live cases require expiresAt");
  }
  if (value.policy.authProfile !== null && !value.policy.browserAllowed) {
    issue(["policy", "authProfile"], "authProfile requires browserAllowed");
  }
  if (!value.policy.browserAllowed && value.policy.maxBrowserMs !== 0) {
    issue(["policy", "maxBrowserMs"], "maxBrowserMs must be zero when browser is disallowed");
  }
  if (value.expiresAt !== null && Date.parse(value.expiresAt) <= Date.parse(value.reviewedAt)) {
    issue(["expiresAt"], "expiresAt must be later than reviewedAt");
  }
});

export type BenchmarkCase = z.infer<typeof benchmarkCaseSchema>;
type RequiredAssertion = z.infer<typeof requiredAssertionSchema>;
type ForbiddenAssertion = z.infer<typeof forbiddenAssertionSchema>;
export type CandidateOutcome = (typeof candidateOutcomes)[number];

export function parseBenchmarkCase(value: unknown): BenchmarkCase {
  return benchmarkCaseSchema.parse(value);
}

export type BenchmarkArtifact = {
  sourceUrl: string;
  finalUrl: string;
  title: string;
  content: string;
  contentHash: string;
  fetchedAt: string;
  fetchMethod: "http" | "browser";
  cached: boolean;
  discoveredUrls: string[];
  evidence: {
    httpStatus: number;
    contentType: string;
    responseBytes: number;
    attempts: number;
    retryAttempts: number;
    totalRetryDelayMs: number;
    fetchAttempts: Record<"http" | "browser", number>;
    responseBytesByMethod: Record<"http" | "browser", number>;
    fetchDurationMsByMethod: Record<"http" | "browser", number>;
    browserReadiness?: BrowserReadinessEvidence | undefined;
  };
};

export type BenchmarkCandidate = {
  outcome: CandidateOutcome;
  provenance: BenchmarkExecutionProvenance;
  artifact?: BenchmarkArtifact | undefined;
  errorCode?: string | undefined;
};

export type BenchmarkExecutionProvenance = {
  schemaVersion: 1;
  requestId: string;
  plan: Omit<AccessPlanEvidence, "executedStages">;
  executedStages: string[];
  attempts: Array<Pick<
    AttemptRecord,
    "sequence" | "stageId" | "provider" | "providerVersion" | "outcome" | "errorCode" |
    "usage" | "startedAt" | "completedAt"
  >>;
  projection: Omit<AttemptProjection, "requestId">;
};

const usageSchema = z.object({
  documentBytesIn: z.int().nonnegative(),
  networkBytesOut: z.int().nonnegative(),
  browserMilliseconds: z.number().nonnegative(),
  browserContextStarts: z.int().nonnegative(),
  retryDelayMilliseconds: z.number().nonnegative(),
  optionalModelTokens: z.int().nonnegative(),
}).strict();

const provenanceSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: z.string().min(1),
  plan: z.object({
    planId: z.string().regex(/^plan_[a-f0-9]{64}$/u),
    plannerVersion: z.string().min(1),
    plannedStages: z.array(z.object({
      stageId: z.string().min(1),
      provider: z.enum(["cache", "http", "browser", "feed", "pdf", "adapter"]),
      reasonCode: z.enum([
        "CACHE_ONLY", "CACHE_PREFERRED", "HTTP_PRIMARY", "BROWSER_PRIMARY_HTTP_UNAVAILABLE",
        "BROWSER_REQUIRED_BY_AUTHORIZATION", "BROWSER_REQUIRED_BY_COMPLETION",
        "BROWSER_AFTER_INCOMPLETE_HTTP",
      ]),
    }).strict()).min(1),
  }).strict(),
  executedStages: z.array(z.string().min(1)).min(1),
  attempts: z.array(z.object({
    sequence: z.int().positive(),
    stageId: z.string().min(1),
    provider: z.enum(["cache", "http", "browser", "feed", "pdf", "adapter"]),
    providerVersion: z.string().min(1),
    outcome: z.enum(["succeeded", "failed", "stopped", "cancelled"]),
    errorCode: z.enum(errorCodes).nullable(),
    usage: usageSchema,
    startedAt: z.iso.datetime({ offset: true }),
    completedAt: z.iso.datetime({ offset: true }),
  }).strict()).min(1),
  projection: z.object({
    attempts: z.int().positive(),
    lastSequence: z.int().positive(),
    lastOutcome: z.enum(["succeeded", "failed", "stopped", "cancelled"]),
    lastStageId: z.string().min(1),
    usage: usageSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  const planned = new Map(value.plan.plannedStages.map((stage) => [stage.stageId, stage]));
  if (planned.size !== value.plan.plannedStages.length) {
    context.addIssue({ code: "custom", path: ["plan", "plannedStages"], message: "stage ids must be unique" });
  }
  const plannedOrder = value.plan.plannedStages.map(({ stageId }) => stageId);
  let previousIndex = -1;
  for (const [index, stageId] of value.executedStages.entries()) {
    const plannedIndex = plannedOrder.indexOf(stageId);
    if (plannedIndex <= previousIndex) {
      context.addIssue({ code: "custom", path: ["executedStages", index], message: "must be an ordered planned-stage subsequence" });
    }
    previousIndex = plannedIndex;
  }
  const usage = Object.fromEntries(Object.keys(value.projection.usage).map((field) => [field, 0])) as ResourceUsage;
  const firstStages: string[] = [];
  for (const [index, attempt] of value.attempts.entries()) {
    const stage = planned.get(attempt.stageId);
    if (attempt.sequence !== index + 1 || stage?.provider !== attempt.provider) {
      context.addIssue({ code: "custom", path: ["attempts", index], message: "attempt sequence/provider does not match plan" });
    }
    if (firstStages.at(-1) !== attempt.stageId) firstStages.push(attempt.stageId);
    for (const field of Object.keys(usage) as Array<keyof ResourceUsage>) usage[field] += attempt.usage[field];
  }
  if (JSON.stringify(firstStages) !== JSON.stringify(value.executedStages)) {
    context.addIssue({ code: "custom", path: ["executedStages"], message: "executed stages do not match ledger" });
  }
  const last = value.attempts.at(-1)!;
  if (
    value.projection.attempts !== value.attempts.length ||
    value.projection.lastSequence !== last.sequence ||
    value.projection.lastOutcome !== last.outcome ||
    value.projection.lastStageId !== last.stageId ||
    JSON.stringify(value.projection.usage) !== JSON.stringify(usage)
  ) {
    context.addIssue({ code: "custom", path: ["projection"], message: "projection does not match attempts" });
  }
});

const benchmarkArtifactSchema = z.object({
  sourceUrl: httpUrl,
  finalUrl: httpUrl,
  title: z.string(),
  content: z.string(),
  contentHash: z.string().min(1),
  fetchedAt: z.iso.datetime({ offset: true }),
  fetchMethod: z.enum(["http", "browser"]),
  cached: z.boolean(),
  discoveredUrls: z.array(httpUrl),
  evidence: z.object({
    httpStatus: z.int().min(100).max(599),
    contentType: z.string().min(1),
    responseBytes: z.int().nonnegative(),
    attempts: z.int().positive(),
    retryAttempts: z.int().nonnegative(),
    totalRetryDelayMs: z.int().nonnegative(),
    fetchAttempts: z.object({
      http: z.int().nonnegative(),
      browser: z.int().nonnegative(),
    }).strict(),
    responseBytesByMethod: z.object({
      http: z.int().nonnegative(),
      browser: z.int().nonnegative(),
    }).strict(),
    fetchDurationMsByMethod: z.object({
      http: z.number().nonnegative(),
      browser: z.number().nonnegative(),
    }).strict(),
    browserReadiness: z.object({
      policy: z.enum(["generic", "target"]),
      waitedMs: z.int().nonnegative(),
      reason: z.enum([
        "meaningful-content-stable",
        "short-page-grace-elapsed",
        "target-condition-met",
      ]),
      textCharacters: z.int().nonnegative(),
      targetMatches: z.int().nonnegative().optional(),
      interaction: z.literal("scroll-to-end").optional(),
      interactionSteps: z.int().nonnegative().optional(),
    }).strict().optional(),
  }).strict(),
}).strict();
const benchmarkCandidateSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("ok"),
    provenance: provenanceSchema,
    artifact: benchmarkArtifactSchema,
    errorCode: z.never().optional(),
  }).strict(),
  z.object({
    outcome: z.enum(["failed", "policy_stop", "unsupported"]),
    provenance: provenanceSchema,
    artifact: z.never().optional(),
    errorCode: z.string().min(1).optional(),
  }).strict(),
]).superRefine((candidate, context) => {
  if (
    candidate.outcome === "ok" && candidate.artifact.fetchMethod === "browser" &&
    candidate.artifact.evidence.browserReadiness === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["artifact", "evidence", "browserReadiness"],
      message: "browser candidates require readiness provenance",
    });
  }
});

export function executionProvenanceFromLedger(
  requestId: string,
  accessPlan: AccessPlanEvidence,
  attempts: AttemptRecord[],
  projection: AttemptProjection | null,
): BenchmarkExecutionProvenance {
  if (projection === null || projection.requestId !== requestId || attempts.length === 0) {
    throw new Error("benchmark execution requires a complete ledger projection");
  }
  for (const attempt of attempts) {
    if (attempt.requestId !== requestId || attempt.planId !== accessPlan.planId) {
      throw new Error("benchmark ledger identity does not match execution plan");
    }
  }
  return provenanceSchema.parse({
    schemaVersion: 1,
    requestId,
    plan: {
      planId: accessPlan.planId,
      plannerVersion: accessPlan.plannerVersion,
      plannedStages: accessPlan.plannedStages,
    },
    executedStages: accessPlan.executedStages,
    attempts: attempts.map((attempt) => ({
      sequence: attempt.sequence,
      stageId: attempt.stageId,
      provider: attempt.provider,
      providerVersion: attempt.providerVersion,
      outcome: attempt.outcome,
      errorCode: attempt.errorCode,
      usage: attempt.usage,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt,
    })),
    projection: {
      attempts: projection.attempts,
      lastSequence: projection.lastSequence,
      lastOutcome: projection.lastOutcome,
      lastStageId: projection.lastStageId,
      usage: projection.usage,
    },
  });
}

export function candidateFromPageArtifact(
  artifact: PageReadArtifact,
  attempts: AttemptRecord[],
  projection: AttemptProjection | null,
): BenchmarkCandidate {
  const evidenceAttempts = artifact.evidence.attempts;
  const retryAttempts = artifact.evidence.retryAttempts;
  const totalRetryDelayMs = artifact.evidence.totalRetryDelayMs;
  const fetchAttempts = artifact.evidence.fetchAttempts;
  const responseBytesByMethod = artifact.evidence.responseBytesByMethod;
  const fetchDurationMsByMethod = artifact.evidence.fetchDurationMsByMethod;
  const browserReadiness = artifact.evidence.browserReadiness;
  if (
    evidenceAttempts === undefined || retryAttempts === undefined || totalRetryDelayMs === undefined ||
    fetchAttempts === undefined || responseBytesByMethod === undefined ||
    fetchDurationMsByMethod === undefined
  ) {
    throw new Error("benchmark artifacts require complete fetch provenance");
  }
  return {
    outcome: "ok",
    provenance: executionProvenanceFromLedger(
      artifact.evidence.requestId,
      artifact.evidence.accessPlan,
      attempts,
      projection,
    ),
    artifact: {
      sourceUrl: artifact.sourceUrl,
      finalUrl: artifact.finalUrl,
      title: artifact.title,
      content: artifact.contentMarkdown,
      contentHash: artifact.contentHash,
      fetchedAt: artifact.fetchedAt,
      fetchMethod: artifact.fetchMethod,
      cached: artifact.cached,
      discoveredUrls: artifact.discoveredLinks,
      evidence: {
        httpStatus: artifact.evidence.httpStatus,
        contentType: artifact.evidence.contentType,
        responseBytes: artifact.evidence.responseBytes,
        attempts: evidenceAttempts,
        retryAttempts,
        totalRetryDelayMs,
        fetchAttempts,
        responseBytesByMethod,
        fetchDurationMsByMethod,
        ...(browserReadiness === undefined ? {} : { browserReadiness }),
      },
    },
  };
}

export type WordOverlapMetrics = { precision: number; recall: number; f1: number };
export type AssertionEvaluation = {
  type: RequiredAssertion["type"] | ForbiddenAssertion["type"];
  polarity: "required" | "forbidden";
  passed: boolean;
  expected: string | number;
  actual: string | number | null;
  metrics?: WordOverlapMetrics;
};
export type BenchmarkEvaluation = {
  caseId: string;
  outcome: "valid" | "uncertain" | "invalid" | "harness_error";
  passed: boolean;
  falseSuccess: boolean;
  reason: "all_assertions_passed" | "assertion_indeterminate" | "assertion_failed" |
    "case_expired" | "malformed_candidate";
  assertions: AssertionEvaluation[];
};

function normalizedText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function wordTokens(value: string): string[] {
  return Array.from(
    normalizedText(value).toLowerCase().matchAll(/\p{Script=Han}|[\p{L}\p{N}]+/gu),
    (match) => match[0],
  );
}

function tokenCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

export function wordOverlap(candidate: string, reference: string): WordOverlapMetrics {
  const candidateTokens = wordTokens(candidate);
  const referenceTokens = wordTokens(reference);
  const candidateCounts = tokenCounts(candidateTokens);
  const referenceCounts = tokenCounts(referenceTokens);
  let overlap = 0;
  for (const [token, count] of candidateCounts) {
    overlap += Math.min(count, referenceCounts.get(token) ?? 0);
  }
  const precision = candidateTokens.length === 0 ? 0 : overlap / candidateTokens.length;
  const recall = referenceTokens.length === 0 ? 1 : overlap / referenceTokens.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

function assertionResult(
  assertion: RequiredAssertion | ForbiddenAssertion,
  polarity: "required" | "forbidden",
  passed: boolean,
  expected: string | number,
  actual: string | number | null,
  metrics?: WordOverlapMetrics,
): AssertionEvaluation {
  return {
    type: assertion.type,
    polarity,
    passed,
    expected,
    actual,
    ...(metrics === undefined ? {} : { metrics }),
  };
}

function evaluateRequired(
  assertion: RequiredAssertion,
  candidate: BenchmarkCandidate,
): AssertionEvaluation {
  if (assertion.type === "outcome_equals") {
    return assertionResult(
      assertion, "required", candidate.outcome === assertion.value, assertion.value, candidate.outcome,
    );
  }
  if (assertion.type === "error_code_equals") {
    return assertionResult(
      assertion,
      "required",
      candidate.errorCode === assertion.value,
      assertion.value,
      candidate.errorCode ?? null,
    );
  }
  const artifact = candidate.artifact;
  if (candidate.outcome !== "ok" || artifact === undefined) {
    return assertionResult(assertion, "required", false, assertion.value, candidate.outcome);
  }
  switch (assertion.type) {
    case "title_equals":
      return assertionResult(assertion, "required",
        normalizedText(artifact.title) === normalizedText(assertion.value),
        assertion.value, artifact.title);
    case "final_url_equals":
      return assertionResult(assertion, "required",
        new URL(artifact.finalUrl).toString() === new URL(assertion.value).toString(),
        assertion.value, artifact.finalUrl);
    case "contains_text":
      return assertionResult(assertion, "required",
        normalizedText(artifact.content).includes(normalizedText(assertion.value)),
        assertion.value, artifact.content);
    case "min_content_characters": {
      const characters = Array.from(normalizedText(artifact.content)).length;
      return assertionResult(assertion, "required", characters >= assertion.value,
        assertion.value, characters);
    }
    case "http_status_equals":
      return assertionResult(assertion, "required",
        artifact.evidence.httpStatus === assertion.value,
        assertion.value, artifact.evidence.httpStatus);
    case "content_type_starts_with":
      return assertionResult(assertion, "required",
        artifact.evidence.contentType.toLowerCase().startsWith(assertion.value.toLowerCase()),
        assertion.value, artifact.evidence.contentType);
    case "fetch_method_equals":
      return assertionResult(assertion, "required", artifact.fetchMethod === assertion.value,
        assertion.value, artifact.fetchMethod);
    case "word_f1_at_least": {
      const metrics = wordOverlap(artifact.content, assertion.reference);
      return assertionResult(assertion, "required", metrics.f1 >= assertion.value,
        assertion.value, metrics.f1, metrics);
    }
  }
}

function evaluateForbidden(
  assertion: ForbiddenAssertion,
  candidate: BenchmarkCandidate,
): AssertionEvaluation {
  const found = normalizedText(candidate.artifact?.content ?? "")
    .includes(normalizedText(assertion.value));
  return assertionResult(assertion, "forbidden", !found, assertion.value,
    found ? assertion.value : null);
}

export function evaluateBenchmarkCase(
  rawCase: BenchmarkCase,
  candidate: BenchmarkCandidate,
  options: { now?: Date } = {},
): BenchmarkEvaluation {
  const benchmarkCase = parseBenchmarkCase(rawCase);
  const now = options.now ?? new Date();
  if (benchmarkCase.expiresAt !== null && now.getTime() >= Date.parse(benchmarkCase.expiresAt)) {
    return {
      caseId: benchmarkCase.id, outcome: "harness_error", passed: false,
      falseSuccess: false, reason: "case_expired", assertions: [],
    };
  }
  const parsedCandidate = benchmarkCandidateSchema.safeParse(candidate);
  if (!parsedCandidate.success) {
    return {
      caseId: benchmarkCase.id, outcome: "harness_error", passed: false,
      falseSuccess: false, reason: "malformed_candidate", assertions: [],
    };
  }
  const validCandidate: BenchmarkCandidate = parsedCandidate.data;
  const assertions = [
    ...benchmarkCase.truth.required.map((assertion) => evaluateRequired(assertion, validCandidate)),
    ...benchmarkCase.truth.forbidden.map((assertion) => evaluateForbidden(assertion, validCandidate)),
  ];
  const passed = assertions.every((assertion) => assertion.passed);
  return {
    caseId: benchmarkCase.id,
    outcome: passed ? "valid" : "invalid",
    passed,
    falseSuccess: !passed && validCandidate.outcome === "ok",
    reason: passed ? "all_assertions_passed" : "assertion_failed",
    assertions,
  };
}
