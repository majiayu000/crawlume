import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  compareBenchmarkReports,
  loadBenchmarkCaseSet,
  runBenchmarkCorpus,
  type BenchmarkCaseExecutor,
  type BenchmarkEnvironmentFingerprint,
} from "../benchmarks/harness/corpus.js";
import { benchmarkGateInputFromReports } from "../benchmarks/harness/gates.js";
import type {
  BenchmarkCase,
  BenchmarkCandidate,
  BenchmarkEvaluation,
} from "../benchmarks/harness/contract.js";

const temporaryDirectories: string[] = [];

const fingerprint: BenchmarkEnvironmentFingerprint = {
  gitSha: "0123456789abcdef0123456789abcdef01234567",
  nodeVersion: "v25.9.0",
  chromeVersion: "Google Chrome 152.0.0.0",
  platform: "darwin 25.0.0",
  architecture: "arm64",
  configurationHash: `sha256:${"c".repeat(64)}`,
};

function benchmarkCase(id: string): BenchmarkCase {
  return {
    schemaVersion: 2,
    id,
    layer: "fixture",
    category: "article",
    input: {
      url: `https://example.com/${id}`,
      intent: "read",
      freshnessSeconds: 0,
    },
    policy: {
      browserAllowed: false,
      authProfile: null,
      maxAttempts: 1,
      maxDurationMs: 1_000,
      maxDocumentBytes: 1_000,
      maxBrowserMs: 0,
    },
    truth: { required: [{ type: "contains_text", value: id }], forbidden: [] },
    reviewedAt: "2026-08-29T00:00:00.000Z",
    expiresAt: null,
  };
}

function candidate(value: BenchmarkCase): BenchmarkCandidate {
  const usage = {
    documentBytesIn: 100,
    networkBytesOut: 0,
    browserMilliseconds: 0,
    browserContextStarts: 0,
    retryDelayMilliseconds: 0,
    optionalModelTokens: 0,
  };
  return {
    outcome: "ok",
    provenance: {
      schemaVersion: 1,
      requestId: `request-${value.id}`,
      plan: {
        planId: `plan_${"a".repeat(64)}`,
        plannerVersion: "access-planner-v1",
        plannedStages: [{ stageId: "http-read", provider: "http", reasonCode: "HTTP_PRIMARY" }],
      },
      executedStages: ["http-read"],
      attempts: [{
        sequence: 1,
        stageId: "http-read",
        provider: "http",
        providerVersion: "reader-http-v1",
        outcome: "succeeded",
        errorCode: null,
        usage,
        startedAt: "2026-08-29T00:00:00.000Z",
        completedAt: "2026-08-29T00:00:00.020Z",
      }],
      projection: {
        attempts: 1,
        lastSequence: 1,
        lastOutcome: "succeeded",
        lastStageId: "http-read",
        usage,
        terminal: null,
      },
    },
    artifact: {
      sourceUrl: value.input.url,
      finalUrl: value.input.url,
      title: value.id,
      content: value.id,
      contentHash: `sha256-${value.id}`,
      fetchedAt: "2026-08-29T00:00:00.000Z",
      fetchMethod: "http",
      cached: false,
      discoveredUrls: [],
      evidence: {
        httpStatus: 200,
        contentType: "text/html",
        responseBytes: 100,
        attempts: 1,
        retryAttempts: 0,
        totalRetryDelayMs: 0,
        fetchAttempts: { http: 1, browser: 0 },
        responseBytesByMethod: { http: 100, browser: 0 },
        fetchDurationMsByMethod: { http: 20, browser: 0 },
      },
    },
  };
}

