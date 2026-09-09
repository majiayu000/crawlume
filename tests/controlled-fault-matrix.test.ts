import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildControlledFaultBenchmark,
  buildControlledFaultMatrix,
  controlledFaultScenarios,
  controlledFaultEnvironment,
  createControlledFaultSite,
  type ControlledFaultScenario,
  type ControlledFaultSite,
} from "../benchmarks/controlled-site/faults.js";
import { executeReaderBenchmarkCase } from "../benchmarks/harness/corpus.js";
import type { BenchmarkCandidate } from "../benchmarks/harness/contract.js";

const environmentKeys = [
  "CRAWLUME_ALLOW_DNS_FAKE_IP",
  "CRAWLUME_CRAWL_MAX_RETRY_DELAY_MS",
  "CRAWLUME_CRAWL_MIN_HOST_INTERVAL_MS",
  "CRAWLUME_CRAWL_RETRY_BASE_MS",
  "CRAWLUME_DATA_DIR",
  "CRAWLUME_MAX_REDIRECTS",
  "CRAWLUME_MAX_RESPONSE_BYTES",
  "CRAWLUME_PROXY_URLS",
  "CRAWLUME_REQUEST_TIMEOUT_MS",
] as const;

type EnvironmentKey = (typeof environmentKeys)[number];

let site: ControlledFaultSite;
let dataDirectory: string;
let originalEnvironment: Record<EnvironmentKey, string | undefined>;

function expectCompleteProvenance(candidate: BenchmarkCandidate): void {
  const { provenance } = candidate;
  expect(provenance.requestId).not.toHaveLength(0);
  expect(provenance.plan.planId).toMatch(/^plan_[a-f0-9]{64}$/u);
  expect(provenance.executedStages.length).toBeGreaterThan(0);
  expect(provenance.attempts.map(({ sequence }) => sequence)).toEqual(
    provenance.attempts.map((_, index) => index + 1),
  );
  const plannedProviders = new Map(
    provenance.plan.plannedStages.map(({ stageId, provider }) => [stageId, provider]),
  );
  expect(provenance.attempts.every(
    ({ stageId, provider }) => plannedProviders.get(stageId) === provider,
  )).toBe(true);
  const usage = provenance.attempts.reduce(
    (total, attempt) => ({
      documentBytesIn: total.documentBytesIn + attempt.usage.documentBytesIn,
      networkBytesOut: total.networkBytesOut + attempt.usage.networkBytesOut,
      browserMilliseconds: total.browserMilliseconds + attempt.usage.browserMilliseconds,
      browserContextStarts: total.browserContextStarts + attempt.usage.browserContextStarts,
      retryDelayMilliseconds:
        total.retryDelayMilliseconds + attempt.usage.retryDelayMilliseconds,
      optionalModelTokens: total.optionalModelTokens + attempt.usage.optionalModelTokens,
    }),
    {
      documentBytesIn: 0,
      networkBytesOut: 0,
      browserMilliseconds: 0,
      browserContextStarts: 0,
      retryDelayMilliseconds: 0,
      optionalModelTokens: 0,
    },
  );
  expect(provenance.projection).toMatchObject({
    attempts: provenance.attempts.length,
    lastSequence: provenance.attempts.at(-1)?.sequence,
    usage,
  });
}

async function execute(scenario: ControlledFaultScenario) {
  site.reset();
  site.select(scenario);
  const fixture = buildControlledFaultBenchmark(site, scenario);
  for (const [name, value] of Object.entries(
    controlledFaultEnvironment(site, dataDirectory, fixture),
  )) {
    process.env[name] = value;
  }
  const execution = await executeReaderBenchmarkCase(fixture.benchmarkCase);
  expectCompleteProvenance(execution.candidate);
  return { execution, fixture, stats: site.stats() };
}

beforeAll(async () => {
  originalEnvironment = Object.fromEntries(
    environmentKeys.map((key) => [key, process.env[key]]),
  ) as Record<EnvironmentKey, string | undefined>;
  dataDirectory = await mkdtemp(join(tmpdir(), "crawlume-controlled-faults-"));
  site = await createControlledFaultSite();
});

