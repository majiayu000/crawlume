import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadBenchmarkCaseSet,
  runBenchmarkCorpus,
  type BenchmarkCaseExecutor,
} from "../benchmarks/harness/corpus.js";
import type {
  BenchmarkCase,
  BenchmarkCandidate,
  BenchmarkEvaluation,
} from "../benchmarks/harness/contract.js";

const temporaryDirectories: string[] = [];

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

    const loaded = await loadBenchmarkCaseSet(directory);

    expect(loaded.cases.map((value) => value.id)).toEqual(["case-a", "case-b"]);
    expect(loaded.caseSetHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("rejects empty and duplicate case sets", async () => {
    const empty = await mkdtemp(join(tmpdir(), "diaoyan-corpus-empty-"));
    const duplicate = await mkdtemp(join(tmpdir(), "diaoyan-corpus-duplicate-"));
    temporaryDirectories.push(empty, duplicate);
    await writeFile(join(duplicate, "a.json"), JSON.stringify(benchmarkCase("same-case")));
    await writeFile(join(duplicate, "b.json"), JSON.stringify(benchmarkCase("same-case")));

    await expect(loadBenchmarkCaseSet(empty)).rejects.toThrow("at least one JSON case");
    await expect(loadBenchmarkCaseSet(duplicate)).rejects.toThrow("duplicate benchmark case id");
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
      { cases, caseSetHash: `sha256:${"a".repeat(64)}` },
      execute,
      () => new Date("2026-08-29T01:00:00.000Z"),
    );

    expect(report).toMatchObject({
      protocolVersion: 1,
      generatedAt: "2026-08-29T01:00:00.000Z",
      caseSetHash: `sha256:${"a".repeat(64)}`,
      runs: [
        { benchmarkCase: { id: "case-a" }, cost: { totalDurationMilliseconds: 100 } },
        { benchmarkCase: { id: "case-b" }, cost: { totalDurationMilliseconds: 200 } },
      ],
      summary: {
        totalRuns: 2,
        eligibleRuns: 2,
        quality: { validArtifacts: 2, validResultRate: 1 },
        totalCost: { httpProviderAttempts: 2, documentBytesIn: 200 },
      },
    });
  });
});
