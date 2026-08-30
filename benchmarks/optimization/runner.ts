import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { RawPage } from "../../src/types.js";
import {
  buildControlledFaultBenchmark,
  controlledFaultEnvironment,
  createControlledFaultSite,
  type ControlledFaultBenchmark,
  type ControlledFaultScenario,
} from "../controlled-site/faults.js";
import type { BenchmarkCase } from "../harness/contract.js";
import {
  executeReaderBenchmarkCase,
  type BenchmarkCorpusReport,
} from "../harness/corpus.js";
import { executionCostForBenchmarkRun } from "../harness/metrics.js";
import { runReadinessTournament } from "../readiness/tournament.js";
import {
  analyzeRetryCounterfactual,
  createPolicyCandidate,
  runExtractorTournament,
  summarizeHttpBrowserShadow,
  type HttpBrowserShadowPair,
} from "./loop.js";

const shadowScenarios = ["static-article", "navigation-noise", "js-shell-browser"] as const;
const shadowRepeats = 5;
const environmentKeys = [
  "DIAOYAN_ALLOW_DNS_FAKE_IP",
  "DIAOYAN_CRAWL_MAX_RETRY_DELAY_MS",
  "DIAOYAN_CRAWL_MIN_HOST_INTERVAL_MS",
  "DIAOYAN_CRAWL_RETRY_BASE_MS",
  "DIAOYAN_DATA_DIR",
  "DIAOYAN_MAX_REDIRECTS",
  "DIAOYAN_MAX_RESPONSE_BYTES",
  "DIAOYAN_PROXY_URLS",
  "DIAOYAN_REQUEST_TIMEOUT_MS",
] as const;

function evidenceDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function restoreExperimentEnvironment(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function experimentCase(
  fixture: ControlledFaultBenchmark,
  browserAllowed: boolean,
): BenchmarkCase {
  return {
    ...fixture.benchmarkCase,
    policy: {
      ...fixture.benchmarkCase.policy,
      browserAllowed,
      maxDurationMs: browserAllowed
        ? Math.max(10_000, fixture.benchmarkCase.policy.maxDurationMs)
        : fixture.benchmarkCase.policy.maxDurationMs,
      maxBrowserMs: browserAllowed ? Math.max(8_000, fixture.benchmarkCase.policy.maxBrowserMs) : 0,
    },
    truth: {
      ...fixture.benchmarkCase.truth,
      required: fixture.benchmarkCase.truth.required.filter(
        ({ type }) => type !== "fetch_method_equals",
      ),
    },
  };
}

async function executeIsolated(
  site: Awaited<ReturnType<typeof createControlledFaultSite>>,
  fixture: ControlledFaultBenchmark,
  scenario: ControlledFaultScenario,
  browserShadow: boolean,
) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "diaoyan-optimization-shadow-"));
  const snapshot = new Map<string, string | undefined>(
    environmentKeys.map((key) => [key, process.env[key]]),
  );
  try {
    site.reset();
    site.select(scenario);
    Object.assign(process.env, controlledFaultEnvironment(site, dataDirectory, fixture));
    const benchmarkCase = experimentCase(fixture, browserShadow);
    const execution = await executeReaderBenchmarkCase(
      benchmarkCase,
      browserShadow ? { browserReadiness: { target: { selector: "main" } } } : {},
    );
    return {
      candidate: execution.candidate,
      evaluation: execution.evaluation,
      cost: executionCostForBenchmarkRun(execution.candidate, execution.durationMs),
    };
  } finally {
    restoreExperimentEnvironment(snapshot);
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

async function runControlledShadow(): Promise<ReturnType<typeof summarizeHttpBrowserShadow>> {
  const site = await createControlledFaultSite();
  const pairs: HttpBrowserShadowPair[] = [];
  try {
    for (const scenario of shadowScenarios) {
      const fixture = buildControlledFaultBenchmark(site, scenario);
      for (let repeat = 1; repeat <= shadowRepeats; repeat += 1) {
        const primary = await executeIsolated(site, fixture, scenario, false);
        const shadow = await executeIsolated(site, fixture, scenario, true);
        pairs.push({ category: fixture.benchmarkCase.category, primary, shadow });
      }
    }
    return summarizeHttpBrowserShadow(pairs);
  } finally {
    await site.close();
  }
}

async function loadNightlyReport(root: string): Promise<BenchmarkCorpusReport> {
  const path = resolve(root, "benchmarks/reports/nightly-latest.json");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new Error("optimization loop requires a completed nightly benchmark report", { cause });
  }
  if (
    typeof value !== "object" || value === null ||
    (value as { protocolVersion?: unknown }).protocolVersion !== 1 ||
    !Array.isArray((value as { runs?: unknown }).runs)
  ) throw new Error("nightly benchmark report is malformed");
  return value as BenchmarkCorpusReport;
}

