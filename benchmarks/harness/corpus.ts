import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { chromium } from "playwright-core";

import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { normalizeError, type ReadErrorCode } from "../../src/errors.js";
import type { BrowserReadinessPolicy } from "../../src/types.js";

import {
  parseBenchmarkCase,
  candidateFromPageArtifact,
  executionProvenanceFromLedger,
  evaluateBenchmarkCase,
  type BenchmarkCandidate,
  type BenchmarkCase,
  type BenchmarkEvaluation,
  type CandidateOutcome,
} from "./contract.js";
import {
  aggregateBenchmarkRuns,
  emptyBenchmarkCost,
  executionCostForBenchmarkRun,
  type BenchmarkAggregateSummary,
  type BenchmarkRunRecord,
} from "./metrics.js";

export type BenchmarkCaseSet = {
  cases: BenchmarkCase[];
  caseSetVersion: string;
  caseSetHash: string;
};

export type BenchmarkEnvironmentFingerprint = {
  gitSha: string;
  nodeVersion: string;
  chromeVersion: string;
  platform: string;
  architecture: string;
  configurationHash: string;
};

export type BenchmarkCorpusRun = BenchmarkRunRecord & { repeat: number };

export type BenchmarkCaseExecution = {
  candidate: BenchmarkCandidate;
  evaluation: BenchmarkEvaluation;
  durationMs: number;
  failureDetails: Record<string, boolean | number | string | null>;
};

export type BenchmarkCaseExecutor = (
  benchmarkCase: BenchmarkCase,
) => Promise<BenchmarkCaseExecution>;

export type BenchmarkCorpusReport = {
  protocolVersion: 1;
  generatedAt: string;
  caseSetVersion: string;
  caseSetHash: string;
  repeats: number;
  environment: BenchmarkEnvironmentFingerprint;
  runs: BenchmarkCorpusRun[];
  summary: BenchmarkAggregateSummary;
};

export type BenchmarkCorpusOptions = {
  repeats: number;
  fingerprint: BenchmarkEnvironmentFingerprint;
  now?: () => Date;
};

export type BenchmarkReleaseComparison = {
  protocolVersion: 1;
  caseSetVersion: string;
  caseSetHash: string;
  baselineGitSha: string;
  candidateGitSha: string;
  pairedRuns: number;
  validRateDelta: number;
  costPerValidDelta: number;
  latencyDeltaMs: {
    median: number;
    p95: number;
    max: number;
    bootstrapMeanCi95: [number, number];
  };
  outcomeChanges: Record<string, number>;
};

const policyStopCodes = new Set<ReadErrorCode>([
  "ROBOTS_DISALLOWED",
  "RSL_PROHIBITED",
  "RSL_LICENSE_REQUIRED",
  "RSL_PAYMENT_REQUIRED",
  "RSL_CONFIRMATION_REQUIRED",
  "AUTH_REQUIRED",
  "PAYMENT_REQUIRED",
  "ACCESS_DENIED",
  "LOGIN_WALL_DETECTED",
  "HUMAN_VERIFICATION_REQUIRED",
]);

const execFileAsync = promisify(execFile);

export async function collectBenchmarkEnvironmentFingerprint(): Promise<
  BenchmarkEnvironmentFingerprint
> {
  const config = loadConfig();
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: resolve("."),
  });
  const gitSha = stdout.trim();
  const browser = await chromium.launch({
    headless: true,
    ...(config.browserExecutable === null
      ? { channel: config.browserChannel }
      : { executablePath: config.browserExecutable }),
  });
  let chromeVersion: string;
  try {
    chromeVersion = browser.version();
  } finally {
    await browser.close();
  }
  const configuration = {
    requestTimeoutMs: config.requestTimeoutMs,
    browserTimeoutMs: config.browserTimeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    maxRedirects: config.maxRedirects,
    robotsCacheSeconds: config.robotsCacheSeconds,
    defaultCacheSeconds: config.defaultCacheSeconds,
    crawlMaxAttempts: config.crawlMaxAttempts,
    crawlRetryBaseMs: config.crawlRetryBaseMs,
    crawlMaxRetryDelayMs: config.crawlMaxRetryDelayMs,
    crawlMinHostIntervalMs: config.crawlMinHostIntervalMs,
    crawlWorkerConcurrency: config.crawlWorkerConcurrency,
    crawlLeaseMs: config.crawlLeaseMs,
    browserPoolSize: config.browserPoolSize,
    browserContextsPerInstance: config.browserContextsPerInstance,
    browserPoolWaitMs: config.browserPoolWaitMs,
    browserChannel: config.browserChannel,
    allowDnsFakeIp: config.allowDnsFakeIp,
    localIndexEnabled: config.localIndexEnabled,
    proxyCount: config.proxyEndpoints.length,
    rslUsage: config.rslUsage,
    rslUserClass: config.rslUserClass,
    rslGeo: config.rslGeo,
  };
  return {
    gitSha,
    nodeVersion: process.version,
    chromeVersion,
    platform: `${platform()} ${release()}`,
    architecture: arch(),
    configurationHash: `sha256:${createHash("sha256")
      .update(JSON.stringify(configuration))
      .digest("hex")}`,
  };
}