afterAll(async () => {
  await site.close();
  await rm(dataDirectory, { recursive: true, force: true });
  for (const key of environmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe.sequential("controlled Reader fault matrix", () => {
  it("builds a unique controlled-layer corpus entry for every fault scenario", () => {
    const matrix = buildControlledFaultMatrix(site);

    expect(matrix.length).toBeGreaterThanOrEqual(40);
    expect(matrix).toHaveLength(controlledFaultScenarios.length);
    expect(new Set(matrix.map(({ benchmarkCase }) => benchmarkCase.id)).size)
      .toBe(controlledFaultScenarios.length);
    expect(matrix.every(({ benchmarkCase }) => benchmarkCase.layer === "controlled")).toBe(true);
  });

  it.each(controlledFaultScenarios.slice(7))(
    "executes %s through the production Reader contract",
    async (scenario) => {
      const { execution } = await execute(scenario);

      expect(execution.evaluation).toMatchObject({
        outcome: "valid",
        passed: true,
        falseSuccess: false,
      });
    },
    15_000,
  );

  it.each([
    ["slow-header", "FETCH_TIMEOUT"],
    ["slow-body", "FETCH_TIMEOUT"],
    ["chunked-overflow", "BUDGET_EXHAUSTED"],
  ] as const)("fails visibly for %s without a false success", async (scenario, errorCode) => {
    const { execution, stats } = await execute(scenario);

    expect(execution.candidate).toMatchObject({
      outcome: "failed",
      errorCode,
    });
    expect(execution.evaluation).toMatchObject({
      outcome: "valid",
      passed: true,
      falseSuccess: false,
    });
    expect(execution.candidate.provenance.attempts).toHaveLength(1);
    expect(execution.candidate.provenance.projection.attempts).toBe(1);
    expect(stats.scenarioRequests[scenario]).toBe(1);
  });

  it("follows a bounded redirect chain and records one provider attempt", async () => {
    const { execution, fixture, stats } = await execute("redirect-chain");

    expect(execution.candidate.outcome).toBe("ok");
    expect(execution.candidate.artifact).toMatchObject({
      finalUrl: fixture.expectedFinalUrl,
      fetchMethod: "http",
    });
    expect(execution.evaluation).toMatchObject({ passed: true, falseSuccess: false });
    expect(execution.candidate.provenance.attempts).toHaveLength(1);
    expect(stats.scenarioRequests["redirect-chain"]).toBe(4);
  });

  it("honors Retry-After when the delay fits within the request deadline", async () => {
    const { execution, stats } = await execute("retry-after-within-deadline");

    expect(execution.candidate.outcome).toBe("ok");
    expect(execution.evaluation).toMatchObject({ passed: true, falseSuccess: false });
    expect(execution.candidate.provenance.attempts).toHaveLength(2);
    expect(execution.candidate.provenance.projection.usage.retryDelayMilliseconds).toBe(1_000);
    expect(stats.scenarioRequests["retry-after-within-deadline"]).toBe(2);
  });

  it("does not sleep or retry when Retry-After exceeds the request deadline", async () => {
    const startedAt = performance.now();
    const { execution, stats } = await execute("retry-after-outside-deadline");

    expect(execution.candidate).toMatchObject({
      outcome: "failed",
      errorCode: "BUDGET_EXHAUSTED",
    });
    expect(execution.evaluation).toMatchObject({
      outcome: "valid",
      passed: true,
      falseSuccess: false,
    });
    expect(execution.candidate.provenance.attempts).toHaveLength(1);
    expect(execution.candidate.provenance.projection.usage.retryDelayMilliseconds).toBe(0);
    expect(stats.scenarioRequests["retry-after-outside-deadline"]).toBe(1);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("measures persistent HTTP 500 retries as waste without a false success", async () => {
    const { execution, stats } = await execute("persistent-500");

    expect(execution.candidate).toMatchObject({
      outcome: "failed",
      errorCode: "UPSTREAM_ERROR",
    });
    expect(execution.evaluation).toMatchObject({
      outcome: "valid",
      passed: true,
      falseSuccess: false,
    });
    expect(execution.candidate.provenance.attempts).toHaveLength(3);
    expect(execution.candidate.provenance.attempts.every(
      ({ errorCode }) => errorCode === "UPSTREAM_ERROR",
    )).toBe(true);
    expect(stats.scenarioRequests["persistent-500"]).toBe(3);
  });
});
