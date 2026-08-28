import { afterEach, describe, expect, it } from "vitest";

import {
  parseRunnerStdout,
  validateRunnerResult,
  type RunnerResult,
} from "../benchmarks/harness/contract.js";
import {
  createControlledSite,
  runCrawleeGraph,
  runUndiciGraph,
  type ControlledSite,
} from "../benchmarks/controlled-site/server.js";
import {
  parseDarwinTimeMetrics,
  summarizeRuns,
  type MeasuredRun,
} from "../benchmarks/harness/summary.js";

let site: ControlledSite | null = null;

afterEach(async () => {
  await site?.close();
  site = null;
});

function validResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    protocolVersion: 1,
    runner: "node-undici",
    language: "TypeScript",
    runtime: "Node.js",
    engine: "Undici",
    seedUrl: "http://127.0.0.1:3000/page/0",
    expectedPages: 10,
    concurrency: 4,
    visitedPages: 10,
    validPages: 10,
    failedPages: 0,
    duplicateFetches: 0,
    bytesReceived: 8_192,
    crawlDurationMs: 25,
    ...overrides,
  };
}

describe("benchmark runner contract", () => {
  it("accepts a complete and internally consistent result", () => {
    expect(validateRunnerResult(validResult())).toEqual(validResult());
  });

  it("rejects a result that claims more valid pages than visited pages", () => {
    expect(() => validateRunnerResult(validResult({ validPages: 11 }))).toThrow(
      "validPages cannot exceed visitedPages",
    );
  });

  it("requires runners to emit exactly one JSON object on stdout", () => {
    expect(parseRunnerStdout(`${JSON.stringify(validResult())}\n`)).toEqual(validResult());
    expect(() => parseRunnerStdout(`log line\n${JSON.stringify(validResult())}\n`)).toThrow(
      "exactly one non-empty JSON line",
    );
  });
});

describe("controlled benchmark site", () => {
  it("serves a deterministic crawl graph and exposes request statistics", async () => {
    site = await createControlledSite({ pages: 6, bodyBytes: 1_024 });

    const page = await fetch(`${site.origin}/page/0`);
    const body = await page.text();

    expect(page.status).toBe(200);
    expect(page.headers.get("x-benchmark-page")).toBe("0");
    expect(body).toContain('data-benchmark-id="page-0"');
    expect(body).toContain('href="/page/1"');
    expect(body).toContain('href="/page/2"');
    expect(body).toContain('href="/page/3"');
    expect(body).toContain('href="/page/4"');
    expect(body).not.toContain('href="/page/5"');

    const stats = await fetch(`${site.origin}/__stats`).then(async (response) => response.json());
    expect(stats).toMatchObject({ totalRequests: 1, pageRequests: 1 });
  });

  it("returns a stable terminal page without out-of-range links", async () => {
    site = await createControlledSite({ pages: 2, bodyBytes: 512 });

    const body = await fetch(`${site.origin}/page/1`).then(async (response) => response.text());

    expect(body).toContain('data-benchmark-id="page-1"');
    expect(body).not.toContain('href="/page/2"');
  });

  it("rejects malformed controlled-site options", async () => {
    await expect(createControlledSite({ pages: 0, bodyBytes: 1_024 })).rejects.toThrow(
      "pages must be a positive integer",
    );
    await expect(createControlledSite({ pages: 5, bodyBytes: 0 })).rejects.toThrow(
      "bodyBytes must be a positive integer",
    );
  });

  it.each([
    ["node-undici", runUndiciGraph],
    ["node-crawlee", runCrawleeGraph],
  ])("crawls the complete graph with the %s runner", async (_name, runner) => {
    site = await createControlledSite({ pages: 20, bodyBytes: 1_024 });

    const result = await runner({
      seedUrl: `${site.origin}/page/0`,
      expectedPages: 20,
      concurrency: 4,
    });

    expect(result).toMatchObject({
      expectedPages: 20,
      visitedPages: 20,
      validPages: 20,
      failedPages: 0,
      duplicateFetches: 0,
    });
  });
});

describe("benchmark aggregation", () => {
  it("parses wall, CPU and resident memory from Darwin time output", () => {
    expect(parseDarwinTimeMetrics(`
        0.42 real         0.31 user         0.08 sys
             4567890  maximum resident set size
    `)).toEqual({
      wallDurationMs: 420,
      userCpuSeconds: 0.31,
      systemCpuSeconds: 0.08,
      maxRssBytes: 4_567_890,
    });
  });

  it("rejects incomplete Darwin time output", () => {
    expect(() => parseDarwinTimeMetrics("0.42 real")).toThrow("Darwin time output");
  });

  it("reports medians and validity without averaging away failures", () => {
    const runs: MeasuredRun[] = [
      { result: validResult({ crawlDurationMs: 30 }), wallDurationMs: 40, maxRssBytes: 30_000 },
      { result: validResult({ crawlDurationMs: 10 }), wallDurationMs: 20, maxRssBytes: 10_000 },
      { result: validResult({ crawlDurationMs: 20 }), wallDurationMs: 30, maxRssBytes: 20_000 },
    ];

    expect(summarizeRuns(runs)).toMatchObject({
      runner: "node-undici",
      rounds: 3,
      allRunsComplete: true,
      medianCrawlDurationMs: 20,
      medianWallDurationMs: 30,
      medianMaxRssBytes: 20_000,
      medianPagesPerSecond: 500,
    });
  });

  it("marks the summary incomplete when any measured run misses a page", () => {
    const incomplete = validResult({ visitedPages: 9, validPages: 9, expectedPages: 10 });
    expect(summarizeRuns([
      { result: validResult(), wallDurationMs: 30, maxRssBytes: 10_000 },
      { result: incomplete, wallDurationMs: 30, maxRssBytes: 10_000 },
    ]).allRunsComplete).toBe(false);
  });
});