export function benchmarkOutcomeForErrorCode(
  errorCode: ReadErrorCode,
  httpStatus?: number,
): CandidateOutcome {
  if (
    errorCode === "ACCESS_DENIED" &&
    httpStatus !== undefined &&
    httpStatus !== 401 && httpStatus !== 402 && httpStatus !== 403
  ) return "failed";
  if (policyStopCodes.has(errorCode)) return "policy_stop";
  if (errorCode === "UNSUPPORTED_CONTENT_TYPE") return "unsupported";
  return "failed";
}

function hashCases(cases: BenchmarkCase[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(cases)).digest("hex")}`;
}

export function createBenchmarkCaseSet(
  rawCases: BenchmarkCase[],
  caseSetVersion: string,
): BenchmarkCaseSet {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(caseSetVersion)) {
    throw new Error("caseSetVersion must be a stable lowercase version identifier");
  }
  if (rawCases.length === 0) throw new Error("benchmark corpus requires at least one case");
  const cases = [...rawCases].sort((left, right) => left.id.localeCompare(right.id));
  const seen = new Set<string>();
  for (const benchmarkCase of cases) {
    parseBenchmarkCase(benchmarkCase);
    if (seen.has(benchmarkCase.id)) {
      throw new Error(`duplicate benchmark case id: ${benchmarkCase.id}`);
    }
    seen.add(benchmarkCase.id);
  }
  return { cases, caseSetVersion, caseSetHash: hashCases(cases) };
}

export async function loadBenchmarkCaseSet(
  directory: string,
  caseSetVersion: string,
): Promise<BenchmarkCaseSet> {
  const entries = (await readdir(resolve(directory), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0) {
    throw new Error("benchmark corpus requires at least one JSON case");
  }
  const cases = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    return readBenchmarkCase(path, entry.name);
  }));
  return createBenchmarkCaseSet(cases, caseSetVersion);
}

export async function readBenchmarkCase(
  path: string,
  displayName = path,
): Promise<BenchmarkCase> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (cause) {
    throw new Error(`failed to parse benchmark case ${displayName}`, { cause });
  }
  return parseBenchmarkCase(raw);
}

function validateFingerprint(value: BenchmarkEnvironmentFingerprint): void {
  if (!/^[a-f0-9]{40}$/u.test(value.gitSha)) throw new Error("fingerprint gitSha must be 40 hex characters");
  if (!/^sha256:[a-f0-9]{64}$/u.test(value.configurationHash)) {
    throw new Error("fingerprint configurationHash must be a sha256 digest");
  }
  for (const field of [
    "nodeVersion", "chromeVersion", "platform", "architecture",
  ] as const) {
    if (value[field].trim().length === 0) throw new Error(`fingerprint ${field} must be non-empty`);
  }
}

function quantile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] as number;
}

function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (const character of seed) {
    state ^= character.codePointAt(0) ?? 0;
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function bootstrapMeanCi95(values: number[], seed: string): [number, number] {
  const random = seededRandom(seed);
  const samples: number[] = [];
  for (let iteration = 0; iteration < 2_000; iteration += 1) {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) {
      sum += values[Math.floor(random() * values.length)] as number;
    }
    samples.push(sum / values.length);
  }
  return [quantile(samples, 0.025), quantile(samples, 0.975)];
}

function runKey(run: BenchmarkCorpusRun): string {
  return `${run.benchmarkCase.id}#${run.repeat}`;
}