function evaluation(value: BenchmarkCase): BenchmarkEvaluation {
  return {
    caseId: value.id,
    outcome: "valid",
    passed: true,
    falseSuccess: false,
    reason: "all_assertions_passed",
    assertions: [],
  };
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

describe("benchmark corpus coordinator", () => {
  it("loads JSON cases in stable id order and fingerprints the set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diaoyan-corpus-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "b.json"), JSON.stringify(benchmarkCase("case-b")));
    await writeFile(join(directory, "a.json"), JSON.stringify(benchmarkCase("case-a")));
    await writeFile(join(directory, "README.md"), "ignored");

    const loaded = await loadBenchmarkCaseSet(directory, "fixture-v1");

    expect(loaded.cases.map((value) => value.id)).toEqual(["case-a", "case-b"]);
    expect(loaded.caseSetHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(loaded.caseSetVersion).toBe("fixture-v1");
  });

  it("rejects empty and duplicate case sets", async () => {
    const empty = await mkdtemp(join(tmpdir(), "diaoyan-corpus-empty-"));
    const duplicate = await mkdtemp(join(tmpdir(), "diaoyan-corpus-duplicate-"));
    temporaryDirectories.push(empty, duplicate);
    await writeFile(join(duplicate, "a.json"), JSON.stringify(benchmarkCase("same-case")));
    await writeFile(join(duplicate, "b.json"), JSON.stringify(benchmarkCase("same-case")));

    await expect(loadBenchmarkCaseSet(empty, "empty-v1")).rejects.toThrow("at least one JSON case");
    await expect(loadBenchmarkCaseSet(duplicate, "duplicate-v1")).rejects.toThrow(
      "duplicate benchmark case id",
    );
  });

  it("runs every case once and returns raw records plus the aggregate summary", async () => {
    const cases = [benchmarkCase("case-a"), benchmarkCase("case-b")];
    const execute: BenchmarkCaseExecutor = async (value) => ({
      candidate: candidate(value),
      evaluation: evaluation(value),
      durationMs: value.id === "case-a" ? 100 : 200,
      failureDetails: {},
    });

    const report = await runBenchmarkCorpus(
      { cases, caseSetHash: `sha256:${"a".repeat(64)}`, caseSetVersion: "fixture-v1" },
      execute,
      {
        repeats: 2,
        now: () => new Date("2026-08-29T01:00:00.000Z"),
        fingerprint,
      },
    );

    expect(report).toMatchObject({
      protocolVersion: 1,
      generatedAt: "2026-08-29T01:00:00.000Z",
      caseSetVersion: "fixture-v1",
      caseSetHash: `sha256:${"a".repeat(64)}`,
      repeats: 2,
      environment: fingerprint,
      runs: [
        { benchmarkCase: { id: "case-a" }, repeat: 1, cost: { totalDurationMilliseconds: 100 } },
        { benchmarkCase: { id: "case-a" }, repeat: 2, cost: { totalDurationMilliseconds: 100 } },
        { benchmarkCase: { id: "case-b" }, repeat: 1, cost: { totalDurationMilliseconds: 200 } },
        { benchmarkCase: { id: "case-b" }, repeat: 2, cost: { totalDurationMilliseconds: 200 } },
      ],
      summary: {
        totalRuns: 4,
        eligibleRuns: 4,
        quality: { validArtifacts: 4, validResultRate: 1 },
        totalCost: { httpProviderAttempts: 4, documentBytesIn: 400 },
      },
    });

    expect(benchmarkGateInputFromReports([report], null)).toMatchObject({
      layers: {
        controlled: { distinctCases: 0, minRepeats: 0 },
        live: { distinctCases: 0, minRepeats: 0 },
        private: { distinctCases: 0, minRepeats: 0 },
      },
      truthPassRate: 1,
      provenanceCompleteness: 1,
      budgetViolations: 0,
      pairedBaseline: false,
    });

    const overBudget = {
      ...report,
      runs: report.runs.map((run) => ({
        ...run,
        benchmarkCase: {
          ...run.benchmarkCase,
          policy: { ...run.benchmarkCase.policy, maxDocumentBytes: 50 },
        },
      })),
    };
    expect(benchmarkGateInputFromReports([overBudget], null).budgetViolations).toBe(4);
  });

  it("turns an expired live case into harness_error before invoking the executor", async () => {
    const expired = {
      ...benchmarkCase("expired-live"),
      layer: "live" as const,
      expiresAt: "2026-08-30T00:00:00.000Z",
    };
    const execute: BenchmarkCaseExecutor = async () => {
      throw new Error("expired canary must not execute");
    };

    const report = await runBenchmarkCorpus(
      {
        cases: [expired],
        caseSetHash: `sha256:${"d".repeat(64)}`,
        caseSetVersion: "live-v1",
      },
      execute,
      {
        repeats: 5,
        now: () => new Date("2026-08-30T00:00:00.000Z"),
        fingerprint,
      },
    );

    expect(report.runs).toHaveLength(5);
    expect(report.runs.every((run) =>
      run.evaluation.outcome === "harness_error" && run.evaluation.reason === "case_expired"
    )).toBe(true);
    expect(report.summary.outcomes.harnessError).toBe(5);
  });

  it("compares only identical paired case sets and reports deterministic latency confidence", async () => {
    const cases = [benchmarkCase("case-a"), benchmarkCase("case-b")];
    const run = (durationOffset: number, gitSha: string) => runBenchmarkCorpus(
      {
        cases,
        caseSetHash: `sha256:${"e".repeat(64)}`,
        caseSetVersion: "release-v1",
      },
      async (value) => ({
        candidate: candidate(value),
        evaluation: evaluation(value),
        durationMs: (value.id === "case-a" ? 100 : 200) + durationOffset,
        failureDetails: {},
      }),
      {
        repeats: 2,
        now: () => new Date("2026-08-29T01:00:00.000Z"),
        fingerprint: { ...fingerprint, gitSha },
      },
    );
    const baseline = await run(0, "1111111111111111111111111111111111111111");
    const changed = await run(10, "2222222222222222222222222222222222222222");

    expect(compareBenchmarkReports(baseline, changed)).toMatchObject({
      caseSetVersion: "release-v1",
      caseSetHash: `sha256:${"e".repeat(64)}`,
      pairedRuns: 4,
      baselineGitSha: "1111111111111111111111111111111111111111",
      candidateGitSha: "2222222222222222222222222222222222222222",
      validRateDelta: 0,
      latencyDeltaMs: {
        median: 10,
        p95: 10,
        max: 10,
        bootstrapMeanCi95: [10, 10],
      },
    });

    expect(() => compareBenchmarkReports(
      baseline,
      { ...changed, caseSetHash: `sha256:${"f".repeat(64)}` },
    )).toThrow("same case set");
  });
});