function extractorRaw(): { ref: string; page: RawPage } {
  const body = `<html><head><title>Optimization raw</title></head><body><main><h1>OPTIMIZATION TRUTH</h1><p>${
    "Independent extractor evidence. ".repeat(40)
  }</p></main><div>OPTIMIZATION NAVIGATION NOISE</div></body></html>`;
  return {
    ref: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    page: {
      body,
      bodyBytes: new Uint8Array(Buffer.from(body)),
      fetchedAt: "2026-08-30T00:00:00.000Z",
      method: "http",
      httpStatus: 200,
      contentType: "text/html; charset=utf-8",
      responseBytes: Buffer.byteLength(body),
      finalUrl: "https://controlled.invalid/optimization-raw",
    },
  };
}

export async function runOptimizationLoop(rootDirectory = resolve(".")) {
  const root = resolve(rootDirectory);
  const nightly = await loadNightlyReport(root);
  const shadow = await runControlledShadow();
  const readiness = await runReadinessTournament(5);
  const retry = analyzeRetryCounterfactual(nightly.runs);
  const raw = extractorRaw();
  const extractor = await runExtractorTournament(raw.ref, raw.page, {
    requiredText: ["OPTIMIZATION TRUTH", "Independent extractor evidence"],
    forbiddenText: ["OPTIMIZATION NAVIGATION NOISE"],
    minContentCharacters: 500,
  });
  const evidenceHashes = [shadow, readiness.summaries, retry, extractor].map(evidenceDigest);
  const policyCandidate = createPolicyCandidate({
    parentPolicyId: null,
    plannerVersion: "access-planner-v1",
    evidenceHashes,
    decisions: {
      browserEscalation: "after-invalid",
      readiness: "target-first-adaptive-fallback",
      retry: "stage-bounded",
      extractor: "registry-order",
    },
    generatedAt: new Date().toISOString(),
  });
  const report = {
    protocolVersion: 1 as const,
    benchmark: "optimization-loop",
    generatedAt: new Date().toISOString(),
    sourceBenchmark: {
      caseSetVersion: nightly.caseSetVersion,
      caseSetHash: nightly.caseSetHash,
      repeats: nightly.repeats,
    },
    shadow,
    readiness: {
      repeats: readiness.repeats,
      timeoutMs: readiness.timeoutMs,
      summaries: readiness.summaries,
      caseSummaries: readiness.caseSummaries,
    },
    retry,
    extractor,
    evidenceHashes,
    policyCandidate,
  };
  const reportsDirectory = resolve(root, "benchmarks/reports");
  await mkdir(reportsDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      resolve(reportsDirectory, "optimization-latest.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      resolve(reportsDirectory, "policy-candidate-latest.json"),
      `${JSON.stringify(policyCandidate, null, 2)}\n`,
      "utf8",
    ),
  ]);
  return report;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  void runOptimizationLoop().then((report) => {
    process.stdout.write(`${JSON.stringify({
      benchmark: report.benchmark,
      sourceBenchmark: report.sourceBenchmark,
      shadow: report.shadow,
      readiness: report.readiness.summaries,
      retry: report.retry,
      extractor: report.extractor.candidates,
      policyCandidate: report.policyCandidate,
    }, null, 2)}\n`);
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