export function compareBenchmarkReports(
  baseline: BenchmarkCorpusReport,
  candidate: BenchmarkCorpusReport,
): BenchmarkReleaseComparison {
  if (
    baseline.caseSetVersion !== candidate.caseSetVersion ||
    baseline.caseSetHash !== candidate.caseSetHash ||
    baseline.repeats !== candidate.repeats
  ) {
    throw new Error("release comparison requires the same case set version, hash, and repeats");
  }
  const baselineRuns = new Map(baseline.runs.map((run) => [runKey(run), run]));
  const candidateRuns = new Map(candidate.runs.map((run) => [runKey(run), run]));
  if (
    baselineRuns.size !== baseline.runs.length || candidateRuns.size !== candidate.runs.length ||
    baselineRuns.size !== candidateRuns.size ||
    [...baselineRuns.keys()].some((key) => !candidateRuns.has(key))
  ) {
    throw new Error("release comparison requires the same paired run keys");
  }
  const latencyDeltas: number[] = [];
  const outcomeChanges: Record<string, number> = {};
  for (const [key, baselineRun] of baselineRuns) {
    const candidateRun = candidateRuns.get(key) as BenchmarkCorpusRun;
    latencyDeltas.push(
      candidateRun.cost.totalDurationMilliseconds - baselineRun.cost.totalDurationMilliseconds,
    );
    const change = `${baselineRun.evaluation.outcome}->${candidateRun.evaluation.outcome}`;
    outcomeChanges[change] = (outcomeChanges[change] ?? 0) + 1;
  }
  const baselineValidRate = baseline.summary.quality.validResultRate;
  const candidateValidRate = candidate.summary.quality.validResultRate;
  const baselineCost = baseline.summary.costPerValidArtifact?.totalDurationMilliseconds;
  const candidateCost = candidate.summary.costPerValidArtifact?.totalDurationMilliseconds;
  if (
    baselineValidRate === null || candidateValidRate === null ||
    baselineCost === undefined || candidateCost === undefined || baselineCost === 0
  ) {
    throw new Error("release comparison requires eligible valid artifacts in both reports");
  }
  return {
    protocolVersion: 1,
    caseSetVersion: baseline.caseSetVersion,
    caseSetHash: baseline.caseSetHash,
    baselineGitSha: baseline.environment.gitSha,
    candidateGitSha: candidate.environment.gitSha,
    pairedRuns: latencyDeltas.length,
    validRateDelta: candidateValidRate - baselineValidRate,
    costPerValidDelta: candidateCost / baselineCost - 1,
    latencyDeltaMs: {
      median: quantile(latencyDeltas, 0.5),
      p95: quantile(latencyDeltas, 0.95),
      max: Math.max(...latencyDeltas),
      bootstrapMeanCi95: bootstrapMeanCi95(latencyDeltas, baseline.caseSetHash),
    },
    outcomeChanges,
  };
}

export async function runBenchmarkCorpus(
  caseSet: BenchmarkCaseSet,
  execute: BenchmarkCaseExecutor,
  options: BenchmarkCorpusOptions,
): Promise<BenchmarkCorpusReport> {
  if (caseSet.cases.length === 0) {
    throw new Error("benchmark corpus requires at least one case");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(caseSet.caseSetHash)) {
    throw new Error("caseSetHash must be a sha256 digest");
  }
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(caseSet.caseSetVersion)) {
    throw new Error("caseSetVersion must be a stable lowercase version identifier");
  }
  if (!Number.isSafeInteger(options.repeats) || options.repeats < 1) {
    throw new Error("benchmark repeats must be a positive integer");
  }
  validateFingerprint(options.fingerprint);
  const now = options.now ?? (() => new Date());
  const generatedAt = now();
  const runs: BenchmarkCorpusRun[] = [];
  for (const benchmarkCase of caseSet.cases) {
    for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
      if (
        benchmarkCase.expiresAt !== null &&
        generatedAt.getTime() >= Date.parse(benchmarkCase.expiresAt)
      ) {
        runs.push({
          benchmarkCase,
          repeat,
          candidate: null,
          evaluation: {
            caseId: benchmarkCase.id,
            outcome: "harness_error",
            passed: false,
            falseSuccess: false,
            reason: "case_expired",
            assertions: [],
          },
          cost: emptyBenchmarkCost(),
        });
        continue;
      }
      const execution = await execute(benchmarkCase);
      runs.push({
        benchmarkCase,
        repeat,
        candidate: execution.candidate,
        evaluation: execution.evaluation,
        cost: executionCostForBenchmarkRun(execution.candidate, execution.durationMs),
      });
    }
  }
  return {
    protocolVersion: 1,
    generatedAt: generatedAt.toISOString(),
    caseSetVersion: caseSet.caseSetVersion,
    caseSetHash: caseSet.caseSetHash,
    repeats: options.repeats,
    environment: options.fingerprint,
    runs,
    summary: aggregateBenchmarkRuns(runs),
  };
}

