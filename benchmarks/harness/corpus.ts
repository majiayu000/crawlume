import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { normalizeError, type ReadErrorCode } from "../../src/errors.js";

import {
  parseBenchmarkCase,
  candidateFromPageArtifact,
  evaluateBenchmarkCase,
  type BenchmarkCandidate,
  type BenchmarkCase,
  type BenchmarkEvaluation,
  type CandidateOutcome,
} from "./contract.js";
import {
  aggregateBenchmarkRuns,
  executionCostForBenchmarkRun,
  type BenchmarkAggregateSummary,
  type BenchmarkRunRecord,
} from "./metrics.js";

export type BenchmarkCaseSet = {
  cases: BenchmarkCase[];
  caseSetHash: string;
};

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
  caseSetHash: string;
  runs: BenchmarkRunRecord[];
  summary: BenchmarkAggregateSummary;
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

export async function loadBenchmarkCaseSet(directory: string): Promise<BenchmarkCaseSet> {
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
  cases.sort((left, right) => left.id.localeCompare(right.id));
  const seen = new Set<string>();
  for (const benchmarkCase of cases) {
    if (seen.has(benchmarkCase.id)) {
      throw new Error(`duplicate benchmark case id: ${benchmarkCase.id}`);
    }
    seen.add(benchmarkCase.id);
  }
  return { cases, caseSetHash: hashCases(cases) };
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

export async function runBenchmarkCorpus(
  caseSet: BenchmarkCaseSet,
  execute: BenchmarkCaseExecutor,
  now: () => Date = () => new Date(),
): Promise<BenchmarkCorpusReport> {
  if (caseSet.cases.length === 0) {
    throw new Error("benchmark corpus requires at least one case");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(caseSet.caseSetHash)) {
    throw new Error("caseSetHash must be a sha256 digest");
  }
  const runs: BenchmarkRunRecord[] = [];
  for (const benchmarkCase of caseSet.cases) {
    const execution = await execute(benchmarkCase);
    runs.push({
      benchmarkCase,
      candidate: execution.candidate,
      evaluation: execution.evaluation,
      cost: executionCostForBenchmarkRun(
        execution.candidate,
        execution.durationMs,
        execution.failureDetails,
      ),
    });
  }
  return {
    protocolVersion: 1,
    generatedAt: now().toISOString(),
    caseSetHash: caseSet.caseSetHash,
    runs,
    summary: aggregateBenchmarkRuns(runs),
  };
}

export async function executeReaderBenchmarkCase(
  benchmarkCase: BenchmarkCase,
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
  const timeout = setTimeout(() => controller.abort(), benchmarkCase.policy.maxDurationMs);
  const startedAt = performance.now();
  let candidate: BenchmarkCandidate;
  let failureDetails: BenchmarkCaseExecution["failureDetails"] = {};
  try {
    const artifact = await app.reader.readPageArtifact({
      url: benchmarkCase.input.url,
      mode: benchmarkCase.policy.browserAllowed ? benchmarkCase.input.mode : "http",
      cacheMode: "live",
      signal: controller.signal,
    });
    candidate = candidateFromPageArtifact(artifact);
  } catch (error) {
    const normalized = normalizeError(error);
    const httpStatus = typeof normalized.details.httpStatus === "number"
      ? normalized.details.httpStatus
      : undefined;
    candidate = {
      outcome: benchmarkOutcomeForErrorCode(normalized.code, httpStatus),
      errorCode: normalized.code,
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
      execution.failureDetails,
    ),
  };
}