export async function executeReaderBenchmarkCase(
  benchmarkCase: BenchmarkCase,
  options: { browserReadiness?: BrowserReadinessPolicy } = {},
): Promise<BenchmarkCaseExecution> {
  const baseConfig = loadConfig();
  const config = {
    ...baseConfig,
    requestTimeoutMs: Math.min(baseConfig.requestTimeoutMs, benchmarkCase.policy.maxDurationMs),
    browserTimeoutMs: benchmarkCase.policy.browserAllowed
      ? Math.min(baseConfig.browserTimeoutMs, benchmarkCase.policy.maxBrowserMs)
      : baseConfig.browserTimeoutMs,
    crawlMaxAttempts: benchmarkCase.policy.maxAttempts,
  };
  const app = createApp(config, { runCrawlWorker: false, runMonitorWorker: false });
  const controller = new AbortController();
  const requestId = randomUUID();
  const timeout = setTimeout(() => controller.abort(), benchmarkCase.policy.maxDurationMs);
  const startedAt = performance.now();
  let candidate: BenchmarkCandidate;
  let failureDetails: BenchmarkCaseExecution["failureDetails"] = {};
  try {
    const artifact = await app.reader.readPageArtifact({
      url: benchmarkCase.input.url,
      requestId,
      browserAllowed: benchmarkCase.policy.browserAllowed,
      ...(options.browserReadiness === undefined
        ? {}
        : { browserReadiness: options.browserReadiness }),
      cacheMode: "live",
      maxAgeSeconds: Math.max(1, benchmarkCase.input.freshnessSeconds),
      ...(benchmarkCase.policy.authProfile === null
        ? {}
        : { authProfile: benchmarkCase.policy.authProfile }),
      budget: {
        deadlineMs: benchmarkCase.policy.maxDurationMs,
        maxAttempts: benchmarkCase.policy.maxAttempts,
        maxDocumentBytes: benchmarkCase.policy.maxDocumentBytes,
        maxBrowserMs: benchmarkCase.policy.maxBrowserMs,
        maxBrowserContexts: benchmarkCase.policy.browserAllowed ? 1 : 0,
        maxOptionalModelTokens: 0,
      },
      signal: controller.signal,
    });
    candidate = candidateFromPageArtifact(
      artifact,
      app.attemptLedger.list(requestId),
      app.attemptLedger.project(requestId),
    );
  } catch (error) {
    const normalized = normalizeError(error);
    if (normalized.execution === null) {
      throw new Error("benchmark failure is missing execution-plan provenance", { cause: normalized });
    }
    const httpStatus = typeof normalized.details.httpStatus === "number"
      ? normalized.details.httpStatus
      : undefined;
    candidate = {
      outcome: benchmarkOutcomeForErrorCode(normalized.code, httpStatus),
      errorCode: normalized.code,
      provenance: executionProvenanceFromLedger(
        requestId,
        normalized.execution,
        app.attemptLedger.list(requestId),
        app.attemptLedger.project(requestId),
      ),
    };
    failureDetails = normalized.details;
  } finally {
    clearTimeout(timeout);
    await app.close();
  }
  return {
    candidate,
    evaluation: evaluateBenchmarkCase(benchmarkCase, candidate),
    durationMs: performance.now() - startedAt,
    failureDetails,
  };
}

export async function runReaderBenchmarkCaseFile(path: string): Promise<{
  protocolVersion: 1;
  generatedAt: string;
  durationMs: number;
  benchmarkCase: BenchmarkCase;
  candidate: BenchmarkCandidate;
  evaluation: BenchmarkEvaluation;
  cost: ReturnType<typeof executionCostForBenchmarkRun>;
}> {
  const benchmarkCase = await readBenchmarkCase(path);
  const execution = await executeReaderBenchmarkCase(benchmarkCase);
  return {
    protocolVersion: 1,
    generatedAt: new Date().toISOString(),
    durationMs: execution.durationMs,
    benchmarkCase,
    candidate: execution.candidate,
    evaluation: execution.evaluation,
    cost: executionCostForBenchmarkRun(
      execution.candidate,
      execution.durationMs,
    ),
  };
}
